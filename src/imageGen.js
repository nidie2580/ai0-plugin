import * as cfg from '../config/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedOutboundUrl } from './security.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

export async function generateImage(prompt, opts = {}) {
  const ic = getImageGenConfig()
  if (!ic.enabled) return { ok: false, error: '图片生成功能未启用' }
  if (!ic.apiBase || !ic.apiKey || !ic.model) {
    return { ok: false, error: '图片生成配置不完整（需要 apiBase、apiKey、model）' }
  }

  const base = normalizeApiBase(ic.apiBase)
  const endpoint = `${base}/images/generations`
  const model = opts.model || ic.model || 'dall-e-3'
  const size = opts.size || ic.defaultSize || '1024x1024'
  const quality = opts.quality || ic.quality || 'standard'
  const n = 1
  const timeout = opts.timeout || ic.timeout || 120000

  // SSRF 防护：校验 endpoint
  const check = await isAllowedOutboundUrl(endpoint).catch(() => ({ ok: false, reason: 'endpoint 校验失败' }))
  if (!check.ok) return { ok: false, error: check.reason || '拒绝访问该 API 地址' }

  const body = {
    model,
    prompt,
    n,
    size,
    response_format: 'url'
  }
  if (model.includes('dall-e-3') && quality) {
    body.quality = quality
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    logger.info && logger.info(`[ai0-plugin] 图片生成请求：endpoint=${endpoint} model=${model} size=${size} prompt=${prompt.slice(0, 80)}`)

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ic.apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    clearTimeout(timer)

    const respText = await resp.text()
    let data = null
    try { data = JSON.parse(respText) } catch (_) { data = { raw: respText } }

    if (!resp.ok) {
      const errMsg = data?.error?.message || data?.message || respText.slice(0, 200)
      logger.error && logger.error(`[ai0-plugin] 图片生成 HTTP ${resp.status}: ${errMsg}`)
      return { ok: false, error: `HTTP ${resp.status}: ${errMsg}`, status: resp.status }
    }

    const item = data?.data?.[0]
    if (!item) {
      return { ok: false, error: 'API 返回数据中未找到图片', raw: data }
    }

    return {
      ok: true,
      url: item.url || null,
      b64: item.b64_json || null,
      revisedPrompt: item.revised_prompt || null,
      raw: data
    }
  } catch (err) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      return { ok: false, error: `图片生成超时（${timeout}ms）` }
    }
    return { ok: false, error: err.message || String(err) }
  }
}

export async function downloadImage(url, maxBytes = 20 * 1024 * 1024) {
  const check = await isAllowedOutboundUrl(url).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
  if (!check.ok) return { ok: false, error: check.reason || '拒绝访问该 URL' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)

  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) {
      return { ok: false, error: `下载图片失败: HTTP ${resp.status}` }
    }
    const declared = Number(resp.headers.get('content-length') || 0)
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
          return { ok: false, error: `图片过大(>${Math.round(maxBytes / 1024 / 1024)}MB)已拒绝` }
        }
        chunks.push(value)
      }
      buf = Buffer.concat(chunks)
    } else {
      buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length > maxBytes) return { ok: false, error: '图片过大已拒绝' }
    }
    if (!buf || buf.length < 16) return { ok: false, error: '图片为空或过小' }
    return { ok: true, buffer: buf }
  } catch (err) {
    return { ok: false, error: err.message || String(err) }
  } finally {
    clearTimeout(timer)
  }
}
