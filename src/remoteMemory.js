/**
 * 远端长期记忆同步（API 平台 /v1/memory）
 *
 * 设计原则：全程静默。任何网络/鉴权/配额错误都不影响本地记忆的读写。
 * 端点：<apiBase 去掉 /v1>/v1/memory，鉴权用主人自己的平台 API Key（Authorization: Bearer）。
 */
import * as cfg from '../config/index.js'

const TIMEOUT_MS = 8000

function endpoint() {
  const apiBase = String(cfg.get('model.official.apiBase', '') || '').trim().replace(/\/+$/, '')
  if (!apiBase) return ''
  return apiBase.replace(/\/v1$/, '') + '/v1/memory'
}

function apiKey() {
  return String(cfg.get('model.official.apiKey', '') || '').trim()
}

export function enabled() {
  return !!(endpoint() && apiKey())
}

async function call(path = '', init = {}) {
  const url = endpoint() + path
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    })
    const data = await res.json().catch(() => null)
    return { ok: res.ok && !!data && data.ok !== false, status: res.status, data }
  } catch {
    return { ok: false, status: 0, data: null }
  } finally {
    clearTimeout(timer)
  }
}

/** 写入一条记忆；key 里带正文前缀，便于远端按关键词检索（列表接口只返回 key） */
export async function push(scope, text, tags = []) {
  if (!enabled()) return false
  const body = {
    key: `${scope}: ${String(text).replace(/\s+/g, ' ').slice(0, 80)}`,
    content: String(text),
    tags: [scope, ...tags].slice(0, 8),
  }
  const r = await call('', { method: 'POST', body: JSON.stringify(body) })
  if (!r.ok && r.status) console.log(`[memory] 远端写入失败 status=${r.status} code=${r.data?.code || '-'}`)
  return r.ok
}

/** 远端检索：先拉列表按 key 匹配，再按命中项取正文（最多 limit 条） */
export async function search(query, { limit = 5 } = {}) {
  if (!enabled()) return []
  const q = String(query || '').toLowerCase()
  if (!q) return []
  const r = await call('')
  if (!r.ok || !Array.isArray(r.data?.list)) return []
  const hits = r.data.list
    .filter((it) => String(it.key || '').toLowerCase().includes(q))
    .slice(0, Math.max(1, limit))
  const out = []
  for (const it of hits) {
    const d = await call('/' + encodeURIComponent(it.id))
    const text = d.ok ? String(d.data?.content || '').trim() : ''
    if (text) out.push(text.slice(0, 160))
  }
  return out
}

/** 删除远端匹配项（可按 scope 前缀限定） */
export async function removeMatching(query, scope = '') {
  if (!enabled()) return 0
  const q = String(query || '').toLowerCase()
  if (!q) return 0
  const r = await call('')
  if (!r.ok || !Array.isArray(r.data?.list)) return 0
  let n = 0
  for (const it of r.data.list) {
    const k = String(it.key || '')
    if (!k.toLowerCase().includes(q)) continue
    if (scope && !k.startsWith(scope)) continue
    const d = await call('/' + encodeURIComponent(it.id), { method: 'DELETE' })
    if (d.ok) n++
  }
  return n
}

/** 远端条数（用于 #查看记忆 附注，失败返回 -1） */
export async function stats() {
  if (!enabled()) return { count: -1, used: 0, quota: 0 }
  const r = await call('')
  if (!r.ok || !Array.isArray(r.data?.list)) return { count: -1, used: 0, quota: 0 }
  const q = await call('/quota')
  return {
    count: r.data.list.length,
    used: Number(q.data?.used || 0),
    quota: Number(q.data?.quota || 0),
  }
}
