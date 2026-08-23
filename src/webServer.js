import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import * as cfg from '../config/index.js'
import * as auth from './auth.js'
import * as llm from './llm.js'
import * as imageGen from './imageGen.js'
import * as helper from './helper.js'
import { isAllowedOutboundUrl } from './security.js'
import { safeLogger } from './globals.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.join(__dirname, '..')
const WEB_DIR = path.join(PLUGIN_ROOT, 'web')

let serverInstance = null
let currentPort = null
let currentHost = null

export function isRunning() {
  return !!serverInstance
}

// 枚举本机非回环 IPv4 地址（供 0.0.0.0 绑定时推荐局域网访问地址）
function listLanIpv4() {
  try {
    const ifaces = os.networkInterfaces()
    const out = []
    for (const name of Object.keys(ifaces || {})) {
      for (const addr of ifaces[name] || []) {
        if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
      }
    }
    return Array.from(new Set(out)).filter(Boolean)
  } catch (_) {
    return []
  }
}

export function getServerInfo() {
  const bindHost = currentHost
  const port = currentPort
  const running = isRunning()
  const url = bindHost && port
    ? `http://${bindHost === '0.0.0.0' ? '127.0.0.1' : (bindHost === '::' ? '[::1]' : bindHost)}:${port}`
    : null

  const publicUrls = []
  if (running && port) {
    if (bindHost === '0.0.0.0' || bindHost === '::' || !bindHost) {
      // 真实监听在 all 接口 → 同时给出 127.0.0.1 和局域网候选
      publicUrls.push(`http://127.0.0.1:${port}`)
      for (const ip of listLanIpv4()) publicUrls.push(`http://${ip}:${port}`)
    } else if (bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost') {
      publicUrls.push(`http://${bindHost === '::1' ? '[::1]' : bindHost}:${port}`)
    } else {
      publicUrls.push(`http://${bindHost}:${port}`)
    }
  }

  return {
    running,
    host: bindHost,
    port,
    url,
    publicUrls
  }
}

function listSessions(limit = 100) {
  const historyDir = path.join(PLUGIN_ROOT, 'data', 'history')
  const out = []
  if (!fs.existsSync(historyDir)) return out
  let count = 0
  for (const user of fs.readdirSync(historyDir)) {
    if (count >= limit) break
    const ud = path.join(historyDir, user)
    const st = fs.statSync(ud)
    if (!st.isDirectory()) continue
    const files = fs.readdirSync(ud).filter(f => f.endsWith('.json'))
    const sessions = []
    for (const f of files) {
      const fp = path.join(ud, f)
      const s = fs.statSync(fp)
      let msgCount = 0
      let preview = ''
      try {
        const arr = JSON.parse(fs.readFileSync(fp, 'utf-8'))
        msgCount = Array.isArray(arr) ? arr.length : 0
        const last = Array.isArray(arr) ? arr[arr.length - 1] : null
        if (last) preview = (last.content || '').slice(0, 60)
      } catch {}
      sessions.push({
        id: f.replace(/\.json$/, ''),
        size: s.size,
        mtime: s.mtimeMs,
        msgCount,
        preview
      })
    }
    sessions.sort((a, b) => b.mtime - a.mtime)
    out.push({
      userId: user,
      sessions,
      totalMessages: sessions.reduce((a, s) => a + s.msgCount, 0)
    })
    count++
  }
  out.sort((a, b) => b.totalMessages - a.totalMessages)
  return out
}

// 会话接口路径参数校验：防止路径遍历（../）读取/删除插件目录外的任意文件。
// userId 为 QQ 号（纯数字），sessionId 为 randomUUID（十六进制 + 连字符）。
function isValidUserId(v) {
  return v != null && /^\d{1,20}$/.test(String(v))
}
function isValidSessionId(v) {
  // 标准 UUID 格式：8-4-4-4-12（共 36 字符），减小攻击面
  return v != null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))
}

function requireAuth(req, res, next) {
  const token = req.cookies?.ai0_session || req.headers['x-ai0-session']
  if (!auth.verifySession(token, req.clientIp)) {
    return res.status(401).json({ ok: false, msg: '未登录或登录已过期' })
  }
  next()
}

function safeCompare(a, b) {
  const x = Buffer.from(String(a || ''), 'utf-8')
  const y = Buffer.from(String(b || ''), 'utf-8')
  // P3-2: 长度不匹配时，不能提前 return——直接返回会泄露"长度不同"的时序信号。
  // 策略：把较短的 Buffer 用 zero-fill 对齐到较长 Buffer 的长度，再做一次
  // timingSafeEqual，再把 length 不匹配的情况强制 return false。攻击者无法通过
  // 耗时分辨"长度不符 → false" 与"长度相符但内容不符 → false"。
  const maxLen = Math.max(x.length, y.length, 1)
  const xp = Buffer.alloc(maxLen, 0)
  const yp = Buffer.alloc(maxLen, 0)
  x.copy(xp)
  y.copy(yp)
  const contentEq = crypto.timingSafeEqual(xp, yp)
  return x.length === y.length && contentEq
}

function requireCsrf(req, res, next) {
  const sessionToken = req.cookies?.ai0_session || req.headers['x-ai0-session']
  const csrfCookie = req.cookies?.ai0_csrf
  const csrfHeader = req.headers['x-csrf-token']
  if (!csrfCookie || !csrfHeader || !safeCompare(csrfCookie, csrfHeader)) {
    return res.status(403).json({ ok: false, msg: 'CSRF 校验失败' })
  }
  const storedCsrf = auth.getSessionCsrf(sessionToken)
  if (!storedCsrf || !safeCompare(storedCsrf, csrfCookie)) {
    return res.status(403).json({ ok: false, msg: 'CSRF token 无效' })
  }
  next()
}

/**
 * web.host 白名单 + trustProxy 校验（纯函数，便于单测）
 * @param {string} host 用户传入的 host 值
 * @param {boolean} trustProxy 当前已配置的 web.trustProxy
 * @returns {{ ok: boolean, msg?: string }}
 */
export function validateWebHost(host, trustProxy) {
  const ALLOWED_HOST = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'])
  const h = typeof host === 'string' ? host.trim() : String(host)
  // RFC1918 私有段 + loopback 通配
  // 避免使用已废弃的 RegExp.$1..$N（有竞态风险，非线程安全语义），改用 exec() 返回数组直接解构
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  const isPrivateIpv4 = !!ipv4Match && (() => {
    const a = Number(ipv4Match[1])
    const b = Number(ipv4Match[2])
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 127
    )
  })()
  if (!ALLOWED_HOST.has(h) && !isPrivateIpv4) {
    return { ok: false, msg: 'web.host 仅允许 loopback / 私有地址 / 0.0.0.0；如需对外暴露请改 config.yaml 并配置 HTTPS' }
  }
  // — P0 补强：通配 0.0.0.0/:: 对外暴露前，强制要求已配置 trustProxy —
  // 否则 Magic Link IP 绑定会从 X-Forwarded-For 取值，
  // 攻击者可伪造 XFF 绕过 IP 绑定 / 触发 IP 劫持 DoS
  const isWildcard = h === '0.0.0.0' || h === '::'
  if (isWildcard && !trustProxy) {
    return { ok: false, msg: '将 host 设为 0.0.0.0/:: 对外暴露前，请先在 config.yaml 中设置 web.trustProxy: true（需配合反向代理使用），否则 Magic Link IP 绑定失效，存在安全风险。' }
  }
  return { ok: true }
}

export function createApp() {
  const app = express()
  app.use(cookieParser())
  app.use(express.json({ limit: '2mb' }))
  app.use(express.urlencoded({ extended: true, limit: '1mb' }))

  // —— 安全响应头（统一合并，防御 XSS、Clickjacking、MIME 嗅探等）
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-XSS-Protection', '0')
    res.removeHeader('X-Powered-By')
    // Permissions-Policy: 禁用不必要的浏览器 API，减少攻击面
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=()')
    // HSTS: 仅在 HTTPS 时启用，强制浏览器使用 HTTPS
    if (req.secure || (cfg.get('web.trustProxy', false) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    // 基础 CSP：限制资源来源，脚本仅允许外部文件（移除 unsafe-inline 防止内联脚本注入）
    // frame-ancestors 'self'：防止点击劫持（CSP2 版，替代 X-Frame-Options，二者同时设置更稳健）
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'")
    next()
  })

  // —— 反向代理真实 IP 识别（给限速/IP绑定用）：兼容 Cloudflare / X-Forwarded-For / X-Real-IP
  // 安全要点：只有当请求来自"可信代理来源"时才信任 X-Forwarded-For 等头，否则攻击者
  // 绕过代理直连端口时可伪造 XFF 头绕过 IP 绑定/限速。可信来源 = 回环地址 + web.trustedProxies
  // 配置的代理网段（支持 CIDR / 单 IP）。默认只信任本机（127.0.0.1 / ::1），即反代部署在同一台机器。
  function getClientIp(req) {
    // P3-1: trustProxy 强制严格布尔。防止 YAML/前端传入字符串 "false"（truthy）
    //       导致直连时仍采信 XFF 头，绕过 IP 限速 / 绑定。
    const trustProxy = cfg.get('web.trustProxy', false) === true
    const socketIp = req.socket?.remoteAddress || req.ip || 'unknown'
    const canTrustXff = trustProxy && isTrustedProxy(socketIp)
    let ip = socketIp
    if (canTrustXff) {
      const pickFromHeaders = [
        'cf-connecting-ip',       // Cloudflare (单值)
        'x-real-ip',              // Nginx (单值)
        'x-client-ip',
        'forwarded-for',
        'x-cluster-client-ip',
        'x-forwarded-for'         // 标准（多值，从右往左取第一个非可信代理）
      ]
      for (const h of pickFromHeaders) {
        const v = req.headers?.[h]
        if (typeof v === 'string' && v.trim()) {
          if (h === 'x-forwarded-for') {
            // XFF: 从右往左取第一个非可信代理 IP（最靠近客户端的真实 IP）
            const ips = v.split(',').map(s => s.trim()).filter(Boolean)
            for (let i = ips.length - 1; i >= 0; i--) {
              if (!isTrustedProxy(ips[i])) { ip = ips[i]; break }
            }
          } else {
            ip = v.trim()
          }
          if (ip) break
        }
      }
    }
    // 去 IPv6 包装，如 ::ffff:127.0.0.1 → 127.0.0.1
    if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7)
    return ip || 'unknown'
  }

  // 判断 socket 对端 IP 是否为可信代理（本机回环 或 配置的 trustedProxies 网段）
  function isTrustedProxy(socketIp) {
    if (!socketIp || socketIp === 'unknown') return false
    const raw = socketIp.startsWith('::ffff:') ? socketIp.slice(7) : socketIp
    const trusted = cfg.get('web.trustedProxies', [])
    const list = Array.isArray(trusted) ? trusted : [trusted]
    // 回环总是可信（反代与插件同机部署的常见情形）
    if (raw === '127.0.0.1' || raw === '::1') return true
    // 规范化 IP：net.isIP 能正确判断 IPv4/IPv6；strip IPv4-mapped IPv6 后再比较
    for (const entry of list) {
      if (!entry || typeof entry !== 'string') continue
      const e = entry.trim()
      if (!e) continue
      if (e.includes('/')) {
        const [base, prefixRaw] = e.split('/')
        const prefix = Number(prefixRaw)
        if (!base || !Number.isInteger(prefix) || prefix < 0) continue
        // IPv4 CIDR（prefix 0-32）/ IPv6 CIDR（prefix 0-128）均兼容，超界跳过
        const baseFamily = net.isIP(base)
        const rawFamily = net.isIP(raw)
        if (!baseFamily || !rawFamily) continue
        if (baseFamily === 4 && rawFamily === 4 && prefix >= 0 && prefix <= 32) {
          if (isIpv4InCidr(raw, base, prefix)) return true
        } else if (baseFamily === 6 && rawFamily === 6 && prefix >= 0 && prefix <= 128) {
          if (isIpv6InCidr(raw, base, prefix)) return true
        } else if (baseFamily === 4 && rawFamily === 4) {
          // prefix 范围异常（>32）直接跳过
        }
      } else {
        // 单 IP：IPv4-mapped 同值等价（::ffff:10.0.0.1 ≡ 10.0.0.1）
        const cmp = e.startsWith('::ffff:') ? e.slice(7) : e
        if (cmp === raw) return true
      }
    }
    return false
  }

  function isIpv4InCidr(ip, base, prefix) {
    const toInt = (s) => {
      const p = s.split('.').map(Number)
      if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
      return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
    }
    const ipInt = toInt(ip)
    const baseInt = toInt(base)
    if (ipInt === null || baseInt === null) return false
    if (prefix === 0) return true
    if (prefix >= 32) return ipInt === baseInt
    const mask = (0xffffffff << (32 - prefix)) >>> 0
    return (ipInt & mask) === (baseInt & mask)
  }

  function isIpv6InCidr(ip, base, prefix) {
    // Node.js 没有 BigInt << 128 内建运算，手写 16 字节数组按位与。
    // ipv4-mapped IPv6 永远不会走到这里（外层已按 family 分流）。
    const toBytes = (s) => {
      try {
        const norm = net.isIPv6(s) ? s : null
        if (!norm) return null
        // 用 URL 的 hostname 解析太复杂，直接走 net 规范化 + 手动补零
        // 更稳妥：通过 Buffer.from 解析十六进制表示
        const expanded = expandIpv6(s)
        if (!expanded) return null
        const bytes = new Uint8Array(16)
        for (let i = 0; i < 8; i++) {
          const h = expanded[i]
          bytes[i * 2] = (h >> 8) & 0xff
          bytes[i * 2 + 1] = h & 0xff
        }
        return bytes
      } catch (_) { return null }
    }
    const a = toBytes(ip)
    const b = toBytes(base)
    if (!a || !b) return false
    if (prefix === 0) return true
    let remaining = prefix
    for (let i = 0; i < 16; i++) {
      const bits = Math.min(8, remaining)
      const mask = (0xff << (8 - bits)) & 0xff
      if ((a[i] & mask) !== (b[i] & mask)) return false
      remaining -= bits
      if (remaining <= 0) break
    }
    return true
  }
  // 将 IPv6 缩写展开为 8 个 16-bit 整数数组；失败返回 null
  function expandIpv6(s) {
    if (typeof s !== 'string') return null
    // %zone_id（如 fe80::1%eth0）：按 RFC 去掉 scope，不影响网段比较
    const str = s.includes('%') ? s.slice(0, s.indexOf('%')) : s
    const [head, tail] = str.split('::')
    const left = head ? head.split(':').filter(Boolean) : []
    const right = tail !== undefined ? tail.split(':').filter(Boolean) : []
    const missing = 8 - left.length - right.length
    if (missing < 0) return null
    const groups = [...left, ...Array(missing).fill('0'), ...right]
    if (groups.length !== 8) return null
    const out = new Array(8)
    for (let i = 0; i < 8; i++) {
      const g = groups[i]
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out[i] = parseInt(g, 16)
    }
    return out
  }
  // 每请求挂一个 req.clientIp
  app.use((req, res, next) => {
    req.clientIp = getClientIp(req)
    next()
  })

  // 首页 / 静态资源
  app.get('/', (req, res) => {
    const token = req.cookies?.ai0_session
    const file = auth.verifySession(token, req.clientIp)
      ? path.join(WEB_DIR, 'dashboard.html')
      : path.join(WEB_DIR, 'login.html')
    if (fs.existsSync(file)) return res.sendFile(file)
    res.status(500).send('页面文件缺失，请检查 web/ 目录')
  })

  app.use('/assets', express.static(path.join(WEB_DIR, 'assets'), { dotfiles: 'deny' }))

  app.get('/magic/:token', (req, res) => {
    const token = req.params.token
    const r = auth.verifyMagicLink(token, req.clientIp)
    if (!r.ok) {
      const f = path.join(WEB_DIR, 'login.html')
      if (fs.existsSync(f)) return res.sendFile(f)
      return res.send('链接无效或已过期')
    }
    // verifyMagicLink 已原子标记为已消费；若 session 发放失败则回滚
    let session
    try {
      session = auth.issueSession(req.clientIp)
    } catch (e) {
      auth.rollbackMagicLink(token)
      const f = path.join(WEB_DIR, 'login.html')
      if (fs.existsSync(f)) return res.sendFile(f)
      return res.send('登录失败，请重试')
    }
    auth.consumeMagicLink(token) // 清理记录
    const secure = req.secure || (cfg.get('web.trustProxy', false) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https')
    res.cookie('ai0_session', session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: !!secure,
      maxAge: auth.AUTH_CFG.tokenExpireMs
    })
    res.cookie('ai0_csrf', session.csrf, {
      httpOnly: false,
      sameSite: 'strict',
      secure: !!secure,
      maxAge: auth.AUTH_CFG.tokenExpireMs
    })
    return res.redirect('/')
  })

  // ==================== API ====================
  app.post('/api/login/code', (req, res) => {
    const { codeId, code } = req.body || {}
    if (!codeId) return res.json({ ok: false, msg: '请输入验证码 ID' })
    const r = auth.verifyCode(codeId, code, req.clientIp)
    if (!r.ok) return res.json(r)
    const session = auth.issueSession(req.clientIp)
    const secure = req.secure || (cfg.get('web.trustProxy', false) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https')
    res.cookie('ai0_session', session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: !!secure,
      maxAge: auth.AUTH_CFG.tokenExpireMs
    })
    res.cookie('ai0_csrf', session.csrf, {
      httpOnly: false,
      sameSite: 'strict',
      secure: !!secure,
      maxAge: auth.AUTH_CFG.tokenExpireMs
    })
    res.json({ ok: true })
  })

  app.post('/api/logout', requireCsrf, (req, res) => {
    const t = req.cookies?.ai0_session
    if (t) auth.destroySession(t)
    res.clearCookie('ai0_session')
    res.json({ ok: true })
  })

  app.get('/api/me', (req, res) => {
    const token = req.cookies?.ai0_session
    res.json({ ok: true, loggedIn: auth.verifySession(token, req.clientIp) })
  })

  // 诊断接口：未认证只返回最小化状态（避免向未登录访问者泄露 apiBase/模型名/主人数量/web绑定等配置细节）；
  // 认证后返回完整诊断信息。
  app.get('/api/diag', (req, res) => {
    try {
      const authed = auth.verifySession(req.cookies?.ai0_session || req.headers['x-ai0-session'], req.clientIp)
      const info = getServerInfo()
      if (!authed) {
        return res.json({
          ok: true,
          authed: false,
          server: {
            running: info.running
          }
        })
      }
      const sources = helper.listMasterSources()
      const allMasters = helper.listMasters()
      const cfgData = cfg.loadConfig()
      const def = cfgData.model?.default || '(未设置)'
      const mm = (cfgData.model && def && cfgData.model[def]) || {}
      const apiKeyMasked = !!(mm.apiKey && !/^\s*$/.test(mm.apiKey) && !/sk-your-api|^\*+$/.test(mm.apiKey))
      const bindFromCfg = (cfgData.web && typeof cfgData.web === 'object')
        ? { host: (cfgData.web.host == null ? null : String(cfgData.web.host)), port: cfgData.web.port == null ? null : Number(cfgData.web.port) }
        : null
      res.json({
        ok: true,
        authed: true,
        master: {
          frameworkCount: sources.framework.length,
          pluginCount: sources.plugin.length,
          totalMasters: allMasters.length,
          frameworkHasAny: sources.framework.length > 0,
          pluginHasAny: sources.plugin.length > 0
        },
        model: {
          defaultKey: def,
          apiBaseSet: !!mm.apiBase,
          apiKeySet: apiKeyMasked,
          modelName: mm.model || ''
        },
        web: info,
        config: {
          declared: bindFromCfg
        }
      })
    } catch (e) {
      res.json({ ok: false, msg: String(e && e.message || e) })
    }
  })

  // ---- 管理 ----
  const API_KEY_PLACEHOLDER = '********'
  app.get('/api/config', requireAuth, (req, res) => {
    const c = cfg.loadConfig()
    // 完全脱敏 apikey：不返回任何真实字符（连首尾都不暴露），有值统一用占位符替代。
    const safe = JSON.parse(JSON.stringify(c))
    if (safe.model) {
      for (const k of Object.keys(safe.model)) {
        if (safe.model[k] && typeof safe.model[k] === 'object' && safe.model[k].apiKey) {
          const key = safe.model[k].apiKey
          safe.model[k].apiKey = (key && !/^\s*$/.test(key) && !/^\*+$/.test(key)) ? API_KEY_PLACEHOLDER : key
        }
      }
    }
    res.json({ ok: true, config: safe })
  })

  app.post('/api/config', requireAuth, requireCsrf, async (req, res) => {
    const { config } = req.body || {}
    if (!config || typeof config !== 'object') {
      return res.json({ ok: false, msg: '配置格式错误' })
    }
    // 拒绝空数组（防止空数组损坏配置）
    if (Array.isArray(config)) {
      return res.json({ ok: false, msg: '配置格式错误：不接受数组' })
    }
    // — 发现E 修复：限制 JSON 嵌套深度，防止深度嵌套栈溢出 DoS —
    // 实际配置 4 层就够（model.openai.apiKey / groupOps.masters 等），上限设 8
    // 数组也计入深度（数组元素可能为对象，如 permissions.masters: [[{}], ...] 亦可嵌套）
    function getDepth(obj, cur = 1) {
      if (cur > 16) return cur  // 早停防恶意递归
      let max = cur
      if (obj && typeof obj === 'object') {
        const values = Array.isArray(obj) ? obj : Object.values(obj)
        for (const v of values) {
          if (v && typeof v === 'object') {
            const d = getDepth(v, cur + 1)
            if (d > max) max = d
          }
        }
      }
      return max
    }
    const depth = getDepth(config)
    if (depth > 8) {
      return res.json({ ok: false, msg: `配置嵌套深度 ${depth} 超过上限 8，拒绝处理` })
    }

    // — P0-2: 白名单校验顶层字段 —
    const ALLOWED_TOP_KEYS = new Set([
      'model', 'chat', 'groupOps', 'imageGen', 'system', 'permissions', 'response', 'web'
    ])
    const unknownKeys = Object.keys(config).filter(k => !ALLOWED_TOP_KEYS.has(k))
    if (unknownKeys.length) {
      return res.json({ ok: false, msg: `不允许的配置字段: ${unknownKeys.join(', ')}` })
    }

    // — P0-2: 禁止通过 API 修改 permissions.masters —
    // 前端保存时总是带 masters 键（即便为空数组），改为删除而非整体拒绝
    if (config.permissions?.masters) {
      delete config.permissions.masters
    }

    // — P0-2: 模型子键白名单 —
    if (config.model && typeof config.model === 'object') {
      const ALLOWED_MODEL_FIELDS = new Set([
        'name', 'apiBase', 'apiKey', 'model', 'temperature', 'maxTokens', 'timeout'
      ])
      for (const [key, val] of Object.entries(config.model)) {
        if (key === 'default') continue
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const bad = Object.keys(val).filter(k => !ALLOWED_MODEL_FIELDS.has(k))
          if (bad.length) {
            return res.json({ ok: false, msg: `模型 "${key}" 含有不允许的字段: ${bad.join(', ')}` })
          }
        }
      }
    }

    // A2: SSRF 校验 — 所有 model 子段的 apiBase 必须通过 isAllowedOutboundUrl
    //     与 /api/image-config 保持一致，防止通过 web 后台写入内网/回环 apiBase 导致 apiKey 泄漏
    if (config.model && typeof config.model === 'object') {
      for (const [key, val] of Object.entries(config.model)) {
        if (key === 'default' || !val || typeof val !== 'object') continue
        const apiBase = String(val.apiBase || '').trim()
        if (!apiBase) continue
        let normalized
        try {
          normalized = helper.normalizeApiBase(apiBase)
          const u = new URL(normalized + '/')
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('协议错误')
        } catch (_) {
          return res.json({ ok: false, msg: `模型 "${key}" 的 apiBase 格式错误：请填入合法的 http(s) URL` })
        }
        const chk = await isAllowedOutboundUrl(normalized).catch(() => null)
        if (!chk || !chk.ok) {
          return res.json({ ok: false, msg: `模型 "${key}" 的 apiBase 未通过安全校验：${chk?.reason || '禁止访问私有/回环/链路本地地址'}` })
        }
        val.apiBase = normalized
      }
    }

    // — P0-2: 数值字段范围校验 —
    const w = config.web
    if (w) {
      if (w.port != null && (typeof w.port !== 'number' || w.port < 1 || w.port > 65535)) {
        return res.json({ ok: false, msg: 'web.port 必须为 1-65535 之间的数字' })
      }
      // — P0(三轮严审) + P0 补强: web.host 白名单 + 通配时强制 trustProxy —
      if (w.host != null) {
        // P3-1: trustProxy 强制严格布尔 === true。防止 YAML/前端传入字符串 "false"（truthy）
        //       在 host=0.0.0.0 / :: 时被误判为"信任代理"，放行未配置 trustProxy 的部署。
        const trustProxy = cfg.get('web.trustProxy', false) === true
        const r = validateWebHost(w.host, trustProxy)
        if (!r.ok) return res.json(r)
      }
    }
    const chat = config.chat
    if (chat) {
      if (chat.contextSize != null && (typeof chat.contextSize !== 'number' || chat.contextSize < 0 || chat.contextSize > 100)) {
        return res.json({ ok: false, msg: 'chat.contextSize 必须为 0-100 之间的数字' })
      }
      if (chat.maxSessionsPerUser != null && (typeof chat.maxSessionsPerUser !== 'number' || chat.maxSessionsPerUser < 1 || chat.maxSessionsPerUser > 50)) {
        return res.json({ ok: false, msg: 'chat.maxSessionsPerUser 必须为 1-50 之间的数字' })
      }
    }
    const g = config.groupOps
    if (g) {
      if (g.defaultMuteDuration != null && (typeof g.defaultMuteDuration !== 'number' || g.defaultMuteDuration < 1 || g.defaultMuteDuration > 2592000)) {
        return res.json({ ok: false, msg: 'groupOps.defaultMuteDuration 必须为 1-2592000 秒' })
      }
    }
    const img = config.imageGen
    if (img) {
      if (img.timeout != null && (typeof img.timeout !== 'number' || img.timeout < 1000 || img.timeout > 600000)) {
        return res.json({ ok: false, msg: 'imageGen.timeout 必须为 1000-600000 毫秒' })
      }
    }

    // 把脱敏的 apiKey 还原：收到 **** 时，从原配置读取
    const old = cfg.loadConfig()
    const cleaned = JSON.parse(JSON.stringify(config))
    if (cleaned.model && old.model) {
      for (const k of Object.keys(cleaned.model)) {
        const newVal = cleaned.model[k]?.apiKey
        const oldVal = old.model[k]?.apiKey
        // 精确比对：仅当值完全匹配占位符时还原（防止误还原包含 **** 的真实 Key）
        if (typeof newVal === 'string' && newVal === API_KEY_PLACEHOLDER && typeof oldVal === 'string') {
          cleaned.model[k].apiKey = oldVal
        }
      }
    }

    // — P0-3: 环境变量覆盖的字段不写入配置文件 —
    const envKeys = cfg.getEnvOverriddenKeys()
    for (const dotKey of envKeys) {
      const parts = dotKey.split('.')
      let target = cleaned
      for (let i = 0; i < parts.length - 1; i++) {
        target = target?.[parts[i]]
      }
      if (target && typeof target === 'object') {
        delete target[parts[parts.length - 1]]
      }
    }

    const ok = cfg.saveConfig(cleaned)
    const skipped = envKeys.length ? `（已跳过 ${envKeys.length} 个环境变量覆盖字段）` : ''
    res.json({ ok, msg: ok ? `已保存${skipped}` : '保存失败，查看日志' })
  })

  app.get('/api/sessions', requireAuth, (req, res) => {
    res.json({ ok: true, data: listSessions() })
  })

  app.delete('/api/sessions/:userId/:sessionId?', requireAuth, requireCsrf, (req, res) => {
    const { userId, sessionId } = req.params
    if (!isValidUserId(userId)) {
      return res.status(400).json({ ok: false, msg: '非法 userId' })
    }
    if (sessionId != null && !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, msg: '非法 sessionId' })
    }
    try {
      const dir = path.join(PLUGIN_ROOT, 'data', 'history', userId)
      if (!fs.existsSync(dir)) return res.json({ ok: false, msg: '目录不存在' })
      if (sessionId) {
        const p = path.join(dir, `${sessionId}.json`)
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } else {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f))
        }
      }
      res.json({ ok: true })
    } catch (e) {
      safeLogger.error(`[ai0-plugin] 会话删除失败: ${e.message}`)
      res.json({ ok: false, msg: '操作失败，请稍后重试' })
    }
  })

  app.get('/api/sessions/:userId/:sessionId', requireAuth, (req, res) => {
    const { userId, sessionId } = req.params
    if (!isValidUserId(userId) || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, msg: '非法参数' })
    }
    const arr = llm.loadHistory(userId, sessionId)
    res.json({ ok: true, data: arr })
  })

  // ---- 多 API 平台：探测某 provider 的 /models ----
  app.post('/api/providers/probe', requireAuth, requireCsrf, async (req, res) => {
    const { modelKey = null } = req.body || {}
    if (modelKey && (typeof modelKey !== 'string' || modelKey.length > 128)) {
      return res.json({ ok: false, msg: 'modelKey 格式无效' })
    }
    try {
      const t0 = Date.now()
      const info = await llm.listAvailableModels({ modelKey })
      const latencyMs = Date.now() - t0
      res.json({ ok: true, info: { ...info, latencyMs } })
    } catch (e) {
      res.json({ ok: false, msg: e.message || String(e) })
    }
  })

  // ---- 多 API 平台：并发探测所有 provider 的 /models ----
  app.post('/api/providers/probe-all', requireAuth, requireCsrf, async (req, res) => {
    try {
      const c = cfg.loadConfig()
      const modelCfg = c.model || {}
      const keys = Object.keys(modelCfg).filter(k =>
        k !== 'default' && modelCfg[k] && typeof modelCfg[k] === 'object'
      )
      const results = await Promise.all(keys.map(async (key) => {
        const t0 = Date.now()
        try {
          const info = await llm.listAvailableModels({ modelKey: key })
          return {
            key,
            ok: !!info.ok,
            status: info.status,
            url: info.url,
            models: info.models || [],
            count: info.count || 0,
            latencyMs: Date.now() - t0,
            error: info.error || null
          }
        } catch (e) {
          safeLogger.error(`[ai0-plugin] 模型探测失败(${key}): ${e.message}`)
          return { key, ok: false, models: [], latencyMs: Date.now() - t0, error: '探测失败' }
        }
      }))
      res.json({ ok: true, results })
    } catch (e) {
      safeLogger.error(`[ai0-plugin] 批量探测失败: ${e.message}`)
      res.json({ ok: false, msg: '批量探测失败，请稍后重试' })
    }
  })

  app.post('/api/test-model', requireAuth, requireCsrf, async (req, res) => {
    let { message = '请用一句话介绍你自己', modelKey = null } = req.body || {}
    if (typeof message !== 'string') message = String(message)
    if (message.length > 10000) {
      return res.json({ ok: false, msg: '消息过长（最多 10000 字符）' })
    }
    try {
      // 先探测 /models 并返回归一化后的 url 用于 UI 诊断展示
      const probe = await llm.probeModelConnection({ modelKey })
      const msgs = [{ role: 'user', content: message }]
      let chatResult = null
      let chatErr = null
      try {
        chatResult = await llm.chatCompletions(msgs, { modelKey })
      } catch (e) {
        chatErr = e.message || String(e)
      }
      res.json({
        ok: !!chatResult,
        text: chatResult?.text,
        usage: chatResult?.usage,
        modelName: chatResult?.modelName,
        msg: chatErr,
        probe,
        url: probe?.url,
        method: probe?.method
      })
    } catch (e) {
      res.json({ ok: false, msg: e.message || String(e) })
    }
  })

  app.get('/api/server-info', (req, res) => {
    const sessionToken = req.cookies?.ai0_session || req.headers['x-ai0-session']
    const authenticated = sessionToken && auth.verifySession(sessionToken, req.clientIp)
    if (!authenticated) {
      return res.json({ ok: true, info: { running: isRunning() } })
    }
    res.json({ ok: true, info: getServerInfo() })
  })

  // ---- 图片生成配置 ----
  app.get('/api/image-config', requireAuth, (req, res) => {
    const c = cfg.loadConfig()
    const ic = c.imageGen || {}
    // 完全脱敏 apiKey：不返回任何真实字符，有值统一用占位符替代
    const safe = JSON.parse(JSON.stringify(ic))
    if (safe.apiKey && !/^\s*$/.test(safe.apiKey) && !/^\*+$/.test(safe.apiKey)) {
      safe.apiKey = API_KEY_PLACEHOLDER
    }
    res.json({ ok: true, config: safe })
  })

  app.post('/api/image-config', requireAuth, requireCsrf, async (req, res) => {
    const { config: ic } = req.body || {}
    if (!ic || typeof ic !== 'object') {
      return res.json({ ok: false, msg: '配置格式错误' })
    }
    const full = cfg.loadConfig()
    // 脱敏 apiKey 还原（精确比对占位符）
    const oldKey = full.imageGen?.apiKey
    if (typeof ic.apiKey === 'string' && ic.apiKey === API_KEY_PLACEHOLDER && typeof oldKey === 'string') {
      ic.apiKey = oldKey
    }
    // — P2-3: apiBase 输入净化 + URL 格式校验 + SSRF 校验（同 /api/config 的 model 级别）
    const apiBase = String(ic.apiBase || '').trim()
    if (apiBase) {
      let normalized
      try {
        // 必须是合法 http(s) URL；非 http(s)、URL 解析失败都直接拒绝
        const u = new URL(helper.normalizeApiBase(apiBase) + '/')
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只允许 http(s) 协议')
        normalized = helper.normalizeApiBase(apiBase)
      } catch (_) {
        return res.json({ ok: false, msg: 'apiBase 格式错误：请填入合法的 http(s) URL（如 https://api.moonshot.cn/v1）' })
      }
      const chk = await isAllowedOutboundUrl(normalized).catch(() => null)
      if (!chk || !chk.ok) {
        return res.json({ ok: false, msg: 'apiBase 未通过安全校验（禁止访问私有/回环/链路本地地址）' })
      }
      ic.apiBase = normalized
    }
    const apiKey = String(ic.apiKey || '').trim()
    const model = String(ic.model || '').trim()
    // 启用时 apiBase、apiKey、model 都不能为空
    const enabled = ic.enabled === true || ic.enabled === 'true'
    if (enabled && (!apiBase || !apiKey || !model)) {
      return res.json({ ok: false, msg: '启用图片生成时，apiBase、apiKey、model 三项不能为空' })
    }
    full.imageGen = {
      enabled,
      apiBase,
      apiKey,
      model: model || 'dall-e-3',
      defaultSize: String(ic.defaultSize || '').trim() || '1024x1024',
      quality: String(ic.quality || '').trim() || 'standard',
      timeout: parseInt(ic.timeout, 10) || 120000
    }
    const ok = cfg.saveConfig(full)
    res.json({ ok, msg: ok ? '图片配置已保存' : '保存失败' })
  })

  app.post('/api/test-image', requireAuth, requireCsrf, async (req, res) => {
    const { prompt } = req.body || {}
    if (!prompt || typeof prompt !== 'string') {
      return res.json({ ok: false, msg: '请提供测试提示词' })
    }
    if (prompt.length > 4000) {
      return res.json({ ok: false, msg: '提示词过长（最多 4000 字符）' })
    }
    try {
      const result = await imageGen.generateImage(prompt)
      res.json(result)
    } catch (err) {
      safeLogger.error(`[ai0-plugin] 图片生成失败: ${err.message}`)
      res.json({ ok: false, error: '图片生成失败，请稍后重试' })
    }
  })

  // —— Express 全局错误处理中间件 ——
  app.use((err, req, res, _next) => {
    const msg = err?.message || String(err)
    safeLogger.error(`[ai0-plugin] Web 服务异常: ${msg}`)
    res.status(500).json({ ok: false, msg: '服务器内部错误' })
  })

  return app
}

export function startWebServer(port = 12580, host = '127.0.0.1', options = {}) {
  return new Promise((resolve, reject) => {
    // ------ 输入规范化（防止 YAML 把 0.0.0.0 解析成数字 0 或其他脏值） ------
    const bind = cfg.normalizeWebBind ? cfg.normalizeWebBind({ host, port }) : null
    let startPort, h
    if (bind) {
      startPort = bind.port
      h = bind.host
    } else {
      startPort = Number(port)
      if (!Number.isFinite(startPort) || startPort <= 0 || startPort >= 65536) startPort = 12580
      h = host
      if (h == null) h = '127.0.0.1'
      if (typeof h !== 'string') h = String(h)
      h = h.trim()
      if (h === '0') h = '0.0.0.0'
      if (!h) h = '127.0.0.1'
    }
    const forceRestart = !!options.forceRestart
    // 用户允许端口递增自动寻找（可配置）
    const allowScan = cfg.get('web.autoPortScan', true) !== false
    const scanEndPort = Math.min(startPort + 20, 65535)

    const afterBound = (actualPort) => {
      currentPort = actualPort
      currentHost = h
      const info = getServerInfo()
      const lines = []
      lines.push(`[ai0-plugin] 网页管理后台已启动：绑定 ${h}:${actualPort}`)
      if (info.publicUrls && info.publicUrls.length) {
        lines.push(`  可访问地址（共 ${info.publicUrls.length} 个）：`)
        for (const u of info.publicUrls) lines.push(`    - ${u}`)
      }
      if (h === '0.0.0.0' || h === '::') {
        lines.push(`  ⚠️ 已开启对外监听（0.0.0.0），请确认以下安全措施：`)
        lines.push(`    · 云服务器安全组 / iptables/防火墙已放行 TCP ${actualPort}，但务必仅放行受信任的来源 IP；`)
        lines.push(`    · 公网暴露强烈建议套反代（Nginx/Caddy）+ HTTPS，并在插件配置 web.trustProxy=true 以读取真实 IP；`)
        lines.push(`    · 主人专属免登录链接（有效期10分钟）仅发私聊，请勿转发到公开群/频道；`)
        lines.push(`    · 默认验证码仅终端可查看，但已开启速率限制（每IP 60秒最多10次）+ 单ID错误5次即作废。`)
        if (cfg.get('web.trustProxy', false) !== true) {
          lines.push(`  ⚠️ Magic Link 绑定 IP 功能：未开启 trustProxy 时，所有请求 IP 相同，链接可被转发使用。建议配置 web.trustProxy=true`)
        }
      }
      const msg = lines.join('\n')
      if (typeof logger !== 'undefined') logger.info(msg)
      else console.log(msg)
      resolve({ ok: true, ...info, already: false })
    }

    let p = startPort
    const tryBind = () => {
      try {
        const app = createApp()
        serverInstance = app.listen(p, h)
        let bound = false
        serverInstance.once('listening', () => {
          bound = true
          afterBound(p)
        })
        serverInstance.on('error', (err) => {
          if (bound) return
          const code = (err && err.code) || String(err.message).slice(0, 40)
          // EADDRINUSE → 允许时自动尝试下一个端口
          if (String(code) === 'EADDRINUSE' && allowScan && p < scanEndPort) {
            const warn = `[ai0-plugin] 端口 ${p} 已占用，自动尝试下一个端口...`
            if (typeof logger !== 'undefined') logger.warn(warn)
            else console.warn(warn)
            try { serverInstance.removeAllListeners(); serverInstance.close?.() } catch (_) {}
            serverInstance = null
            p += 1
            // 退避 100ms，连续占满也不会打满 CPU
            setTimeout(tryBind, 100)
            return
          }
          serverInstance = null
          if (String(code) === 'EADDRINUSE') {
            reject(new Error(`端口 ${startPort}${startPort !== p ? '-' + p : ''} 全部被占用，请手动释放或修改 config.yaml 中的 web.port`))
          } else {
            reject(err)
          }
        })
      } catch (e) {
        reject(e)
      }
    }

    const doStart = () => {
      p = startPort
      tryBind()
    }

    if (serverInstance) {
      const sameBind = (currentHost === h) && (currentPort === p)
      if (sameBind && !forceRestart) {
        return resolve({ ok: true, ...getServerInfo(), already: true })
      }
      // 配置变更（或强制重启）→ 先关闭旧的，再启动新的
      try {
        try { serverInstance.closeAllConnections?.() } catch (_) {}
        serverInstance.close(() => {
          serverInstance = null
          currentHost = null
          currentPort = null
          doStart()
        })
        // 兜底：close 可能不回调
        const t = setTimeout(() => {
          if (serverInstance) {
            try { serverInstance.closeAllConnections?.() } catch (_) {}
            try { serverInstance.unref?.() } catch (_) {}
            serverInstance = null
            currentHost = null
            currentPort = null
            doStart()
          }
        }, 1500)
        if (t && t.unref) t.unref()
      } catch (_) {
        serverInstance = null
        currentHost = null
        currentPort = null
        doStart()
      }
      return
    }
    doStart()
  })
}

export function stopWebServer() {
  return new Promise((resolve) => {
    if (!serverInstance) return resolve(false)
    serverInstance.close(() => {
      serverInstance = null
      currentPort = null
      currentHost = null
      resolve(true)
    })
    setTimeout(() => {
      if (serverInstance) {
        try { serverInstance.closeAllConnections?.() } catch (_) {}
        serverInstance = null
        currentPort = null
        currentHost = null
      }
      resolve(true)
    }, 3000)
  })
}
