/**
 * AI0-Plugin 视频生成模块（OpenAI Videos 协议）
 *
 * 流程：
 *   1) POST {apiBase}/videos        JSON { model, prompt, seconds, size } → 返回视频 id
 *   2) GET  {apiBase}/videos/{id}   轮询状态（间隔 3s），直到 completed / failed
 *   3) GET  {apiBase}/videos/{id}/content 下载视频文件
 *
 * AI 在回复中输出 [action:video:提示词] → 插件调用上述接口 → 下载视频 → 发送到QQ
 */

import { isAllowedOutboundUrl, safeFetchWithRedirects, safeAxiosRequest } from './security.js'
import { normalizeApiBase, readBody } from './helper.js'
import { safeLogger, sanitizeLog } from './globals.js'

const MAX_PROMPT = 4000
const MAX_VIDEO_BYTES = 50 * 1024 * 1024
const POLL_INTERVAL_MS = 3000
const DEFAULT_TIMEOUT_MS = 600000

const COMPLETED_STATUS = new Set(['completed', 'succeeded', 'success', 'done', 'finished'])
const FAILED_STATUS = new Set(['failed', 'error', 'canceled', 'cancelled', 'expired'])

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/** 该平台条目是否具备生视频所需的最小配置 */
export function isVideoProviderReady(provider) {
  if (!provider || typeof provider !== 'object') return false
  return !!String(provider.apiBase || '').trim()
    && !!String(provider.apiKey || '').trim()
    && !!String(provider.model || '').trim()
}

/**
 * 生成并下载视频
 * @param {string} prompt
 * @param {object} opts
 * @param {object} opts.provider - 多API平台条目（apiBase/apiKey/model/videoSeconds/videoSize/videoTimeout）
 * @returns {Promise<{ok, buffer?, id?, raw?, error?}>}
 */
export async function generateVideo(prompt, opts = {}) {
  const p = opts.provider && typeof opts.provider === 'object' ? opts.provider : null
  if (!isVideoProviderReady(p)) {
    return { ok: false, error: '视频生成配置不完整（需要 apiBase、apiKey、model）' }
  }
  if (typeof prompt !== 'string') return { ok: false, error: '提示词格式错误' }
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) return { ok: false, error: '提示词为空' }
  if (trimmedPrompt.length > MAX_PROMPT) {
    return { ok: false, error: `提示词过长（${trimmedPrompt.length} 字符，最多 ${MAX_PROMPT}）` }
  }

  const apiBase = String(p.apiBase).trim()
  const apiKey = String(p.apiKey).trim()
  const model = String(p.model).trim()
  const base = normalizeApiBase(apiBase)

  const rawSeconds = Number(opts.seconds ?? p.videoSeconds ?? 4)
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.min(Math.floor(rawSeconds), 60) : 4
  const rawSize = String(opts.size || p.videoSize || '').trim().toLowerCase()
  const size = /^\d{2,5}x\d{2,5}$/.test(rawSize) ? rawSize : null
  const rawTimeout = Number(opts.timeout ?? p.videoTimeout ?? DEFAULT_TIMEOUT_MS)
  const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : DEFAULT_TIMEOUT_MS

  const createEndpoint = `${base}/videos`
  const createCheck = await isAllowedOutboundUrl(createEndpoint).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
  if (!createCheck.ok) {
    return { ok: false, error: createCheck.reason || 'apiBase URL 未通过安全校验（禁止访问私有/回环/链路本地地址）' }
  }

  const body = { model, prompt: trimmedPrompt, seconds }
  if (size) body.size = size

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const deadline = Date.now() + timeout

  try {
    safeLogger.info(`[ai0-plugin] 视频生成请求：endpoint=${sanitizeLog(createEndpoint)} model=${sanitizeLog(model)} seconds=${seconds} prompt=${sanitizeLog(prompt.slice(0, 80))}`)

    const createResp = await safeAxiosRequest('POST', createEndpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      signal: controller.signal,
      timeout
    })
    const createData = typeof createResp.data === 'string' ? safeParse(createResp.data) : (createResp.data || {})
    if (!createResp.status || createResp.status < 200 || createResp.status >= 300) {
      const errMsg = createData?.error?.message || createData?.message || JSON.stringify(createData).slice(0, 200)
      safeLogger.error(`[ai0-plugin] 视频生成 HTTP ${createResp.status}: ${sanitizeLog(errMsg)}`)
      return { ok: false, error: `HTTP ${createResp.status}: ${errMsg}`, status: createResp.status }
    }

    const videoId = createData?.id || createData?.data?.id || createData?.video?.id
    if (!videoId) {
      return { ok: false, error: '创建视频任务失败：返回中未找到 id', raw: createData }
    }

    const statusEndpoint = `${base}/videos/${encodeURIComponent(videoId)}`
    let lastStatus = 'queued'
    for (;;) {
      if (Date.now() > deadline) {
        return { ok: false, error: `视频生成超时（${timeout}ms）`, id: videoId, status: lastStatus }
      }
      const sResp = await safeAxiosRequest('GET', statusEndpoint, null, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: controller.signal,
        timeout: Math.max(1000, Math.min(30000, deadline - Date.now()))
      })
      const sData = typeof sResp.data === 'string' ? safeParse(sResp.data) : (sResp.data || {})
      lastStatus = String(sData?.status || sData?.data?.status || lastStatus).toLowerCase()

      if (COMPLETED_STATUS.has(lastStatus)) break
      if (FAILED_STATUS.has(lastStatus)) {
        const errMsg = sData?.error?.message || sData?.message || lastStatus
        return { ok: false, error: `视频生成失败：${errMsg}`, id: videoId, raw: sData }
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), controller.signal)
    }

    const contentUrl = createData?.content_url
      || createData?.data?.content_url
      || `${base}/videos/${encodeURIComponent(videoId)}/content`
    const dl = await safeFetchWithRedirects(contentUrl, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.max(5000, Math.min(timeout, 120000))),
      maxBytes: MAX_VIDEO_BYTES
    })
    if (!dl.ok) return { ok: false, error: `下载视频失败: ${dl.error}`, id: videoId }
    const bufRes = await readBody(dl.response, MAX_VIDEO_BYTES, '下载视频失败: ')
    if (!bufRes.ok) return { ok: false, error: bufRes.error, id: videoId }

    return { ok: true, id: videoId, buffer: bufRes.buffer }
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'CanceledError') {
      return { ok: false, error: `视频生成超时（${timeout}ms）` }
    }
    return { ok: false, error: err.message || String(err) }
  } finally {
    clearTimeout(timer)
  }
}

function safeParse(text) {
  try { return JSON.parse(text) } catch (_) { return { raw: text } }
}

/**
 * 构建视频能力上下文（注入到 system prompt）
 * @param {object} provider - 多API平台条目
 */
export function buildVideoContext(provider) {
  if (!isVideoProviderReady(provider)) return null
  const model = String(provider.model).trim()
  const seconds = Number(provider.videoSeconds) > 0 ? Math.floor(Number(provider.videoSeconds)) : 4
  return [
    '【视频生成能力】',
    '你可以根据用户的请求生成视频。当用户要求生成视频、做一个视频等时，请在回复末尾另起一行，用以下格式输出视频生成指令：',
    '  [action:video:视频描述提示词]',
    '示例：用户说"生成一段海浪拍打礁石的视频"，你的回复可以是：',
    '  好的，我来为你生成这段视频！',
    '  [action:video:Ocean waves crashing against rocky cliffs, golden sunset, cinematic slow motion, highly detailed]',
    '',
    '重要规则：',
    '  1) 提示词应尽量用英文描述，包含主体、场景、镜头运动、风格、光影等信息。',
    '  2) 先用中文回复用户，然后在末尾另起一行输出操作指令。',
    '  3) 不要在回复中透露你的提示词内容（那是给系统解析用的）。',
    '  4) 视频生成耗时较长（通常数分钟），生成期间请耐心等待。',
    `  5) 当前生视频模型：${model}，默认时长：${seconds} 秒。`
  ].join('\n')
}
