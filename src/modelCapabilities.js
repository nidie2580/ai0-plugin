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

/* -------------------------------------------------------------------------- */
/*                     /models 元数据 → 能力推断                               */
/* -------------------------------------------------------------------------- */

const ASR_ID_RE = /whisper|asr|transcri|paraformer|sensevoice|funasr|speech-to-text|\bstt\b/
const VISION_ID_RE = /vision|\bvl\b|vl-|gpt-4o|gpt-4\.1|gpt-5|gemini|claude|qwen-vl|qwen2-vl|qwen2\.5-vl/
const IMAGE_ID_RE = /dall-e|dalle|gpt-image|flux|sdxl|stable-diffusion|imagen|midjourney|image-gen/
const VIDEO_ID_RE = /sora|runway|kling|luma|minimax-video|video-gen|cogvideox/

const modelCatalogByBase = new Map()

function blobOf(item) {
  const caps = item?.capabilities || item?.capability || item?.supports || ''
  const endpoints = item?.supported_endpoints || item?.endpoints || item?.permission || ''
  return [
    item?.id, item?.model, item?.name, item?.owned_by, item?.object, item?.type,
    item?.mode, item?.category, item?.architecture,
    typeof caps === 'string' ? caps : JSON.stringify(caps || ''),
    typeof endpoints === 'string' ? endpoints : JSON.stringify(endpoints || ''),
  ].join(' ').toLowerCase()
}

/** 模型 id 是否像语音转写（ASR）模型 */
export function isAsrModelId(id) {
  return ASR_ID_RE.test(String(id || '').toLowerCase())
}

/**
 * 从 /models 条目推断 kind + scopes。
 * kind: chat | asr | image | video
 * 官方接口常只给 id；有 type/capabilities 时优先用元数据。
 */
export function inferModelMeta(item) {
  const id = String(item?.id || item?.model || '').trim()
  if (!id) return null
  const blob = blobOf(item)
  const idLower = id.toLowerCase()

  const capsObj = (item && typeof item.capabilities === 'object' && item.capabilities)
    || (item && typeof item.capability === 'object' && item.capability)
    || null
  const explicit = new Set()
  if (capsObj) {
    if (capsObj.chat || capsObj.completion || capsObj.chat_completions) explicit.add('chat')
    if (capsObj.vision || capsObj.image_in || capsObj.image_input) explicit.add('vision')
    if (capsObj.image_generation || capsObj.image_out || capsObj.images) explicit.add('image')
    if (capsObj.video_generation || capsObj.video) explicit.add('video')
  }

  let kind = 'chat'
  if (capsObj && (capsObj.transcription || capsObj.asr || capsObj.audio_transcriptions || capsObj.speech_to_text)) {
    kind = 'asr'
  } else if (isAsrModelId(id) || /audio\.transcriptions|speech-to-text|\/audio\b/.test(blob)) {
    kind = 'asr'
  } else if (explicit.has('video') || VIDEO_ID_RE.test(idLower) || /\bvideo[-_]?generation\b/.test(blob)) {
    kind = 'video'
  } else if (explicit.has('image') || IMAGE_ID_RE.test(idLower) || /\bimage[-_]?generation\b/.test(blob)) {
    kind = 'image'
  }

  if (kind === 'asr') return { id, kind, scopes: [] }

  const scopes = new Set(explicit)
  if (kind === 'image') scopes.add('image')
  else if (kind === 'video') scopes.add('video')
  else {
    scopes.add('chat')
    if (VISION_ID_RE.test(idLower) || /\bvision\b/.test(blob)) scopes.add('vision')
  }
  if (scopes.has('image') && scopes.has('video')) scopes.delete('video')
  return { id, kind, scopes: SCOPES.filter((s) => scopes.has(s)) }
}

/**
 * 从可用模型 id 列表里挑 ASR 模型。
 * 仅当 preferred 为空或默认 whisper-1 时，才用列表里的 ASR 名称替换。
 */
export function pickAsrModel(ids, preferred = '') {
  const list = (Array.isArray(ids) ? ids : []).map((s) => String(s || '').trim()).filter(Boolean)
  const pref = String(preferred || '').trim()
  const auto = !pref || pref.toLowerCase() === 'whisper-1'
  if (pref && list.includes(pref)) return pref
  if (auto) {
    const hit = list.find((id) => isAsrModelId(id))
    if (hit) return hit
  }
  if (pref) return pref
  return 'whisper-1'
}

/** 记住某 apiBase 最近一次 /models 返回的 id 列表，供 ASR 自动匹配。 */
export function rememberModelCatalog(apiBase, ids) {
  const base = String(apiBase || '').replace(/\/+$/, '')
  if (!base) return
  const list = (Array.isArray(ids) ? ids : []).map((s) => String(s || '').trim()).filter(Boolean)
  if (!list.length) return
  modelCatalogByBase.set(base, list)
}

export function getModelCatalog(apiBase) {
  const base = String(apiBase || '').replace(/\/+$/, '')
  return modelCatalogByBase.get(base) || []
}

export function clearModelCatalog() {
  modelCatalogByBase.clear()
}
