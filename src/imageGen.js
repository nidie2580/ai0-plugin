import * as cfg from '../config/index.js'
import { isAllowedOutboundUrl, safeFetchWithRedirects, safeAxiosRequest } from './security.js'
import { normalizeApiBase, readBody } from './helper.js'
import { safeLogger, sanitizeLog } from './globals.js'

/**
 * AI0-Plugin 图片生成模块
 * 支持 OpenAI 兼容的 /images/generations 接口
 * 流程：AI 在回复中输出 [action:image:提示词] → 插件调用生图API → 下载图片 → 发送到QQ
 */

// —— 每用户每日用量跟踪 ——
const dailyUsage = new Map() // key: `YYYY-MM-DD:userId` → { count, tokens }
// dailyUsage Map 容量上限：海量用户访问时防止内存耗尽
const MAX_DAILY_USAGE_ENTRIES = 10_000

function todayKey(userId) {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}:${userId}`
}

/** FIFO 淘汰超容量 Map 条目（保留较新的一半） */
function evictOverCapacity(map, max) {
  if (map.size <= max) return
  const toDelete = map.size - Math.floor(max / 2)
  let deleted = 0
  for (const k of map.keys()) {
    if (deleted >= toDelete) break
    map.delete(k)
    deleted++
  }
}

/** 检查用户配额，返回 { ok, reason? } */
export function checkUserQuota(userId) {
  if (!userId) return { ok: false, reason: '无法识别用户' }
  // 每次检查前先清理昨日数据 + 容量保护（避免等 1 小时定时器的真空期）
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  for (const k of dailyUsage.keys()) {
    if (!k.startsWith(today + ':')) dailyUsage.delete(k)
  }
  evictOverCapacity(dailyUsage, MAX_DAILY_USAGE_ENTRIES)

  const ic = getImageGenConfig()
  const allowedUsers = ic.allowedUsers || []
  // 白名单检查：非空白名单时，只有列表中的用户可用
  if (allowedUsers.length > 0 && !allowedUsers.includes(String(userId))) {
    return { ok: false, reason: '你没有图片生成权限' }
  }
  // 每日次数限制
  const dailyLimit = ic.dailyLimit || 0
  if (dailyLimit > 0) {
    const key = todayKey(userId)
    const usage = dailyUsage.get(key)
    if (usage && usage.count >= dailyLimit) {
      return { ok: false, reason: `今日生图次数已达上限（${dailyLimit}次/天）` }
    }
  }
  // 每日 token 限制
  const tokenLimit = ic.dailyTokenEstimate || 0
  if (tokenLimit > 0) {
    const key = todayKey(userId)
    const usage = dailyUsage.get(key)
    if (usage && usage.tokens >= tokenLimit) {
      return { ok: false, reason: `今日预估 token 消耗已达上限（${tokenLimit}/天）` }
    }
  }
  return { ok: true }
}

/** 记录一次生图使用（+1000 token 估算） */
export function recordUsage(userId) {
  if (!userId) return
  const key = todayKey(userId)
  const prev = dailyUsage.get(key) || { count: 0, tokens: 0 }
  dailyUsage.set(key, { count: prev.count + 1, tokens: prev.tokens + 1000 })
  evictOverCapacity(dailyUsage, MAX_DAILY_USAGE_ENTRIES)
}

// 每天清理昨日记录（1 小时轮询 + 操作前主动清理双保险）
setInterval(() => {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  for (const [k] of dailyUsage) {
    if (!k.startsWith(today + ':')) dailyUsage.delete(k)
  }
  evictOverCapacity(dailyUsage, MAX_DAILY_USAGE_ENTRIES)
}, 3600_000).unref?.()

/** 获取图片生成配置 */
export function getImageGenConfig() {
  const c = cfg.loadConfig()
  return c.imageGen || {}
}

/** 是否启用 */
export function isEnabled() {
  const ic = getImageGenConfig()
  // 首尾空白不算有效值 —— 与 llm.js 保持一致
  return ic.enabled === true
    && !!String(ic.apiBase || '').trim()
    && !!String(ic.apiKey || '').trim()
    && !!String(ic.model || '').trim()
}

/**
 * 调用生图 API，返回图片 URL 或 base64
 * @param {string} prompt - 生图提示词
 * @param {object} [opts] - 可选参数覆盖默认配置
 * @param {string} [opts.userId] - 用户 QQ 号（用于配额检查）
 * @returns {Promise<{ok, url?, b64?, revisedPrompt?, raw?, error?}>}
 */
export async function generateImage(prompt, opts = {}) {
  const ic = getImageGenConfig()
  if (!ic.enabled) return { ok: false, error: '图片生成功能未启用' }
  // P3-7: 提示词长度防御（与 chatService.parseAndExecuteImageAction 和 /api/test-image 一致）
  //       作为"入口兜底"：即便上层漏了长度限制也不会把超大字符串传外网 API。
  const MAX_PROMPT = 4000
  if (typeof prompt !== 'string') return { ok: false, error: '提示词格式错误' }
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) return { ok: false, error: '提示词为空' }
  if (trimmedPrompt.length > MAX_PROMPT) {
    return { ok: false, error: `提示词过长（${trimmedPrompt.length} 字符，最多 ${MAX_PROMPT}）` }
  }
  // —— P3: apiBase / apiKey / model 输入净化（trim 空白，否则会被当成有效值） ——
  const apiBase = String(ic.apiBase || '').trim()
  const apiKey = String(ic.apiKey || '').trim()
  const modelBase = String(ic.model || '').trim()
  if (!apiBase || !apiKey || !modelBase) {
    return { ok: false, error: '图片生成配置不完整（需要 apiBase、apiKey、model）' }
  }

  // 用户配额检查
  if (opts.userId) {
    const quota = checkUserQuota(opts.userId)
    if (!quota.ok) return { ok: false, error: quota.reason }
  }

  const base = normalizeApiBase(apiBase)
  const endpoint = `${base}/images/generations`
  const check = await isAllowedOutboundUrl(endpoint).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
  if (!check.ok) {
    return { ok: false, error: check.reason || 'apiBase URL 未通过安全校验（禁止访问私有/回环/链路本地地址）' }
  }
  const model = opts.model || modelBase || 'dall-e-3'
  // P3-7: size / quality 白名单校验。防止注入"9999x9999"、"hdXSS"等异常值被外部厂商拒绝浪费请求。
  //       主流 DALL·E 兼容厂商的通用合法尺寸：256/512/1024 正方形、以及 1792x1024 / 1024x1792；
  //       白名单中额外加入一些常见宽高比，兼容国内厂商（含方、横、竖版）。
  const rawSize = String(opts.size || ic.defaultSize || '1024x1024').toLowerCase().trim()
  const ALLOWED_SIZES = new Set([
    '256x256', '512x512', '768x768',
    '1024x1024', '1152x896', '896x1152',
    '1344x768', '768x1344', '1365x1024', '1024x1365',
    '1536x1024', '1024x1536',
    '1792x1024', '1024x1792',
    '2048x2048',
  ])
  if (!ALLOWED_SIZES.has(rawSize)) {
    return { ok: false, error: `非法图片尺寸：${rawSize}（允许的值：${Array.from(ALLOWED_SIZES).join(', ')}）` }
  }
  const size = rawSize
  const rawQuality = String(opts.quality || ic.quality || 'standard').toLowerCase().trim()
  const ALLOWED_QUALITY = new Set(['standard', 'hd'])
  if (!ALLOWED_QUALITY.has(rawQuality)) {
    return { ok: false, error: `非法 quality：${rawQuality}（仅允许 standard / hd）` }
  }
  const quality = rawQuality
  const n = 1
  // 防御式读取：timeout 必须为正有限数，否则兜底 120000，避免负数/NaN 传给上游导致异常
  const rawTimeout = Number(opts.timeout ?? ic.timeout ?? 120000)
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : 120000

  const body = {
    model,
    prompt: trimmedPrompt,
    n,
    size,
    response_format: 'url'
  }
  // 仅 dall-e-3 支持 quality 参数
  if (model.includes('dall-e-3') && quality) {
    body.quality = quality
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    safeLogger.info(`[ai0-plugin] 图片生成请求：endpoint=${sanitizeLog(endpoint)} model=${sanitizeLog(model)} size=${sanitizeLog(size)} prompt=${sanitizeLog(prompt.slice(0, 80))}`)

    // 使用 safeAxiosRequest 走 DNS pinning + 逐跳 SSRF 校验
    const resp = await safeAxiosRequest('POST', endpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal,
      timeout
    })

    clearTimeout(timer)

    const respText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data || {})
    let data = null
    try { data = JSON.parse(respText) } catch (_) { data = { raw: respText } }

    if (!resp.status || resp.status < 200 || resp.status >= 300) {
      const errMsg = data?.error?.message || data?.message || respText.slice(0, 200)
      // sanitizeLog 防止 API 返回的 \r\n 在日志中注入伪造行 / 覆盖前条
      safeLogger.error(`[ai0-plugin] 图片生成 HTTP ${resp.status}: ${sanitizeLog(errMsg)}`)
      return { ok: false, error: `HTTP ${resp.status}: ${errMsg}`, status: resp.status }
    }

    const item = data?.data?.[0]
    if (!item) {
      return { ok: false, error: 'API 返回数据中未找到图片', raw: data }
    }

    // 记录使用量
    if (opts.userId) recordUsage(opts.userId)

    return {
      ok: true,
      url: item.url || null,
      b64: item.b64_json || null,
      revisedPrompt: item.revised_prompt || null,
      raw: data
    }
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError' || err.name === 'CanceledError') {
      return { ok: false, error: `图片生成超时（${timeout}ms）` }
    }
    return { ok: false, error: err.message || String(err) }
  }
}

/**
 * 下载图片 URL 为 Buffer（统一走 safeFetchWithRedirects，含 DNS pinning）
 * readBody 已提取到 helper.js，避免重复实现。
 */
export async function downloadImage(url, maxBytes = 20 * 1024 * 1024) {
  const result = await safeFetchWithRedirects(url, { signal: AbortSignal.timeout(60000) })
  if (!result.ok) return { ok: false, error: `下载图片失败: ${result.error}` }
  return readBody(result.response, maxBytes, '下载图片失败: ')
}

/**
 * 构建图片能力上下文（注入到 system prompt）
 */
export function buildImageContext() {
  if (!isEnabled()) return null

  const ic = getImageGenConfig()
  return [
    '【图片生成能力】',
    '你可以根据用户的请求生成图片。当用户要求画图、生成图片、画一幅画等时，请在回复末尾另起一行，用以下格式输出图片生成指令：',
    '  [action:image:图片描述提示词]',
    '示例：用户说"画一只可爱的猫咪"，你的回复可以是：',
    '  好的，我来为你画一只可爱的猫咪！',
    '  [action:image:A cute fluffy kitten with big eyes, sitting on a windowsill with sunlight streaming in, soft pastel colors, digital art style]',
    '',
    '重要规则：',
    '  1) 提示词应尽量用英文描述，这样生成效果更好（除非用户明确要求中文风格）。',
    '  2) 提示词要详细、具体，包含主体、场景、风格、色调等信息。',
    '  3) 先用中文回复用户，然后在末尾另起一行输出操作指令。',
    '  4) 不要在回复中透露你的提示词内容（那是给系统解析用的）。',
    `  5) 当前生图模型：${ic.model}，默认尺寸：${ic.defaultSize || '1024x1024'}。`
  ].join('\n')
}
