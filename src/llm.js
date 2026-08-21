import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import * as cfg from '../config/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history')
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true })

// ————————————————————————————————————————————————————————————
// 每用户串行化队列 & 原子写入 + 崩溃恢复
// 防止：①并发写同一个 JSON → 数据损坏  ②断电写一半 → 空JSON
// ————————————————————————————————————————————————————————————
const userQueues = new Map()                 // userId → Promise 链
const inflightSaves = new Map()              // userId/sessionId → 最新 messages（去抖合并）

function runInUserQueue(userId, fn) {
  const prev = userQueues.get(userId) || Promise.resolve()
  const next = prev.then(() => Promise.resolve().then(fn)).catch(() => {})
  userQueues.set(userId, next)
  return next
}

function historyFile(userId, sessionId) {
  const dir = path.join(HISTORY_DIR, String(userId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${sessionId}.json`)
}

/** 安全读：读不到/损坏时尝试 .bak 恢复；再不行返回空数组 */
export function loadHistory(userId, sessionId) {
  const file = historyFile(userId, sessionId)
  // 1. 优先读正式文件
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf-8')
      if (!raw || raw.trim().length < 2) throw new Error('empty file')
      return JSON.parse(raw)
    } catch (err) {
      // 主文件损坏 → 尝试 .bak 备份
      const bak = file + '.bak'
      try {
        if (fs.existsSync(bak)) {
          const raw = fs.readFileSync(bak, 'utf-8')
          const arr = JSON.parse(raw)
          // 备份有效 → 把备份回写到主文件
          try {
            const tmp = file + '.tmp.' + Date.now()
            fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf-8')
            fs.renameSync(tmp, file)
            logger.warn && logger.warn(`[ai0-plugin] ${file} 已损坏，已从 .bak 恢复`)
          } catch (_) {}
          return arr
        }
      } catch (_) {}
      logger.warn && logger.warn(`[ai0-plugin] 会话历史损坏且无备份，已丢弃: ${file} (${err.message})`)
      return []
    }
  }
  return []
}

/**
 * 安全写：先 .tmp 再 rename（原子替换），成功后写 .bak
 * 同一 userId 内串行化；如果用户会话在排队期间又有新 save，合并成最后一次写。
 */
export function saveHistory(userId, sessionId, messages) {
  // 1) 只保留最后一次写入（避免连续对话触发成百上千次 fs.writeFileSync）
  const key = `${userId}/${sessionId}`
  inflightSaves.set(key, messages)

  runInUserQueue(userId, async () => {
    const latest = inflightSaves.get(key)
    if (latest === undefined) return
    inflightSaves.delete(key)

    const file = historyFile(userId, sessionId)
    const tmp = file + `.tmp.${process.pid}.${Date.now()}`
    const bak = file + '.bak'
    try {
      const data = JSON.stringify(latest, null, 2)
      // 先写到 tmp
      fs.writeFileSync(tmp, data, 'utf-8')
      // 尽量刷盘（兼容旧 node 忽略）；fd 用完必须 close，避免句柄泄漏
      try {
        const fd = fs.openSync(tmp, 'r')
        try { fs.fsyncSync?.(fd) } finally { fs.closeSync(fd) }
      } catch (_) {}
      // 主文件存在时 → 覆盖 .bak
      try {
        if (fs.existsSync(file)) {
          fs.copyFileSync(file, bak)
        }
      } catch (_) {}
      // 原子 rename
      fs.renameSync(tmp, file)
    } catch (err) {
      logger.error && logger.error(`[ai0-plugin] 保存历史失败: ${err.message}`)
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) } catch (_) {}
    }
  })
}

export function cleanupOldSessions(userId, maxSessions, timeoutMs) {
  const dir = path.join(HISTORY_DIR, String(userId))
  if (!fs.existsSync(dir)) return
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const p = path.join(dir, f)
      return { p, stat: fs.statSync(p) }
    })
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)

  if (timeoutMs > 0) {
    const now = Date.now()
    for (const f of files) {
      if (now - f.stat.mtimeMs > timeoutMs) {
        try { fs.unlinkSync(f.p) } catch {}
      }
    }
  }

  const remaining = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  if (remaining.length > maxSessions) {
    const toDelete = remaining
      .map(f => {
        const p = path.join(dir, f)
        return { p, stat: fs.statSync(p) }
      })
      .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
      .slice(0, remaining.length - maxSessions)
    for (const f of toDelete) {
      try { fs.unlinkSync(f.p) } catch {}
    }
  }
}

// ====== 通用 URL / 请求规范化 ======
export function normalizeApiBase(rawBase, kind = 'openai') {
  if (!rawBase || typeof rawBase !== 'string') return ''
  let base = rawBase.trim()
  if (!base) return ''

  // 去掉 query/hash
  try {
    const u = new URL(base)
    u.search = ''
    u.hash = ''
    base = u.toString()
  } catch (_) {
    // 非标准 URL（内网 http://localhost:1234 也可能走到这里），走字符串回退
    base = base.split('?')[0].split('#')[0]
  }

  // 若用户误把完整 /chat/completions 或 /v1/chat/completions 写进了 apiBase，裁剪到根（/v1 前缀保留）
  const re = /(.*?)\/?v(\d+(?:[\.-]\w+)*)?\/?(chat\/completions|models|embeddings)?\/?$/i
  const m = base.match(re)
  if (m && m[3]) {
    const host = m[1]
    const ver = m[2] ? `/v${m[2]}` : ''
    base = host + ver
  }

  // 再次标准化：去掉所有尾部 /，统一不要尾巴
  base = base.replace(/\/+$/, '')

  // 一些服务商（Kimi/DeepSeek/OpenAI 等）公开接口都要求带 /v1。如果用户写了裸域名（https://xxx.cn），就自动补 /v1，避免 404。
  // 但如果已经有版本号（/v1 /v2 /v3 /v4 等）或包含 /openai /ollama 等自定义路径段，就不补。
  try {
    const pu = new URL(base)
    const pathPart = pu.pathname || '/'
    const hasVersionOrCustom = /\/v\d/i.test(pathPart) || pathPart.replace(/\/+$/, '').length > 1
    if (!hasVersionOrCustom) {
      base = base + '/v1'
    }
  } catch (_) {}

  return base
}

export function buildEndpoint(base, pathSegment = '/chat/completions') {
  const b = normalizeApiBase(base, 'openai').replace(/\/+$/, '')
  const seg = pathSegment.startsWith('/') ? pathSegment : `/${pathSegment}`
  return b + seg
}

function redactKey(key) {
  if (!key || typeof key !== 'string') return '(空)'
  if (key.length <= 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

function summarizeAxiosError(err) {
  const status = err.response?.status
  const statusText = err.response?.statusText || ''
  const url = err.config?.url || ''
  const method = err.config?.method || ''
  let bodyPreview = ''
  if (err.response) {
    const d = err.response.data
    if (typeof d === 'string') bodyPreview = d.slice(0, 1500)
    else try { bodyPreview = JSON.stringify(d, null, 2).slice(0, 2000) } catch (_) {}
  }
  const code = err.code || ''
  const msg = err.message || ''
  return {
    status,
    statusText,
    code,
    method,
    url,
    message: msg,
    body: bodyPreview
  }
}

export async function listAvailableModels({ modelKey = null } = {}) {
  const config = cfg.loadConfig()
  const modelCfgKey = modelKey || config.model?.default || 'openai-compatible'
  const m = config.model?.[modelCfgKey] || {}
  if (!m.apiKey || !m.apiBase) return { ok: false, models: [], error: '未配置 apiBase 或 apiKey' }
  const base = normalizeApiBase(m.apiBase, 'openai')
  const modelsUrl = `${base}/models`
  try {
    const resp = await axios.get(modelsUrl, {
      headers: {
        'Authorization': `Bearer ${m.apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    })
    if (resp.status >= 200 && resp.status < 300) {
      const arr = Array.isArray(resp.data?.data) ? resp.data.data : Array.isArray(resp.data) ? resp.data : []
      const ids = arr.map(x => x?.id).filter(Boolean)
      return { ok: true, status: resp.status, url: modelsUrl, models: ids, count: ids.length }
    }
    return { ok: false, status: resp.status, url: modelsUrl, models: [], error: `HTTP ${resp.status}` }
  } catch (e) {
    const s = summarizeAxiosError(e)
    return { ok: false, models: [], error: s.message, status: s.status, url: modelsUrl }
  }
}

export async function probeModelConnection({ modelKey = null } = {}) {
  const config = cfg.loadConfig()
  const modelCfgKey = modelKey || config.model?.default || 'openai-compatible'
  const m = config.model?.[modelCfgKey] || {}
  if (!m.apiKey || !m.apiBase) {
    return { ok: false, reason: '未配置 apiBase 或 apiKey' }
  }
  const t0 = Date.now()
  const info = await listAvailableModels({ modelKey })
  const latencyMs = Date.now() - t0
  const out = {
    ok: info.ok,
    method: 'GET /models',
    status: info.status,
    url: info.url,
    latencyMs,
    availableModels: info.models || [],
    count: info.count || 0
  }
  if (!info.ok && info.error) out.error = info.error
  return out
}

export async function chatCompletions(messages, {
  modelKey = null,
  signal = null
} = {}) {
  const config = cfg.loadConfig()
  const modelCfgKey = modelKey || config.model?.default || 'openai-compatible'
  const m = config.model?.[modelCfgKey] || {}

  if (!m.apiKey || !m.apiBase) {
    throw new Error('模型 API 未配置，请在 config/config.yaml 中设置 apiBase 和 apiKey')
  }

  const rawBase = String(m.apiBase || '')
  const normalizedBase = normalizeApiBase(rawBase, 'openai')
  const url = buildEndpoint(normalizedBase, '/chat/completions')

  const model = String(m.model || 'gpt-3.5-turbo').trim() || 'gpt-3.5-turbo'
  const body = {
    model,
    messages,
    temperature: m.temperature ?? 0.8,
    max_tokens: m.maxTokens ?? 2000
  }

  if (typeof logger !== 'undefined') {
    logger.info(`[ai0-plugin] LLM 请求：base(原始)=${rawBase}  base(归一化)=${normalizedBase}  url=${url}  model=${model}  apiKey=${redactKey(m.apiKey)}`)
  }

  let resp
  try {
    resp = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${m.apiKey}`
      },
      timeout: m.timeout ?? 60000,
      signal,
      validateStatus: () => true
    })
  } catch (e) {
    const s = summarizeAxiosError(e)
    logger && logger.error && logger.error(`[ai0-plugin] LLM 调用异常(${s.method} ${s.url}): code=${s.code} message=${s.message}`)
    let msg = `请求异常：${s.message}`
    if (s.code === 'ECONNREFUSED') msg = '连接被拒绝：请确认 apiBase 地址/端口正确，且服务已启动。'
    else if (s.code === 'ETIMEDOUT' || s.code === 'ECONNABORTED') msg = '连接超时：apiBase 不可达或网络太慢（可尝试调大 timeout）。'
    else if (s.code === 'ENOTFOUND') msg = 'DNS 解析失败：apiBase 域名无法解析。'
    throw new Error(msg)
  }

  const status = resp.status
  if (status < 200 || status >= 300) {
    let bodyPreview = ''
    try {
      bodyPreview = typeof resp.data === 'string'
        ? resp.data.slice(0, 2000)
        : JSON.stringify(resp.data || {}).slice(0, 3000)
    } catch (_) {}
    logger && logger.error && logger.error(`[ai0-plugin] LLM HTTP ${status} ${resp.statusText || ''} | URL=${url}` + (bodyPreview ? `\n响应体:\n${bodyPreview}` : ''))

    // 友好化常见错误
    let extra = ''
    // 解析返回 JSON 里的 error.message
    let providerMsg = ''
    try {
      const j = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data
      providerMsg = j?.error?.message || j?.message || j?.msg || ''
    } catch (_) {}

    const lower = String(providerMsg).toLowerCase()
    const looksModelError = /not found the model|model.*not found|permission denied|unknown model|model_not_found|invalid model|does not exist|model.*not allowed|模型.*不存在|模型.*未授权|无权访问.*模型/.test(lower)

    if (status === 401) extra = '（API Key 错误、未生效或未填 Bearer 前缀）'
    else if (status === 403) extra = '（权限不足：此 key 无该模型权限或账户欠费/被封禁）'
    else if (status === 404) {
      extra = looksModelError
        ? '（模型名错误或该账户未开通此模型权限，不是接口路径问题）'
        : '（接口路径不存在：请确认 apiBase 是否正确。推荐格式：'
      extra += looksModelError ? '' : [
            '  Kimi: https://api.moonshot.cn/v1',
            '  DeepSeek: https://api.deepseek.com/v1',
            '  通用规则：若服务商要求带 /v1，请把 /v1 放到 apiBase 末尾，不要在 apiBase 里写 /chat/completions）'
          ].join('\n')
      extra += `\n  当前实际请求 URL: ${url}`
    } else if (status === 429) extra = '（请求过于频繁 / 速率限制 / 余额不足）'
    else if (status >= 500) extra = '（服务商服务端错误，稍后再试或查看服务状态页）'

    // 如果识别为模型错误，附加 /models 返回的可用模型列表，直接引导用户改配置
    let modelHint = ''
    if (looksModelError) {
      try {
        const avail = await listAvailableModels({ modelKey: modelCfgKey })
        if (avail.ok && Array.isArray(avail.models) && avail.models.length) {
          const list = avail.models.slice(0, 30).join(', ')
          modelHint = `\n本账号当前可用模型（共 ${avail.models.length} 个）：${list}\n请把 config.yaml 的 model 字段改为上方列表中的任意一个后重试。`
        } else {
          modelHint = '\n若 /models 不可达，请先用 #ai测试模型 诊断接口连通性。'
        }
      } catch (_) {}
    }

    const combined = [
      `HTTP ${status} ${resp.statusText || ''}${extra}`,
      providerMsg ? `提供商原始错误：${providerMsg}` : '',
      modelHint,
      bodyPreview ? '（完整响应体见 Yunzai 日志）' : ''
    ].filter(Boolean).join('\n')
    throw new Error(combined)
  }

  const choice = resp.data?.choices?.[0]
  //兼容：如果没有 message 但有 delta（流式错误返回）或 content 直接在顶层
  let text = ''
  if (choice?.message?.content) text = choice.message.content
  else if (choice?.delta?.content) text = choice.delta.content
  else if (typeof resp.data?.content === 'string') text = resp.data.content
  const usage = resp.data?.usage || null
  return {
    text,
    usage,
    modelName: m.name || m.model || modelCfgKey
  }
}

