import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import axios from 'axios'
import * as cfg from '../config/index.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const HISTORY_DIR = path.join(__dirname, '..', 'data', 'history')
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true })

function historyFile(userId, sessionId) {
  const dir = path.join(HISTORY_DIR, String(userId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${sessionId}.json`)
}

export function loadHistory(userId, sessionId) {
  const file = historyFile(userId, sessionId)
  if (!fs.existsSync(file)) return []
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return []
  }
}

export function saveHistory(userId, sessionId, messages) {
  const file = historyFile(userId, sessionId)
  try {
    fs.writeFileSync(file, JSON.stringify(messages, null, 2), 'utf-8')
  } catch (err) {
    logger.error(`[ai0-plugin] 保存历史失败: ${err.message}`)
  }
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

export async function probeModelConnection({ modelKey = null } = {}) {
  const config = cfg.loadConfig()
  const modelCfgKey = modelKey || config.model?.default || 'openai-compatible'
  const m = config.model?.[modelCfgKey] || {}
  if (!m.apiKey || !m.apiBase) {
    return { ok: false, reason: '未配置 apiBase 或 apiKey' }
  }
  const base = normalizeApiBase(m.apiBase, 'openai')
  const modelsUrl = `${base}/models`
  try {
    const t0 = Date.now()
    const resp = await axios.get(modelsUrl, {
      headers: {
        'Authorization': `Bearer ${m.apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true
    })
    const dt = Date.now() - t0
    return {
      ok: true,
      method: 'GET /models',
      status: resp.status,
      url: modelsUrl,
      latencyMs: dt,
      bodySnippet: typeof resp.data === 'string' ? resp.data.slice(0, 200) : JSON.stringify(resp.data || {}).slice(0, 200)
    }
  } catch (e) {
    const s = summarizeAxiosError(e)
    return {
      ok: false,
      method: 'GET /models',
      status: s.status,
      url: modelsUrl,
      code: s.code,
      message: s.message,
      bodySnippet: s.body
    }
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
    logger.error(`[ai0-plugin] LLM 调用异常(${s.method} ${s.url}): code=${s.code} message=${s.message}`)
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
    if (status === 401) extra = '（API Key 错误、未生效或未填 Bearer 前缀）'
    else if (status === 403) extra = '（权限不足：此 key 无该模型权限或账户欠费/被封禁）'
    else if (status === 404) {
      extra = [
        '（接口路径不存在：请确认 apiBase 是否正确。推荐格式：',
        `  Kimi: https://api.moonshot.cn/v1`,
        `  DeepSeek: https://api.deepseek.com/v1`,
        `  通用规则：若服务商要求带 /v1，请把 /v1 放到 apiBase 末尾，不要在 apiBase 里写 /chat/completions）`,
        `  当前实际请求 URL: ${url}`
      ].join('\n')
    } else if (status === 429) extra = '（请求过于频繁 / 速率限制 / 余额不足）'
    else if (status >= 500) extra = '（服务商服务端错误，稍后再试或查看服务状态页）'

    // 解析返回 JSON 里的 error.message
    let providerMsg = ''
    try {
      const j = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data
      providerMsg = j?.error?.message || j?.message || j?.msg || ''
    } catch (_) {}
    const combined = [
      `HTTP ${status} ${resp.statusText || ''}${extra}`,
      providerMsg ? `提供商原始错误：${providerMsg}` : '',
      bodyPreview ? `（完整响应体见 Yunzai 日志）` : ''
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

