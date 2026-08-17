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

  const url = `${m.apiBase.replace(/\/$/, '')}/chat/completions`
  const body = {
    model: m.model || 'gpt-3.5-turbo',
    messages,
    temperature: m.temperature ?? 0.8,
    max_tokens: m.maxTokens ?? 2000
  }

  const resp = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${m.apiKey}`
    },
    timeout: m.timeout ?? 60000,
    signal
  })

  const choice = resp.data?.choices?.[0]
  const text = choice?.message?.content || ''
  const usage = resp.data?.usage || null
  return {
    text,
    usage,
    modelName: m.name || m.model || modelCfgKey
  }
}
