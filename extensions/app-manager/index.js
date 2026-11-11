/**
 * App 管理扩展 v1.1
 *
 * 面板能力：状态 / 指标 / 模型 / 切默认模型 / 生成绑定码
 * 绑定流程：
 *   1. 网页后台「App 管理」页点「生成绑定码」（需登录，10 分钟有效、一次性）
 *   2. App 输入绑定码，或扫二维码（ai0://bind?u=<面板地址>&c=<绑定码>）
 *   3. POST /api/ext/app-manager/pair（免登录、限速）→ 校验通过签发会话
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { issueSession } from '../../src/auth.js'
import { getPrimaryIdentity } from '../../src/loginGuard.js'

export default function register({ router, app, cfg, logger, requireCsrf, dataDir }) {
  const getCfg = () => {
    try { return cfg.loadConfig() || {} } catch (_) { return {} }
  }

  const modelEntries = (c) => {
    const out = []
    const m = c && c.model
    if (!m || typeof m !== 'object') return out
    for (const [key, v] of Object.entries(m)) {
      if (key === 'default' || !v || typeof v !== 'object') continue
      out.push({ key, value: v })
    }
    return out
  }

  /* ---------------- 状态 / 模型 ---------------- */

  router.get('/status', (req, res) => {
    const c = getCfg()
    const models = modelEntries(c)
    res.json({
      ok: true,
      time: Date.now(),
      plugin: {
        agentEnabled: !!(c.agent && c.agent.enabled),
        defaultModel: (c.model && c.model.default) || '',
        modelCount: models.length,
        groupCount: Array.isArray(c.chat && c.chat.globalAIGroups) ? c.chat.globalAIGroups.length : 0
      }
    })
  })

  router.get('/metrics', (req, res) => {
    const cpuTimes = () => {
      const l = (fs.readFileSync('/proc/stat', 'utf8').split('\n')[0] || '').trim().split(/\s+/).slice(1).map(Number)
      return { idle: l[3] + (l[4] || 0), total: l.reduce((a, b) => a + b, 0) }
    }
    const t1 = cpuTimes()
    setTimeout(() => {
      const t2 = cpuTimes()
      const cpu = t2.total > t1.total ? Math.round(100 * (1 - (t2.idle - t1.idle) / (t2.total - t1.total))) : 0
      const mi = {}
      for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/)
        if (m) mi[m[1]] = +m[2]
      }
      const memTotal = (mi.MemTotal || 0) * 1024
      const memAvail = (mi.MemAvailable || 0) * 1024
      const load = parseFloat((fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0] || '0'))
      let disk = { total: 0, free: 0 }
      try { const sf = fs.statfsSync('/'); disk = { total: sf.blocks * sf.bsize, free: sf.bfree * sf.bsize } } catch (_) {}
      res.json({ ok: true, cpu, mem: { used: memTotal - memAvail, total: memTotal }, disk, load, uptime: Math.round(os.uptime()) })
    }, 250)
  })

  router.get('/models', (req, res) => {
    const c = getCfg()
    const def = (c.model && c.model.default) || ''
    const list = modelEntries(c).map(({ key, value }) => ({
      key,
      name: value.name || key,
      kind: value.kind || 'custom',
      vision: Array.isArray(value.scopes) ? value.scopes.includes('vision') : !!value.vision,
      hasKey: !!String(value.apiKey || '').trim(),
      isDefault: key === def
    }))
    res.json({ ok: true, default: def, list })
  })

  router.post('/default-model', requireCsrf, (req, res) => {
    const key = String((req.body && req.body.key) || '').trim()
    if (!key) return res.json({ ok: false, msg: '缺少模型 key' })
    const c = getCfg()
    if (!c.model || !c.model[key] || typeof c.model[key] !== 'object') {
      return res.json({ ok: false, msg: '模型不存在' })
    }
    const before = c.model.default || ''
    c.model.default = key
    let ok = false
    try { ok = cfg.saveConfig(c) } catch (e) { logger.warn(`[app-manager] 保存失败: ${e.message}`) }
    if (!ok) {
      c.model.default = before
      return res.json({ ok: false, msg: '保存失败，请检查 config.yaml 权限' })
    }
    res.json({ ok: true, msg: '已切换默认模型', key })
  })

  /* ---------------- 绑定码 ---------------- */

  const PAIR_FILE = path.join(dataDir, 'app-manager-pairing.json')
  const readPair = () => {
    try {
      const r = JSON.parse(fs.readFileSync(PAIR_FILE, 'utf8'))
      return { code: typeof r.code === 'string' ? r.code : null, expires: +r.expires || 0, used: !!r.used }
    } catch (_) { return { code: null, expires: 0, used: true } }
  }

  const savePair = () => {
    try {
      fs.writeFileSync(PAIR_FILE, JSON.stringify(pair))
      try { fs.chmodSync(PAIR_FILE, 0o600) } catch (_) {}
    } catch (e) { logger.warn(`[app-manager] 绑定码持久化失败: ${e.message}`) }
  }

  // 生成绑定码（需登录 + CSRF）
  router.post('/pair-code', requireCsrf, (req, res) => {
    const p = {
      code: crypto.randomBytes(4).toString('hex').toUpperCase(),
      expires: Date.now() + 10 * 60 * 1000,
      used: false
    }
    try {
      fs.writeFileSync(PAIR_FILE, JSON.stringify(p))
      try { fs.chmodSync(PAIR_FILE, 0o600) } catch (_) {}
    } catch (e) { logger.warn(`[app-manager] 绑定码持久化失败: ${e.message}`) }
    res.json({ ok: true, code: p.code, ttl: 600 })
  })

  // 绑定（免登录；内存级限速：每 IP 每分钟 6 次）
  const pairHits = new Map()
  const pairRate = (ip) => {
    const now = Date.now()
    const win = now - 60 * 1000
    const arr = (pairHits.get(ip) || []).filter((t) => t > win)
    if (arr.length >= 6) return false
    arr.push(now)
    pairHits.set(ip, arr)
    if (pairHits.size > 500) for (const [k, v] of pairHits) if (!v.length) pairHits.delete(k)
    return true
  }

  app.post('/api/ext/app-manager/pair', (req, res) => {
    const ip = String(req.clientIp || req.ip || 'unknown')
    if (!pairRate(ip)) return res.status(429).json({ ok: false, msg: '尝试过于频繁，请稍后再试' })
    const code = String((req.body && req.body.code) || '').trim().toUpperCase()
    if (!code) return res.json({ ok: false, msg: '缺少绑定码' })
    const p = readPair()
    if (!p.code || p.used || Date.now() > p.expires) {
      return res.json({ ok: false, msg: '绑定码无效或已过期，请在网页后台重新生成' })
    }
    if (code !== p.code) return res.json({ ok: false, msg: '绑定码不正确' })
    try { fs.writeFileSync(PAIR_FILE, JSON.stringify({ ...p, used: true })) } catch (_) {}
    const identity = getPrimaryIdentity() || 'app-binding'
    const s = issueSession(ip, identity)
    logger.info?.(`[app-manager] App 绑定成功（身份 ${identity}，IP ${ip}）`)
    res.json({ ok: true, session: s.token, csrf: s.csrf, identity })
  })
}
