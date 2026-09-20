/**
 * 模型能力作用域（scopes）
 *
 * 每个多API平台条目（config.model.<key>）可声明当前模型的能力集合：
 *   chat   文字对话
 *   vision 接收图片
 *   image  图片生成
 *   video  视频生成
 *
 * 生图与生视频互斥（同一模型不同时具备）。
 * 向后兼容：条目无合法 scopes 时回退旧 vision 布尔；vision:true → ['chat','vision']。
 */

export const SCOPES = ['chat', 'vision', 'image', 'video']
export const GENERATION_SCOPES = ['image', 'video']

const SCOPE_LABELS = {
  chat: '文字对话',
  vision: '接收图片',
  image: '图片生成',
  video: '视频生成',
}

export function scopeLabel(scope) {
  return SCOPE_LABELS[scope] || scope
}

/** 把任意输入归一化为合法 scope 数组（去重、保序、按 SCOPES 顺序） */
export function normalizeScopes(entry) {
  const raw = entry?.scopes
  let list = []
  if (Array.isArray(raw)) {
    list = raw.map((s) => String(s || '').trim().toLowerCase())
  } else if (typeof raw === 'string') {
    list = raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase())
  }
  const seen = new Set(list.filter((s) => SCOPES.includes(s)))
  if (!seen.size) {
    // 向后兼容旧配置：vision:true 视为 chat + vision
    if (entry && entry.vision === true) return ['chat', 'vision']
    return ['chat']
  }
  return SCOPES.filter((s) => seen.has(s))
}

/** 归一化后写入配置的 scopes（仅合法值，保序） */
export function sanitizeScopes(scopes) {
  const list = Array.isArray(scopes)
    ? scopes
    : String(scopes == null ? '' : scopes).split(/[,\s]+/)
  const seen = new Set(list.map((s) => String(s || '').trim().toLowerCase()).filter((s) => SCOPES.includes(s)))
  if (!seen.size) return ['chat']
  return SCOPES.filter((s) => seen.has(s))
}

/**
 * 校验用于保存的 scopes。
 * @returns {{ ok: boolean, scopes?: string[], error?: string }}
 */
export function validateScopes(scopes) {
  const clean = sanitizeScopes(scopes)
  if (clean.includes('image') && clean.includes('video')) {
    return { ok: false, error: '同一模型不可同时具备「图片生成」与「视频生成」' }
  }
  return { ok: true, scopes: clean }
}

export function hasScope(entry, scope) {
  return normalizeScopes(entry).includes(scope)
}

export function isChatModel(entry) {
  return hasScope(entry, 'chat')
}

export function isVisionModel(entry) {
  return hasScope(entry, 'vision')
}

/**
 * 按 config.model 的条目顺序，找第一个具备指定生成能力的条目。
 * @returns {{ key: string, entry: object } | null}
 */
export function findGenerationProvider(config, scope) {
  if (scope !== 'image' && scope !== 'video') return null
  const m = config?.model || {}
  for (const key of Object.keys(m)) {
    if (key === 'default') continue
    const entry = m[key]
    if (!entry || typeof entry !== 'object') continue
    if (!isUsableEntry(entry)) continue
    if (hasScope(entry, scope)) return { key, entry }
  }
  return null
}

/** 该条目是否为可用平台（有 apiKey 与 apiBase） */
export function isUsableEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  return !!String(entry.apiKey || '').trim() && !!String(entry.apiBase || '').trim()
}
