import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as cfg from '../config/index.js'
import { safeAxiosRequest, isAllowedOutboundUrl } from './security.js'
import { normalizeApiBase } from './helper.js'
import { safeLogger } from './globals.js'

export { normalizeApiBase }

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
const USER_QUEUE_MAX = 500                   // 最大缓存用户队列数，超出时淘汰最早

function runInUserQueue(userId, fn) {
  // LRU 淘汰：超出上限时移除最早的条目
  if (userQueues.size >= USER_QUEUE_MAX && !userQueues.has(userId)) {
    const oldest = userQueues.keys().next().value
    userQueues.delete(oldest)
  }
  const prev = userQueues.get(userId) || Promise.resolve()
  const next = prev.then(() => Promise.resolve().then(fn)).catch(() => {})
  userQueues.set(userId, next)
  // 队列执行完毕后清理引用，避免 Promise 链无限增长
  next.finally(() => {
    if (userQueues.get(userId) === next) userQueues.delete(userId)
  })
  return next
}

function historyFile(userId, sessionId) {
  // userId 格式校验：1-20位纯数字，防止路径遍历
  const safeUserId = String(userId)
  if (!/^\d{1,20}$/.test(safeUserId)) {
    throw new Error('invalid userId format')
  }
  const dir = path.join(HISTORY_DIR, safeUserId)
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
            const tmp = file + '.tmp.' + crypto.randomBytes(16).toString('hex')
            fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), { encoding: 'utf-8', mode: 0o600 })
            fs.renameSync(tmp, file)
            safeLogger.warn(`[ai0-plugin] ${file} 已损坏，已从 .bak 恢复`)
          } catch (_) {}
          return arr
        }
      } catch (_) {}
      safeLogger.warn(`[ai0-plugin] 会话历史损坏且无备份，已丢弃: ${file} (${err.message})`)
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

  return runInUserQueue(userId, async () => {
    const latest = inflightSaves.get(key)
    if (latest === undefined) return
    inflightSaves.delete(key)

    const file = historyFile(userId, sessionId)
    const tmp = file + `.tmp.${crypto.randomBytes(16).toString('hex')}`
    const bak = file + '.bak'
    try {
      const data = JSON.stringify(latest, null, 2)
      // M5: 会话文件大小上限 512KB，超过则截断旧消息
      const MAX_HISTORY_BYTES = 512 * 1024
      let trimmedData = data
      if (Buffer.byteLength(data, 'utf-8') > MAX_HISTORY_BYTES) {
        // 保留最后 contextSize*2 条消息
        const ctxSize = cfg.get('chat.contextSize', 10)
        const keep = latest.slice(-(ctxSize * 2 + 2))
        trimmedData = JSON.stringify(keep, null, 2)
        safeLogger.warn(`[ai0-plugin] 会话历史超过 512KB，已截断至 ${keep.length} 条消息`)
      }
      // 先写到 tmp
      fs.writeFileSync(tmp, trimmedData, { encoding: 'utf-8', mode: 0o600 })
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
      safeLogger.error(`[ai0-plugin] 保存历史失败: ${err.message}`)
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

// ====== 通用 URL / 请求规范化（normalizeApiBase 已提取到 helper.js） ======

export function buildEndpoint(base, pathSegment = '/chat/completions') {
  const b = normalizeApiBase(base).replace(/\/+$/, '')
  const seg = pathSegment.startsWith('/') ? pathSegment : `/${pathSegment}`
  return b + seg
}

function redactKey(key) {
  if (!key || typeof key !== 'string' || /^\s*$/.test(key)) return 'apiKey=未设置'
  return 'apiKey=已设置'
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
  // 脱敏：不输出 Authorization 头，防止 API Key 泄露到日志
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
    const resp = await safeAxiosRequest('get', modelsUrl, null, {
      headers: {
        'Authorization': `Bearer ${m.apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 15000,
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

  if (!(await isAllowedOutboundUrl(url)).ok) {
    throw new Error('apiBase URL 未通过安全校验（禁止访问私有/回环/链路本地地址）')
  }

  const model = String(m.model || 'gpt-3.5-turbo').trim() || 'gpt-3.5-turbo'
  const body = {
    model,
    messages,
    temperature: m.temperature ?? 0.8,
    max_tokens: m.maxTokens ?? 2000
  }

  if (typeof logger !== 'undefined') {
    safeLogger.info(`[ai0-plugin] LLM 请求：base(原始)=${rawBase}  base(归一化)=${normalizedBase}  url=${url}  model=${model}  apiKey=${redactKey(m.apiKey)}`)
  }

  let resp
  try {
    resp = await safeAxiosRequest('post', url, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${m.apiKey}`
      },
      timeout: m.timeout ?? 60000,
      signal,
    })
  } catch (e) {
    const s = summarizeAxiosError(e)
    safeLogger.error(`[ai0-plugin] LLM 调用异常(${s.method} ${s.url}): code=${s.code} message=${s.message}`)
    let msg = '请求异常，请检查模型配置或稍后重试'
    if (s.code === 'ECONNREFUSED') msg = '连接被拒绝：请确认 apiBase 地址/端口正确，且服务已启动。'
    else if (s.code === 'ETIMEDOUT' || s.code === 'ECONNABORTED') msg = '连接超时：请稍后重试或调大 timeout。'
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
    safeLogger.error(`[ai0-plugin] LLM HTTP ${status} ${resp.statusText || ''} | URL=${url}` + (bodyPreview ? `\n响应体:\n${bodyPreview}` : ''))

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
        : '（接口路径不存在：请确认 apiBase 是否正确）'
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

