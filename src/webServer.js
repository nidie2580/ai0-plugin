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
  for (const user of fs.readdirSync(historyDir)) {
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
    const r = auth.verifyMagicLink(req.params.token)
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
    const r = auth.verifyCode(id, code)
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

  app.post('/api/config', requireAuth, (req, res) => {
    const { config } = req.body || {}
    if (!config || typeof config !== 'object') {
      return res.json({ ok: false, msg: '配置格式错误' })
    }
    // 把脱敏的 apiKey 还原：收到 **** 时，从原配置读取
    const old = cfg.loadConfig()
    const cleaned = JSON.parse(JSON.stringify(config))
    if (cleaned.model && old.model) {
      for (const k of Object.keys(cleaned.model)) {
        const newVal = cleaned.model[k]?.apiKey
        const oldVal = old.model[k]?.apiKey
        if (typeof newVal === 'string' && newVal.includes('****') && typeof oldVal === 'string') {
          cleaned.model[k].apiKey = oldVal
        }
      }
    }
    const ok = cfg.saveConfig(cleaned)
    res.json({ ok, msg: ok ? '已保存' : '保存失败，查看日志' })
  })

  app.get('/api/sessions', requireAuth, (req, res) => {
    res.json({ ok: true, data: listSessions() })
  })

  app.delete('/api/sessions/:userId/:sessionId?', requireAuth, (req, res) => {
    const { userId, sessionId } = req.params
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
      res.json({ ok: false, msg: e.message })
    }
  })

  app.get('/api/sessions/:userId/:sessionId', requireAuth, (req, res) => {
    const { userId, sessionId } = req.params
    const arr = llm.loadHistory(userId, sessionId)
    res.json({ ok: true, data: arr })
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

  app.post('/api/image-config', requireAuth, (req, res) => {
    const { config: ic } = req.body || {}
    if (!ic || typeof ic !== 'object') {
      return res.json({ ok: false, msg: '配置格式错误' })
    }
    const full = cfg.loadConfig()
    // 脱敏 apiKey 还原
    const oldKey = full.imageGen?.apiKey
    if (typeof ic.apiKey === 'string' && ic.apiKey.includes('****') && typeof oldKey === 'string') {
      ic.apiKey = oldKey
    }
    full.imageGen = {
      enabled: ic.enabled === true || ic.enabled === 'true',
      apiBase: ic.apiBase || '',
      apiKey: ic.apiKey || '',
      model: ic.model || 'dall-e-3',
      defaultSize: ic.defaultSize || '1024x1024',
      quality: ic.quality || 'standard',
      timeout: parseInt(ic.timeout, 10) || 120000
    }
    const ok = cfg.saveConfig(full)
    res.json({ ok, msg: ok ? '图片配置已保存' : '保存失败' })
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
    let p, h
    if (bind) {
      p = bind.port
      h = bind.host
    } else {
      p = Number(port)
      if (!Number.isFinite(p) || p <= 0 || p >= 65536) p = 12580
      h = host
      if (h == null) h = '127.0.0.1'
      if (typeof h !== 'string') h = String(h)
      h = h.trim()
      if (h === '0') h = '0.0.0.0'
      if (!h) h = '127.0.0.1'
    }
    const forceRestart = !!options.forceRestart

    const doStart = () => {
      try {
        const app = createApp()
        serverInstance = app.listen(p, h, () => {
          currentPort = p
          currentHost = h
          const info = getServerInfo()
          const lines = []
          lines.push(`[ai0-plugin] 网页管理后台已启动：绑定 ${h}:${p}`)
          if (info.publicUrls && info.publicUrls.length) {
            lines.push(`  可访问地址（共 ${info.publicUrls.length} 个）：`)
            for (const u of info.publicUrls) lines.push(`    - ${u}`)
          }
          if (h === '0.0.0.0' || h === '::') {
            lines.push(`  ⚠️ 已开启对外监听，请确认云服务器/防火墙/安全组已放行 TCP ${p} 端口。`)
          }
          const msg = lines.join('\n')
          if (typeof logger !== 'undefined') logger.info(msg)
          else console.log(msg)
          resolve({ ok: true, ...info, already: false })
        })
        serverInstance.on('error', (err) => {
          serverInstance = null
          reject(err)
        })
      } catch (e) {
        reject(e)
      }
    }

    if (serverInstance) {
      const sameBind = (currentHost === h) && (currentPort === p)
      if (sameBind && !forceRestart) {
        return resolve({ ok: true, ...getServerInfo(), already: true })
      }
      // 配置变更（或强制重启）→ 先关闭旧的，再启动新的
      try {
        serverInstance.close(() => {
          serverInstance = null
          currentHost = null
          currentPort = null
          doStart()
        })
        // 兜底：close 可能不回调（未真正启动/绑定中）
        const t = setTimeout(() => {
          if (serverInstance) {
            try { serverInstance.closeAllConnections?.() } catch (_) {}
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
