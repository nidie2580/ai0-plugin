import * as cfg from '../config/index.js'

/**
 * AI0-Plugin 图片生成模块
 * 支持 OpenAI 兼容的 /images/generations 接口
 * 流程：AI 在回复中输出 [action:image:提示词] → 插件调用生图API → 下载图片 → 发送到QQ
 */

/** URL 归一化：和 llm.js 中的逻辑一致，确保 base 格式正确 */
function normalizeApiBase(rawBase) {
  if (!rawBase || typeof rawBase !== 'string') return ''
  let base = rawBase.trim()
  if (!base) return ''

  try {
    const u = new URL(base)
    u.search = ''
    u.hash = ''
    base = u.toString()
  } catch (_) {
    base = base.split('?')[0].split('#')[0]
  }

  // 裁剪误写的端点路径
  const re = /(.*?)\/?v(\d+(?:[\.-]\w+)*)?\/?(images\/generations|chat\/completions|models|embeddings)?\/?$/i
  const m = base.match(re)
  if (m && m[3]) {
    const host = m[1]
    const ver = m[2] ? `/v${m[2]}` : ''
    base = host + ver
  }

  base = base.replace(/\/+$/, '')

  // 自动补全 /v1
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
 * @returns {Promise<{ok, url?, b64?, revisedPrompt?, raw?, error?}>}
 */
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
    logger.info(`[ai0-plugin] 图片生成请求：endpoint=${endpoint} model=${model} size=${size} prompt=${prompt.slice(0, 80)}`)

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
      logger.error(`[ai0-plugin] 图片生成 HTTP ${resp.status}: ${errMsg}`)
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

/**
 * 下载图片 URL 为 Buffer
 */
export async function downloadImage(url, maxBytes = 20 * 1024 * 1024) {
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
      // 流式读取并限制总大小，防止恶意 URL 返回超大响应拖垮内存
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
  } catch (err) {
    return { ok: false, error: `下载图片失败: ${err.message}` }
  } finally {
    clearTimeout(timer)
  }
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
