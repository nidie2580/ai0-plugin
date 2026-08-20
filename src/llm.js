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

// ... (omitted earlier functions for brevity) ...

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
      validateStatus: () => true
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
  if (status < 200 || status >= 300) {
    let bodyPreview = ''
    try {
      bodyPreview = typeof resp.data === 'string'
        ? resp.data.slice(0, 2000)
        : JSON.stringify(resp.data || {}).slice(0, 3000)
    } catch (_) {}
    logger.error(`[ai0-plugin] LLM HTTP ${status} ${resp.statusText || ''} | URL=${url}` + (bodyPreview ? `\n响应体:\n${bodyPreview}` : ''))

    // 友好化常见错误
    let extra = ''
    let providerMsg = ''
    try {
      const j = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data
      providerMsg = j?.error?.message || j?.message || j?.msg || ''
    } catch (_) {}

    const lower = String(providerMsg).toLowerCase()
    const looksModelError = /not found the model|model.*not found|permission denied|unknown model|model_not_found|invalid model|does not exist|model.*not allowed|模型.*不存在|模型.*未授权|无权访问.*模型/.test(lower)

    // (原有后续逻辑保持不变)
  }
}
