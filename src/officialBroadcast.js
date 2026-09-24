import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeAxiosRequest } from './security.js'
import { safeLogger } from './globals.js'
import { OFFICIAL_API_BASE, isOfficialKind, redactOfficialText } from './officialApi.js'
import { getOrCreateInstanceId } from './officialRegister.js'
import * as cfg from '../config/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CACHE_FILE = path.join(__dirname, '..', 'data', 'official_broadcasts.json')

// 刷新策略：面板打开时刷新一次 + 缓存 10 分钟；失败保留旧缓存并回退展示（stale: true）
export const BROADCAST_REFRESH_MS = 10 * 60 * 1000
const RETRY_THROTTLE_MS = 30_000
const MAX_BROADCASTS = 50
const MEDIA_TYPES = ['text', 'image', 'voice']

// 内存缓存按 cachePath 隔离（测试注入临时路径时互不污染）
const _memCache = new Map()
const _lastTry = new Map()

function readCache(cachePath) {
  if (_memCache.has(cachePath)) return _memCache.get(cachePath)
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
    if (parsed && Array.isArray(parsed.broadcasts)) {
      _memCache.set(cachePath, parsed)
      return parsed
    }
  } catch (_) {}
  return null
}

function writeCache(cachePath, data) {
  _memCache.set(cachePath, data)
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify(data), { mode: 0o600 })
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 平台广播缓存写入失败: ${err.message}`)
  }
}

/** 取官方平台 key（存在多个 official 平台时取第一个，与注册/关联保持一致） */
function officialProviderKey(model) {
  const m = model && typeof model === 'object' ? model : {}
  return Object.keys(m).find((k) => k !== 'default' && isOfficialKind(m[k]?.kind)) || ''
}

function sanitizeText(value, maxLen) {
  return redactOfficialText(String(value == null ? '' : value)).slice(0, maxLen)
}

/** 清洗单条广播：缺 id/标题的丢弃，媒体类型收敛为 text/image/voice，非文本类型的 media_url 必须是 http(s) */
function sanitizeBroadcast(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = Number(raw.id)
  if (!Number.isInteger(id) || id <= 0) return null
  const title = sanitizeText(raw.title, 200).trim()
  if (!title) return null
  let mediaType = String(raw.media_type || raw.mediaType || 'text').trim().toLowerCase()
  if (!MEDIA_TYPES.includes(mediaType)) mediaType = 'text'
  let mediaUrl = sanitizeText(raw.media_url || raw.mediaUrl || '', 1024).trim()
  if (mediaType === 'text' || !/^https?:\/\//i.test(mediaUrl)) mediaUrl = ''
  return {
    id,
    title,
    content: sanitizeText(raw.content, 5000),
    media_type: mediaType,
    media_url: mediaUrl,
    execute_at: String(raw.execute_at || raw.executeAt || '').slice(0, 32),
    created_at: String(raw.created_at || raw.createdAt || '').slice(0, 32),
  }
}

/**
 * 拉取平台广播（仅网页展示用；不投递 QQ 群，不调用 pending/ack）。
 * 返回 { ok, stale, cached?, broadcasts, error?, code? }；
 * 拉取失败时回退旧缓存（stale: true），绝不因平台不可达清空已有数据。
 */
export async function fetchOfficialBroadcasts({ force = false } = {}, deps = {}) {
  const cachePath = deps.cachePath || DEFAULT_CACHE_FILE
  const request = typeof deps.request === 'function' ? deps.request : safeAxiosRequest
  const getInstanceId = typeof deps.getInstanceId === 'function' ? deps.getInstanceId : getOrCreateInstanceId
  const loadConfig = typeof deps.loadConfig === 'function' ? deps.loadConfig : cfg.loadConfig
  const now = typeof deps.now === 'function' ? deps.now : Date.now

  const cached = readCache(cachePath)
  const cachedList = cached ? cached.broadcasts : []
  if (!force && cached && now() - (cached.fetchedAt || 0) < BROADCAST_REFRESH_MS) {
    return { ok: true, stale: false, cached: true, broadcasts: cachedList }
  }
  // 兜底节流：无缓存且刚失败过时，30 秒内不再打平台
  if (!force && now() - (_lastTry.get(cachePath) || 0) < RETRY_THROTTLE_MS) {
    return { ok: !!cached, stale: true, broadcasts: cachedList, error: cached ? undefined : '平台广播暂不可用' }
  }
  _lastTry.set(cachePath, now())

  const providerKey = officialProviderKey(loadConfig()?.model)
  if (!providerKey) {
    return { ok: false, stale: !!cached, broadcasts: cachedList, error: '未配置官方 API' }
  }
  let instanceId = ''
  try { instanceId = String(getInstanceId() || '') } catch (_) {}
  if (!/^[a-f0-9]{32,64}$/i.test(instanceId)) {
    return { ok: false, stale: !!cached, broadcasts: cachedList, error: '实例身份无效，请先完成官方注册' }
  }

  const url = `${OFFICIAL_API_BASE}/plugin/broadcasts`
    + `?instance_id=${encodeURIComponent(instanceId)}&provider_key=${encodeURIComponent(providerKey)}`
  try {
    const resp = await request('get', url, null, {
      headers: { Accept: 'application/json' },
      timeout: 15000,
    })
    const data = (resp?.data && typeof resp.data === 'object') ? resp.data : {}
    if (!resp || Number(resp.status) !== 200 || data.ok === false) {
      const message = redactOfficialText(String(data.message || (resp ? `HTTP ${resp.status}` : '请求失败')))
      return { ok: false, stale: !!cached, broadcasts: cachedList, error: message, code: String(data.code || '') }
    }
    const rawList = Array.isArray(data.broadcasts) ? data.broadcasts : []
    const broadcasts = rawList.map(sanitizeBroadcast).filter(Boolean).slice(0, MAX_BROADCASTS)
    writeCache(cachePath, { fetchedAt: now(), instanceId, providerKey, broadcasts })
    return { ok: true, stale: false, broadcasts }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 拉取平台广播失败: ${redactOfficialText(err?.message || err)}`)
    return { ok: false, stale: !!cached, broadcasts: cachedList, error: '平台暂不可达' }
  }
}

/**
 * 按 id 反查缓存内广播的媒体地址。媒体代理只允许本缓存中出现过的 URL，
 * 禁止把任意 URL 当参数传入（防 SSRF 代理面 + 官方域名外泄）。
 */
export function getBroadcastMediaUrl(id, deps = {}) {
  const cachePath = deps.cachePath || DEFAULT_CACHE_FILE
  const wanted = Number(id)
  if (!Number.isInteger(wanted) || wanted <= 0) return ''
  const item = (readCache(cachePath)?.broadcasts || []).find((b) => b.id === wanted)
  return (item && item.media_url) || ''
}

/** 测试辅助：清空指定缓存路径的内存态（不影响磁盘文件） */
export function __resetBroadcastCache(cachePath) {
  if (cachePath) {
    _memCache.delete(cachePath)
    _lastTry.delete(cachePath)
  } else {
    _memCache.clear()
    _lastTry.clear()
  }
}
