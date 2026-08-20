import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cookieParser from 'cookie-parser'
import * as cfg from '../config/index.js'
import * as llm from './llm.js'
import * as auth from './auth.js'
import * as helper from './helper.js'
import * as imageGen from './imageGen.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.join(__dirname, '..')
const WEB_DIR = path.join(PLUGIN_ROOT, 'web')

let serverInstance = null
let currentPort = null
let currentHost = null

/* ---------- 修复 7：路径组件白名单校验（防止 .. 越界删除或读取） ---------- */
/**
 * 对 userId/sessionId 等外部输入做"路径安全化"：
 *  - 仅允许 ASCII 字母/数字/-/_/.，其他字符一律剔除
 *  - 禁止 .. 和开头的 .
 *  - 禁止 / \ 路径分隔符
 *  - 空串返回 null（调用方据此应判非法）
 */
function safePathComponent(raw) {
  if (raw == null) return null
  let s = String(raw).trim()
  if (!s) return null
  // 先去掉所有 ..
  s = s.replace(/\.\.+/g, '')
  // 去掉开头的所有 .
  while (s.startsWith('.')) s = s.slice(1)
  // 再做白名单过滤（仅允许 \w . -）
  s = s.replace(/[^\w.\-]/g, '')
  // 最后兜底再去除任何可能的 / \
  s = s.replace(/[\/\\]/g, '')
  if (!s) return null
  return s
}

/**
 * 对最终 path 做「归一化后必须仍在 baseDir 内」的二次校验（双重保险），
 * 如果越界返回 null，否则返回归一化后的真实绝对路径。
 */
function safeJoinUnder(baseDir, relativeComponent) {
  if (!baseDir || !relativeComponent) return null
  const resolved = path.resolve(baseDir, relativeComponent)
  const base = path.resolve(baseDir)
  // 归一化后必须是 base + sep 开头，或恰好等于 base
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null
  return resolved
}

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

function listSessions() {
  const historyDir = path.join(PLUGIN_ROOT, 'data', 'history')
  const out = []
  if (!fs.existsSync(historyDir)) return out
  // 先做整体归一化校验，避免 data/history 本身是符号链接飞出 PLUGIN_ROOT
  const safeHistoryDir = safeJoinUnder(PLUGIN_ROOT, path.join('data', 'history'))
  if (!safeHistoryDir) return out
  for (const user of fs.readdirSync(historyDir)) {
    // 读目录后同样过一遍白名单（防止有人手动在 history 下塞了 ../ 之类的奇怪命名目录）
    const safeUser = safePathComponent(user)
    if (!safeUser || safeUser !== user) continue
    const ud = safeJoinUnder(historyDir, safeUser)
    if (!ud) continue
    const st = fs.statSync(ud)
    if (!st.isDirectory()) continue
    const files = fs.readdirSync(ud).filter(f => f.endsWith('.json'))
    const sessions = []
    for (const f of files) {
      // session 文件名白名单
      const sessionIdRaw = f.replace(/\.json$/, '')
      const safeId = safePathComponent(sessionIdRaw)
      if (!safeId || safeId !== sessionIdRaw) continue
      const fp = safeJoinUnder(ud, f)
      if (!fp) continue
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
        id: safeId,
        size: s.size,
        mtime: s.mtimeMs,
        msgCount,
        preview
      })
    }
    sessions.sort((a, b) => b.mtime - a.mtime)
    out.push({
      userId: safeUser,
      sessions,
      totalMessages: sessions.reduce((a, s) => a + s.msgCount, 0)
    })
  }
  out.sort((a, b) => b.totalMessages - a.totalMessages)
  return out
}

function requireAuth(req, res, next) {
  const token = req.cookies?.ai0_session || req.headers['x-ai0-session']
  if (!auth.verifySession(token)) {
    return res.status(401).json({ ok: false, msg: '未登录或登录已过期' })
  }
  next()
}

export function createApp() {
  const app = express()
  app.use(cookieParser())
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true }))

  // —— 反向代理真实 IP 识别（给限速用）：兼容 Cloudflare / X-Forwarded-For / X-Real-IP
  function getClientIp(req) {
    const trustProxy = cfg.get('web.trustProxy', false)
    let ip = req.socket?.remoteAddress || req.ip || 'unknown'
    if (trustProxy) {
      const pickFromHeaders = [
        'cf-connecting-ip',       // Cloudflare
        'x-forwarded-for',        // 标准
        'x-real-ip',              // Nginx
        'x-client-ip',
        'forwarded-for',
        'x-cluster-client-ip'
      ]
      for (const h of pickFromHeaders) {
        const v = req.headers?.[h]
        if (typeof v === 'string' && v.trim()) {
          const first = v.split(',')[0].trim()
          if (first) { ip = first; break }
        }
      }
    }
    // 去 IPv6 包装，如 ::ffff:127.0.0.1 → 127.0.0.1
    if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7)
    return ip || 'unknown'
  }
  // 每请求挂一个 req.clientIp
  app.use((req, res, next) => {
    req.clientIp = getClientIp(req)
    next()
  })

  // 全局基础安全头
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.removeHeader('X-Powered-By')
    next()
  })

  // 首页 / 静态资源
  app.get('/', (req, res) => {
    const token = req.cookies?.ai0_session
    const file = auth.verifySession(token)
      ? path.join(WEB_DIR, 'dashboard.html')
      : path.join(WEB_DIR, 'login.html')
    if (fs.existsSync(file)) return res.sendFile(file)
    res.status(500).send('页面文件缺失，请检查 web/ 目录')
  })

  app.use('/assets', express.static(path.join(WEB_DIR, 'assets')))

  app.get('/magic/:token', (req, res) => {
    const r = auth.verifyMagicLink(req.params.token, req.clientIp)
    if (!r.ok) {
      const f = path.join(WEB_DIR, 'login.html')
      if (fs.existsSync(f)) return res.sendFile(f)
      return res.send('链接无效或已过期')
    }
    const session = auth.issueSession()
    res.cookie('ai0_session', session, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: auth.AUTH_CFG.tokenExpireMs
    })
    return res.redirect('/')
  })

  // ==================== API ====================
  app.post('/api/login/code', (req, res) => {
    const { codeId, code } = req.body || {}
    const id = codeId || auth.getPendingCodeId()
    if (!id) return res.json({ ok: false, msg: '当前没有待验证的验证码，请先在终端生成' })
    const r = auth.verifyCode(id, code, req.clientIp)
    if (!r.ok) return res.json(r)
    const session = auth.issueSession()
    res.cookie('ai0_session', session, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: auth.AUTH_CFG.tokenExpireMs
    })
    res.json({ ok: true })
  })

  app.post('/api/logout', (req, res) => {
    const t = req.cookies?.ai0_session
    if (t) auth.destroySession(t)
    res.clearCookie('ai0_session')
    res.json({ ok: true })
  })

  app.get('/api/me', (req, res) => {
    const token = req.cookies?.ai0_session
    res.json({ ok: true, loggedIn: auth.verifySession(token) })
  })

  // 任何人都可以访问的诊断接口（无敏感信息，只返回主人来源结构、合并后主人数量、是否有配置apiKey等）
  app.get('/api/diag', (req, res) => {
    try {
      const sources = helper.listMasterSources()
      const allMasters = helper.listMasters()
      const cfgData = cfg.loadConfig()
      const def = cfgData.model?.default || '(未设置)'
      const mm = (cfgData.model && def && cfgData.model[def]) || {}
      const apiKeyMasked = !!(mm.apiKey && !/^\s*$/.test(mm.apiKey) && !/sk-your-api|^\*+$/.test(mm.apiKey))
      const info = getServerInfo()
      const bindFromCfg = (cfgData.web && typeof cfgData.web === 'object')
        ? { host: (cfgData.web.host == null ? null : String(cfgData.web.host)), port: cfgData.web.port == null ? null : Number(cfgData.web.port) }
        : null
      res.json({
        ok: true,
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
  app.get('/api/config', requireAuth, (req, res) => {
    const c = cfg.loadConfig()
    // 脱敏 apikey
    const safe = JSON.parse(JSON.stringify(c))
    if (safe.model) {
      for (const k of Object.keys(safe.model)) {
        if (safe.model[k] && typeof safe.model[k] === 'object' && safe.model[k].apiKey) {
          const key = safe.model[k].apiKey
          if (key.length > 8) {
            safe.model[k].apiKey = key.slice(0, 4) + '****' + key.slice(-4)
          } else {
            safe.model[k].apiKey = '****'
          }
        }
      }
    }
    res.json({ ok: true, config: safe })
  })

  app.post('/api/config', requireAuth, async (req, res) => {
    const { config } = req.body || {}
    if (!config || typeof config !== 'object') {
      return res.json({ ok: false, msg: '配置格式错误' })
    }
    // ========== 修复 12：网页后台整体提交也走原子 modifyConfig ==========
    //   - 在锁内部：读旧配置（防中途被其它 save 改了 apikey 后被误还原成 ****）
    //   - 整体替换（保持原语义：提交上来的 cleaned 整体覆盖写盘）
    try {
      const { ok } = await cfg.modifyConfig((prev) => {
        const cleaned = JSON.parse(JSON.stringify(config))
        if (cleaned.model && prev?.model) {
          for (const k of Object.keys(cleaned.model)) {
            const newVal = cleaned.model[k]?.apiKey
            const oldVal = prev.model[k]?.apiKey
            if (typeof newVal === 'string' && newVal.includes('****') && typeof oldVal === 'string') {
              cleaned.model[k].apiKey = oldVal
            }
          }
        }
        return cleaned
      })
      res.json({ ok, msg: ok ? '已保存' : '保存失败，查看日志' })
    } catch (e) {
      res.json({ ok: false, msg: e.message })
    }
  })

  app.get('/api/sessions', requireAuth, (req, res) => {
    res.json({ ok: true, data: listSessions() })
  })

  app.delete('/api/sessions/:userId/:sessionId?', requireAuth, (req, res) => {
    // ========== 修复 7：外部 userId/sessionId 必须通过白名单校验 ==========
    // 注：此接口已 requireAuth，但仍然要防认证后越界（防止 history 外的 .json 被误删）
    const rawUserId = req.params?.userId
    const rawSessionId = req.params?.sessionId
    const userId = safePathComponent(rawUserId)
    if (!userId) return res.json({ ok: false, msg: 'userId 非法（仅允许字母/数字/-/_/.）' })
    const historyBase = path.join(PLUGIN_ROOT, 'data', 'history')
    const dir = safeJoinUnder(historyBase, userId)
    if (!dir) return res.json({ ok: false, msg: '路径越界，拒绝操作' })
    if (!fs.existsSync(dir)) return res.json({ ok: false, msg: '目录不存在' })
    try {
      if (rawSessionId !== undefined && rawSessionId !== null && rawSessionId !== '') {
        const sessionId = safePathComponent(rawSessionId)
        if (!sessionId) return res.json({ ok: false, msg: 'sessionId 非法' })
        const p = safeJoinUnder(dir, `${sessionId}.json`)
        if (!p) return res.json({ ok: false, msg: 'session 路径越界' })
        if (fs.existsSync(p)) fs.unlinkSync(p)
      } else {
        // 删除整个用户目录下的所有 .json（依然逐个过 safeJoinUnder，不依赖 readdirSync 结果）
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue
          const idRaw = f.slice(0, -5)
          const idSafe = safePathComponent(idRaw)
          if (!idSafe || idSafe !== idRaw) continue
          const p = safeJoinUnder(dir, f)
          if (!p) continue
          if (fs.existsSync(p)) fs.unlinkSync(p)
        }
      }
      res.json({ ok: true })
    } catch (e) {
      res.json({ ok: false, msg: e.message })
    }
  })

  app.get('/api/sessions/:userId/:sessionId', requireAuth, (req, res) => {
    // ========== 修复 7：同样做白名单 + 路径边界校验 ==========
    const userId = safePathComponent(req.params?.userId)
    const sessionId = safePathComponent(req.params?.sessionId)
    if (!userId || !sessionId) return res.json({ ok: false, msg: 'userId/sessionId 非法' })
    const historyBase = path.join(PLUGIN_ROOT, 'data', 'history')
    const dir = safeJoinUnder(historyBase, userId)
    if (!dir) return res.json({ ok: false, data: [] })
    const filePath = safeJoinUnder(dir, `${sessionId}.json`)
    if (!filePath) return res.json({ ok: false, data: [] })
    const arr = llm.loadHistory(userId, sessionId)
    // 最后再兜底：llm.loadHistory 内部会用 historyFile(userId, sessionId) 再拼成一次路径，
    // 但我们在 Web API 入口已经把参数白名单化，这里直接返回即可。
    res.json({ ok: true, data: arr })
  })

  // ---- 多 API 平台：探测某 provider 的 /models ----
  app.post('/api/providers/probe', requireAuth, async (req, res) => {
    const { modelKey = null } = req.body || {}
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
  app.post('/api/providers/probe-all', requireAuth, async (req, res) => {
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
          return { key, ok: false, models: [], latencyMs: Date.now() - t0, error: e.message || String(e) }
        }
      }))
      res.json({ ok: true, results })
    } catch (e) {
      res.json({ ok: false, msg: e.message || String(e) })
    }
  })

  app.post('/api/test-model', requireAuth, async (req, res) => {
    const { message = '请用一句话介绍你自己', modelKey = null } = req.body || {}
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
    res.json({ ok: true, info: getServerInfo() })
  })

  // ---- 图片生成配置 ----
  app.get('/api/image-config', requireAuth, (req, res) => {
    const c = cfg.loadConfig()
    const ic = c.imageGen || {}
    // 脱敏 apiKey
    const safe = JSON.parse(JSON.stringify(ic))
    if (safe.apiKey && safe.apiKey.length > 8) {
      safe.apiKey = safe.apiKey.slice(0, 4) + '****' + safe.apiKey.slice(-4)
    } else if (safe.apiKey) {
      safe.apiKey = '****'
    }
    res.json({ ok: true, config: safe })
  })

  app.post('/api/image-config', requireAuth, async (req, res) => {
    const { config: ic } = req.body || {}
    if (!ic || typeof ic !== 'object') {
      return res.json({ ok: false, msg: '配置格式错误' })
    }
    // ========== 修复 12：图片配置写入也走原子 modifyConfig ==========
    try {
      const { ok } = await cfg.modifyConfig((prev) => {
        const full = prev
        // 脱敏 apiKey 还原：在锁内部读 prev，确保读到的是最新真正磁盘上的
        const oldKey = full.imageGen?.apiKey
        let newKey = ic.apiKey
        if (typeof newKey === 'string' && newKey.includes('****') && typeof oldKey === 'string') {
          newKey = oldKey
        }
        full.imageGen = {
          enabled: ic.enabled === true || ic.enabled === 'true',
          apiBase: String(ic.apiBase || '').replace(/[\u0000-\u001F\u007F\r\n]/g, '').slice(0, 512),
          apiKey: String(newKey || '').replace(/[\u0000-\u001F\u007F\r\n]/g, '').slice(0, 512),
          model: helper.normalizeModelName(String(ic.model || '')) || 'dall-e-3',
          defaultSize: String(ic.defaultSize || '1024x1024').replace(/[\u0000-\u001F\u007F\r\n]/g, '').slice(0, 32),
          quality: String(ic.quality || 'standard').replace(/[\u0000-\u001F\u007F\r\n]/g, '').slice(0, 32),
          timeout: parseInt(ic.timeout, 10) || 120000
        }
        return full
      })
      res.json({ ok, msg: ok ? '图片配置已保存' : '保存失败' })
    } catch (e) {
      res.json({ ok: false, msg: e.message })
    }
  })

  app.post('/api/test-image', requireAuth, async (req, res) => {
    const { prompt } = req.body || {}
    if (!prompt || typeof prompt !== 'string') {
      return res.json({ ok: false, msg: '请提供测试提示词' })
    }
    try {
      const result = await imageGen.generateImage(prompt)
      res.json(result)
    } catch (err) {
      res.json({ ok: false, error: err.message })
    }
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
    setTimeout(() => resolve(true), 3000)
  })
}
