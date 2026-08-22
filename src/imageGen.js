import * as cfg from '../config/index.js'
import { isAllowedOutboundUrl, safeFetchWithRedirects, safeAxiosRequest } from './security.js'
import { normalizeApiBase } from './helper.js'
import { safeLogger, sanitizeLog } from './globals.js'

/**
 * AI0-Plugin 图片生成模块
 * 支持 OpenAI 兼容的 /images/generations 接口
 * 流程：AI 在回复中输出 [action:image:提示词] → 插件调用生图API → 下载图片 → 发送到QQ
 */

// —— 每用户每日用量跟踪 ——
const dailyUsage = new Map() // key: `YYYY-MM-DD:userId` → { count, tokens }

function todayKey(userId) {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}:${userId}`
}

/** 检查用户配额，返回 { ok, reason? } */
export function checkUserQuota(userId) {
  if (!userId) return { ok: false, reason: '无法识别用户' }
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
}

// 每天凌晨清理昨日记录
setInterval(() => {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  for (const [k] of dailyUsage) {
    if (!k.startsWith(today + ':')) dailyUsage.delete(k)
  }
}, 3600_000).unref?.()

/** 获取图片生成配置 */
export function getImageGenConfig() {
  const c = cfg.loadConfig()
  return c.imageGen || {}
}

/** 是否启用 */
export function isEnabled() {
  const ic = getImageGenConfig()
  return ic.enabled === true && !!ic.apiBase && !!ic.apiKey && !!ic.model
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
  if (!ic.apiBase || !ic.apiKey || !ic.model) {
    return { ok: false, error: '图片生成配置不完整（需要 apiBase、apiKey、model）' }
  }

  // 用户配额检查
  if (opts.userId) {
    const quota = checkUserQuota(opts.userId)
    if (!quota.ok) return { ok: false, error: quota.reason }
  }

  const base = normalizeApiBase(ic.apiBase)
  const endpoint = `${base}/images/generations`
  const check = await isAllowedOutboundUrl(endpoint).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
  if (!check.ok) {
    return { ok: false, error: check.reason || 'apiBase URL 未通过安全校验（禁止访问私有/回环/链路本地地址）' }
  }
  const model = opts.model || ic.model || 'dall-e-3'
  const size = opts.size || ic.defaultSize || '1024x1024'
  const quality = opts.quality || ic.quality || 'standard'
  const n = 1
  const timeout = opts.timeout || ic.timeout || 120000

  const body = {
    model,
    prompt,
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
    safeLogger.info(`[ai0-plugin] 图片生成请求：endpoint=${endpoint} model=${model} size=${size} prompt=${prompt.slice(0, 80)}`)

    // 使用 safeAxiosRequest 走 DNS pinning + 逐跳 SSRF 校验
    const resp = await safeAxiosRequest('POST', endpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ic.apiKey}`
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
 */
export async function downloadImage(url, maxBytes = 20 * 1024 * 1024) {
  const result = await safeFetchWithRedirects(url, { signal: AbortSignal.timeout(60000) })
  if (!result.ok) return { ok: false, error: `下载图片失败: ${result.error}` }
  return readBody(result.response, maxBytes)
}

/** 流式读取响应体并限制总大小（兼容 fetch Response 和 axios Response） */
async function readBody(resp, maxBytes) {
  // axios Response: headers 是普通对象，data 已是 Buffer/ArrayBuffer
  if (resp.data !== undefined) {
    const buf = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data)
    if (buf.length > maxBytes) return { ok: false, error: `下载图片失败: 图片过大(>${Math.round(maxBytes / 1024 / 1024)}MB)已拒绝` }
    return { ok: true, buffer: buf }
  }
  // fetch Response: headers.get() + body.getReader()
  const declared = Number(resp.headers.get?.('content-length') || resp.headers['content-length'] || 0)
  if (declared > maxBytes) return { ok: false, error: `下载图片失败: 图片过大(${Math.round(declared / 1024 / 1024)}MB)已拒绝` }
  let buf
  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, error: `下载图片失败: 图片过大(>${Math.round(maxBytes / 1024 / 1024)}MB)已拒绝` }
      }
      chunks.push(value)
    }
    buf = Buffer.concat(chunks)
  } else {
    buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > maxBytes) return { ok: false, error: '下载图片失败: 图片过大已拒绝' }
  }
  return { ok: true, buffer: buf }
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
