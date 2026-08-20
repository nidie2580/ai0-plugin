import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import * as cfg from '../config/index.js'
import { isAllowedOutboundUrl } from './security.js'

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
 * 列出可用模型
 */
export async function listAvailableModels({ modelKey = null } = {}) {
  const config = cfg.loadConfig()
  const modelCfgKey = modelKey || config.model?.default || 'openai-compatible'
  const m = config.model?.[modelCfgKey] || {}
  if (!m.apiKey || !m.apiBase) return { ok: false, models: [], error: '未配置 apiBase 或 apiKey' }
  const base = normalizeApiBase(m.apiBase, 'openai')
  const modelsUrl = `${base}/models`

  // SSRF 防护：校验 modelsUrl
  const check = await isAllowedOutboundUrl(modelsUrl).catch(() => ({ ok: false, error: 'URL 校验失败' }))
  if (!check.ok) return { ok: false, models: [], error: check.error || '拒绝访问该 API 地址' }

  try {
    const resp = await axios.get(modelsUrl, {
      headers: {
        'Authorization': `Bearer ${m.apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true,
      maxRedirects: 0
    })
    if (resp.status >= 200 && resp.status < 300) {
      const arr = Array.isArray(resp.data?.data) ? resp.data.data : Array.isArray(resp.data) ? resp.data : []
      const ids = arr.map(x => x?.id).filter(Boolean)
      return { ok: true, status: resp.status, url: modelsUrl, models: ids, count: ids.length }
    }
    if (resp.status >= 300 && resp.status < 400) {
      return { ok: false, status: resp.status, url: modelsUrl, models: [], error: 'API 返回重定向，已被拒绝' }
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

  // SSRF 防护：校验 url
  const check = await isAllowedOutboundUrl(url).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
  if (!check.ok) throw new Error(check.reason || '拒绝访问该 API 地址')

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
      validateStatus: () => true,
      maxRedirects: 0
    })
  } catch (e) {
    const s = summarizeAxiosError(e)
    logger.error && logger.error(`[ai0-plugin] LLM 调用异常(${s.method} ${s.url}): code=${s.code} message=${s.message}`)
    let msg = `请求异常：${s.message}`
    if (s.code === 'ECONNREFUSED') msg = '连接被拒绝：请确认 apiBase 地址/端口正确，且服务已启动。'
    else if (s.code === 'ETIMEDOUT' || s.code === 'ECONNABORTED') msg = '连接超时：apiBase 不可达或网络太慢（可尝试调大 timeout）。'
    else if (s.code === 'ENOTFOUND') msg = 'DNS 解析失败：apiBase 域名无法解析。'
    throw new Error(msg)
  }

  const status = resp.status
  if (status >= 300 && status < 400) {
    throw new Error('模型 API 返回重定向，已被拒绝')
  }
  if (status < 200 || status >= 300) {
    let bodyPreview = ''
    try {
      bodyPreview = typeof resp.data === 'string'
        ? resp.data.slice(0, 2000)
        : JSON.stringify(resp.data || {}).slice(0, 3000)
    } catch (_) {}
    logger.error(`[ai0-plugin] LLM HTTP ${status} ${resp.statusText || ''} | URL=${url}` + (bodyPreview ? `\n响应体:\n${bodyPreview}` : ''))

    let providerMsg = ''
    try {
      const j = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data
      providerMsg = j?.error?.message || j?.message || j?.msg || ''
    } catch (_) {}

    const lower = String(providerMsg).toLowerCase()
    const looksModelError = /not found the model|model.*not found|permission denied|unknown model|model_not_found|invalid model|does not exist|model.*not allowed|模型.*不存在|模型.*未授权|无权访问.*模型/.test(lower)

    // continue with existing error handling (omitted for brevity)
  }
}
