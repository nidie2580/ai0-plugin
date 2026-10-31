/**
 * 语音转文字（ASR）
 *
 * 链路：语音段 → 下载/解码音频 Buffer →（必要时 ffmpeg 转码）→
 *       POST {apiBase}/audio/transcriptions（multipart，OpenAI 兼容）→ 文本
 *
 * 安全：
 *  - 下载走 security.safeFetchWithRedirects（逐跳 SSRF 校验 + 体积上限）；
 *  - 上传走 security.safeAxiosRequest：官方域名 api.djyun.click 会自动套用
 *    officialHttpsAgent()（证书钉扎），其余域名保持完整 TLS 校验；
 *  - 本地文件仅在魔数可识别为音频时才读取，避免把任意文件外传给第三方接口。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as cfg from '../config/index.js'
import { safeLogger, sanitizeLog } from './globals.js'
import { safeAxiosRequest, safeFetchWithRedirects } from './security.js'
import { normalizeApiBase, getVoiceSegments } from './helper.js'
import { isOfficialKind, OFFICIAL_API_BASE } from './officialApi.js'
import { pickAsrModel, getModelCatalog } from './modelCapabilities.js'

const DEFAULT_MODEL = 'whisper-1'
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
const MAX_TEXT_CHARS = 4000
const MAX_SEGMENTS_PER_MESSAGE = 2
const DOWNLOAD_TIMEOUT_MS = 30000

const QQ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/* -------------------------------------------------------------------------- */
/*                              配置解析                                       */
/* -------------------------------------------------------------------------- */

/**
 * 解析语音输入/ASR 配置。
 * apiBase / apiKey 留空时复用 model.<default> 的凭据：官方模型会落到官方域名，
 * 由 safeAxiosRequest 自动套用钉扎 agent；自定义模型走完整 TLS 校验。
 * @returns {{apiBase:string, apiKey:string, model:string, timeout:number, maxBytes:number, language:string, prompt:string, providerKey:string}|null}
 */
export function resolveAsrConfig(config = cfg.loadConfig()) {
  const voice = (config && config.voiceInput) || {}
  if (voice.enabled === false) return null
  const asr = voice.asr || {}
  const modelCfg = (config && config.model) || {}
  const defKey = modelCfg.default || 'openai-compatible'
  const main = modelCfg[defKey] || {}
  const mainOfficial = isOfficialKind(main.kind)

  const inheritedBase = !String(asr.apiBase || '').trim()
  const inheritedKey = !String(asr.apiKey || '').trim()
  let apiBase = String(asr.apiBase || '').trim()
  let apiKey = String(asr.apiKey || '').trim()
  if (!apiBase) apiBase = mainOfficial ? OFFICIAL_API_BASE : String(main.apiBase || '').trim()
  if (!apiKey) apiKey = String(main.apiKey || '').trim()

  const preferred = String(asr.model || '').trim() || DEFAULT_MODEL
  const rawTimeout = Number(asr.timeout)
  const timeout = Math.max(1000, Math.min(300000, Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS))
  const rawMax = Number(asr.maxBytes)
  const maxBytes = Math.max(64 * 1024, Math.min(DEFAULT_MAX_BYTES, Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_BYTES))

  if (!apiBase || !apiKey) return null
  const normalizedBase = normalizeApiBase(apiBase)
  const model = pickAsrModel(getModelCatalog(normalizedBase), preferred)
  if (!model) return null
  return {
    apiBase: normalizedBase,
    apiKey,
    model,
    timeout,
    maxBytes,
    language: String(asr.language || '').trim(),
    prompt: String(asr.prompt || '').trim(),
    providerKey: (inheritedBase && inheritedKey) ? String(defKey) : '',
  }
}

const catalogProbed = new Set()

/**
 * 目录为空时探测一次 /models，用返回的 ASR 名称替换默认 whisper-1。
 * 可注入 listModels 便于测试。
 */
export async function ensureAsrCatalog(conf, deps = {}) {
  if (!conf?.apiBase) return conf
  if (getModelCatalog(conf.apiBase).length) return resolveAsrConfig() || conf
  const key = String(conf.providerKey || '').trim()
  if (!key || catalogProbed.has(conf.apiBase)) return resolveAsrConfig() || conf
  catalogProbed.add(conf.apiBase)
  try {
    const list = typeof deps.listModels === 'function'
      ? deps.listModels
      : (await import('./llm.js')).listAvailableModels
    await list({ modelKey: key })
  } catch (_) {}
  return resolveAsrConfig() || conf
}

export function clearAsrCatalogProbe() {
  catalogProbed.clear()
}

/* -------------------------------------------------------------------------- */
/*                              音频格式识别                                   */
/* -------------------------------------------------------------------------- */

/**
 * 按魔数识别音频容器。返回 { ext, mime, transcode }：
 * transcode=true 表示常见 ASR 接口不接受该格式，需要先转 mp3。
 * @returns {{ext:string, mime:string, transcode:boolean}|null}
 */
export function detectAudioFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  const lat = (a, b) => buf.slice(a, b).toString('latin1')
  // QQ / 微信语音常用 SILK（适配器带 0x02 前缀；NTQQ 新版带 0x03 前缀）
  if ((buf[0] === 0x02 || buf[0] === 0x03) && lat(1, 10) === '#!SILK_V3') return { ext: 'silk', mime: 'audio/silk', transcode: true }
  if (lat(0, 9).startsWith('#!SILK')) return { ext: 'silk', mime: 'audio/silk', transcode: true }
  if (lat(0, 5) === '#!AMR') return { ext: 'amr', mime: 'audio/amr', transcode: true }
  if (lat(0, 3) === 'ID3') return { ext: 'mp3', mime: 'audio/mpeg', transcode: false }
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg', transcode: false }
  if (lat(0, 4) === 'OggS') return { ext: 'ogg', mime: 'audio/ogg', transcode: false }
  if (lat(4, 8) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4', transcode: false }
  if (lat(0, 4) === 'RIFF' && lat(8, 12) === 'WAVE') return { ext: 'wav', mime: 'audio/wav', transcode: false }
  if (lat(0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac', transcode: false }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'audio/webm', transcode: false }
  return null
}

/* -------------------------------------------------------------------------- */
/*                          ffmpeg 转码（可选）                                */
/* -------------------------------------------------------------------------- */

let _ffmpegPath
let _ffmpegBroken = false

function findFfmpeg() {
  if (_ffmpegPath !== undefined) return _ffmpegPath
  _ffmpegPath = null
  try {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const candidates = [path.join(root, 'ffmpeg.exe'), path.join(root, 'ffmpeg')]
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) { _ffmpegPath = p; return _ffmpegPath }
      } catch (_) {}
    }
  } catch (_) {}
  // 仓库内没有自带二进制时交给 PATH 查找；spawn 失败会置 _ffmpegBroken
  _ffmpegPath = 'ffmpeg'
  return _ffmpegPath
}

async function convertToMp3(buffer, ext, timeoutMs) {
  if (_ffmpegBroken) return null
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) return null
  const dir = path.join(os.tmpdir(), 'ai0-plugin-asr')
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (_) {}
  const tag = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`
  const input = path.join(dir, `voice-${tag}.${ext}`)
  const output = path.join(dir, `voice-${tag}.mp3`)
  try {
    fs.writeFileSync(input, buffer, { mode: 0o600 })
    const ok = await new Promise((resolve) => {
      let settled = false
      let proc = null
      const done = (v) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      const timer = setTimeout(() => {
        try { proc && proc.kill('SIGKILL') } catch (_) {}
        done(false)
      }, Math.min(timeoutMs, 30000))
      timer.unref?.()
      try {
        proc = spawn(
          ffmpeg,
          ['-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-f', 'mp3', '-y', output],
          { windowsHide: true },
        )
      } catch (_) {
        clearTimeout(timer)
        return done(false)
      }
      proc.on('close', (code) => { clearTimeout(timer); done(code === 0) })
      proc.on('error', () => { clearTimeout(timer); _ffmpegBroken = true; done(false) })
    })
    if (!ok) return null
    const out = fs.readFileSync(output)
    return out.length > 0 ? out : null
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 语音转码失败: ${sanitizeLog(err?.message || err)}`)
    return null
  } finally {
    try { fs.unlinkSync(input) } catch (_) {}
    try { fs.unlinkSync(output) } catch (_) {}
  }
}

/* -------------------------------------------------------------------------- */
/*                          音频读取（URL/base64/本地）                        */
/* -------------------------------------------------------------------------- */

function decodeBase64Ref(ref) {
  const m = String(ref || '').match(/^base64:\/\/([\s\S]+)$/)
  if (!m) return null
  try {
    const buf = Buffer.from(m[1], 'base64')
    return buf.length > 0 ? buf : null
  } catch (_) {
    return null
  }
}

function readLocalAudio(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile() || st.size <= 0 || st.size > maxBytes) return null
    const buf = fs.readFileSync(filePath)
    return buf.length > 0 ? buf : null
  } catch (_) {
    return null
  }
}

async function downloadAudio(url, maxBytes) {
  const headers = {}
  try {
    const host = new URL(url).hostname.toLowerCase()
    // QQ 语音 CDN（multimedia.nt.qq.com.cn 等）常要求 Referer/UA
    if (/(^|\.)qq\.com$|(^|\.)qq\.com\.cn$/.test(host)) {
      headers['Referer'] = 'https://qun.qq.com/'
      headers['User-Agent'] = QQ_UA
    }
  } catch (_) {}
  const result = await safeFetchWithRedirects(url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    maxBytes,
    headers,
  })
  if (!result.ok) {
    safeLogger.warn(`[ai0-plugin] 语音下载失败 url=${sanitizeLog(String(url).slice(0, 100))}...: ${sanitizeLog(result && result.error ? result.error : 'unknown')}`)
    return null
  }
  const resp = result.response
  const buf = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data || [])
  if (!buf.length || buf.length > maxBytes) return null
  return buf
}

/**
 * 把单个语音段解析为音频 Buffer。优先 http(s) URL，其次 base64://，最后本地路径。
 * @returns {Promise<Buffer|null>}
 */
// CQ 码转义实体解码：适配器下发的 url 常带实体分隔符（如 &分隔符转义），
// 不解码会让 QQ 多媒体 CDN 返回 400，导致「音频读取失败」且完全无日志。
function decodeCQEntities(s) {
  const A = String.fromCharCode(38)
  return String(s || '')
    .replace(new RegExp(A + '(amp|#38);', 'gi'), A)
    .replace(new RegExp(A + '(quot|#34);', 'gi'), '"')
    .replace(new RegExp(A + '(lt|#60);', 'gi'), '<')
    .replace(new RegExp(A + '(gt|#62);', 'gi'), '>')
    .replace(new RegExp(A + '#91;', 'gi'), '[')
    .replace(new RegExp(A + '#93;', 'gi'), ']')
    .replace(new RegExp(A + '#44;', 'gi'), ',')
}

export async function resolveVoiceSegmentBuffer(seg, maxBytes) {
  if (!seg || typeof seg !== 'object') return null
  const candidates = [seg.url, seg.file, seg.path].map(decodeCQEntities)
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue
    if (/^https?:\/\//i.test(c)) {
      try {
        const buf = await downloadAudio(c, maxBytes)
        if (buf) return buf
      } catch (_) {}
      continue
    }
    const b64 = decodeBase64Ref(c)
    if (b64 && b64.length <= maxBytes) return b64
    const local = readLocalAudio(c, maxBytes)
    if (local) return local
  }
  return null
}

/* -------------------------------------------------------------------------- */
/*                              ASR 请求                                       */
/* -------------------------------------------------------------------------- */

/* ---------------------- SILK 解码（silk-wasm） ----------------------- */

let _silkWasm = undefined   // undefined=未探测, null=不可用, 模块对象=可用
async function loadSilkWasm() {
  if (_silkWasm !== undefined) return _silkWasm
  _silkWasm = null
  try {
    const m = await import('silk-wasm')
    if (m && typeof m.decode === 'function') {
      _silkWasm = m
      safeLogger.info('[ai0-plugin] silk-wasm 已加载，SILK 语音走 WASM 解码(16kHz)')
    }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] silk-wasm 加载失败: ${sanitizeLog(err?.message || err)}`)
  }
  return _silkWasm
}

function pcmToWav(pcm, sampleRate, channels = 1) {
  const bits = 16
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * (bits >> 3), 28)
  h.writeUInt16LE(channels * (bits >> 3), 32)
  h.writeUInt16LE(bits, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** SILK → WAV(16kHz mono s16le)。silk-wasm 的 C 封装硬编码只认 0x02 前缀头
 *  （decoder.c: strncmp "\x02#!SILK_V3"），QQ NTQQ 新版带 0x03 前缀 → 解码前统一规范化。
 *  whisper 特征提取要求 16kHz，故解码目标采样率取 16000。 */
async function silkToWav(buffer) {
  const silk = await loadSilkWasm()
  if (!silk) return null
  try {
    let data = buffer
    const head = data.subarray(1, 10).toString('latin1')
    if ((data[0] === 0x02 || data[0] === 0x03) && head === '#!SILK_V3') {
      data = Buffer.concat([Buffer.from([0x02]), data.subarray(1)])
    } else if (data.subarray(0, 9).toString('latin1') === '#!SILK_V3') {
      data = Buffer.concat([Buffer.from([0x02]), data])
    }
    const { data: pcm } = await silk.decode(new Uint8Array(data), 16000)
    if (!pcm || !pcm.length) return null
    return pcmToWav(Buffer.from(pcm), 16000)
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] silk 解码异常: ${sanitizeLog(err?.message || err)}`)
    return null
  }
}

function buildTranscriptionForm(fields, fileBuf, filename, mime) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || String(v).trim() === '') continue
    form.append(k, String(v))
  }
  form.append('file', new Blob([fileBuf], { type: mime }), filename)
  return form
}

/**
 * 调用 OpenAI 兼容的 /audio/transcriptions 接口转写一段音频。
 * @param {Buffer} buffer
 * @param {{config?:object}} opts
 * @param {{request?:Function}} deps 可注入 request 便于测试
 * @returns {Promise<{ok:true,text:string}|{ok:false,error:string,status?:number}>}
 */
export async function transcribeAudioBuffer(buffer, opts = {}, deps = {}) {
  const request = typeof deps.request === 'function' ? deps.request : safeAxiosRequest
  const conf = opts.config || resolveAsrConfig()
  if (!conf) return { ok: false, error: '语音输入未启用或 ASR 未配置' }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: '空音频' }
  if (buffer.length > conf.maxBytes) {
    return { ok: false, error: `音频过大(>${Math.round(conf.maxBytes / 1024 / 1024)}MB)` }
  }

  let format = detectAudioFormat(buffer)
  if (!format) return { ok: false, error: '无法识别的音频格式' }
  if (format.transcode) {
    // SILK（QQ/微信语音原生格式）：ffmpeg 无 silk 解码器，优先走 silk-wasm（纯 WASM，已验证）
    let handled = false
    if (format.ext === 'silk') {
      const wav = await silkToWav(buffer)
      if (wav) {
        buffer = wav
        format = { ext: 'wav', mime: 'audio/wav', transcode: false }
        handled = true
      } else {
        safeLogger.warn('[ai0-plugin] silk-wasm 不可用，回退 ffmpeg 转码（大概率失败）')
      }
    }
    if (!handled) {
      const mp3 = await convertToMp3(buffer, format.ext, conf.timeout)
      if (!mp3) {
        return { ok: false, error: `${format.ext} 音频转码失败：silk-wasm 不可用且 ffmpeg 不支持该格式` }
      }
      buffer = mp3
      format = { ext: 'mp3', mime: 'audio/mpeg', transcode: false }
    }
  }

  const url = `${conf.apiBase}/audio/transcriptions`
  const form = buildTranscriptionForm(
    {
      model: conf.model,
      language: conf.language,
      prompt: conf.prompt,
      response_format: 'json',
    },
    buffer,
    `voice-${Date.now()}.${format.ext}`,
    format.mime,
  )

  let resp
  let uploadRetried = false
  try {
    resp = await request('post', url, form, {
      headers: { Authorization: `Bearer ${conf.apiKey}`, Accept: 'application/json' },
      timeout: conf.timeout,
      maxBodyLength: conf.maxBytes + 1024 * 1024,
      maxContentLength: 1024 * 1024,
    })
  } catch (err) {
    // CDN 偶发掐断新 TLS 握手（钉扎层「未取得对端证书」）：传输层抖动，新建连接重试一次
    if (err && err.code === 'AI0_OFFICIAL_PIN_MISMATCH' && !uploadRetried) {
      uploadRetried = true
      safeLogger.warn('[ai0-plugin] ASR 上传连接被 CDN 掐断，300ms 后重试一次')
      await new Promise((r) => setTimeout(r, 300))
      try {
        resp = await request('post', url, form, {
          headers: { Authorization: `Bearer ${conf.apiKey}`, Accept: 'application/json' },
          timeout: conf.timeout,
          maxBodyLength: conf.maxBytes + 1024 * 1024,
          maxContentLength: 1024 * 1024,
        })
      } catch (err2) {
        return { ok: false, error: sanitizeLog(err2?.message || err2) }
      }
    } else {
      return { ok: false, error: sanitizeLog(err?.message || err) }
    }
  }

  if (!resp || resp.status < 200 || resp.status >= 300) {
    return { ok: false, error: `ASR 接口返回 HTTP ${resp?.status ?? 'unknown'}`, status: resp?.status || 0 }
  }

  const data = resp.data
  let text = ''
  if (typeof data === 'string') text = data
  else if (data && typeof data === 'object') {
    text = data.text || data.transcript || data.data?.text || ''
  }
  text = String(text || '').trim()
  if (!text) return { ok: false, error: 'ASR 返回空文本' }
  return { ok: true, text: text.slice(0, MAX_TEXT_CHARS) }
}

/* -------------------------------------------------------------------------- */
/*                          消息级转写（带短时缓存）                           */
/* -------------------------------------------------------------------------- */

const transcriptCache = new Map()   // key → { text, at }
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX = 200

function segmentCacheKey(seg) {
  const raw = `${seg?.url || ''}|${seg?.file || ''}|${seg?.path || ''}`
  return raw === '||' ? '' : crypto.createHash('sha256').update(raw).digest('hex')
}

function cacheGet(key) {
  if (!key) return null
  const hit = transcriptCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    transcriptCache.delete(key)
    return null
  }
  return hit.text
}

function cacheSet(key, text) {
  if (!key) return
  if (transcriptCache.size >= CACHE_MAX) {
    const oldest = transcriptCache.keys().next().value
    transcriptCache.delete(oldest)
  }
  transcriptCache.set(key, { text, at: Date.now() })
}

/** 测试用：清空转写缓存 */
export function clearTranscriptCache() {
  transcriptCache.clear()
}

/**
 * 转写消息里的全部语音段（最多 MAX_SEGMENTS_PER_MESSAGE 段）。
 * @returns {Promise<{ok:boolean, texts:string[], text:string, errors:string[]}>}
 * texts 与语音段顺序一一对应，失败位置为空串。
 */
export async function transcribeVoiceMessage(e, deps = {}) {
  const segs = getVoiceSegments(e)
  if (!segs.length) return { ok: true, texts: [], text: '', errors: [] }
  let conf = deps.config || resolveAsrConfig()
  if (!conf) {
    safeLogger.warn('[ai0-plugin] 语音转写跳过：ASR 配置解析为空（未启用/无密钥/模型目录无 ASR 模型）')
    return { ok: false, texts: [], text: '', errors: ['语音输入未启用或 ASR 未配置'] }
  }
  if (!deps.config) conf = await ensureAsrCatalog(conf, deps)

  const texts = []
  const errors = []
  let used = 0
  for (const seg of segs) {
    if (used >= MAX_SEGMENTS_PER_MESSAGE) {
      texts.push('')
      errors.push(`单条消息最多转写 ${MAX_SEGMENTS_PER_MESSAGE} 段语音`)
      continue
    }
    used += 1
    const key = segmentCacheKey(seg)
    const cached = cacheGet(key)
    if (cached) {
      texts.push(cached)
      continue
    }
    try {
      const buf = await resolveVoiceSegmentBuffer(seg, conf.maxBytes)
      if (!buf) {
        texts.push('')
        errors.push('音频读取失败')
        continue
      }
      const r = await transcribeAudioBuffer(buf, { config: conf }, deps)
      if (r.ok) {
        safeLogger.info(`[ai0-plugin] 语音转写成功(第${used}段, 模型=${sanitizeLog(conf.model)}): ${sanitizeLog(r.text.slice(0, 80))}`)
        texts.push(r.text)
        cacheSet(key, r.text)
      } else {
        safeLogger.warn(`[ai0-plugin] 语音转写失败(第${used}段, 模型=${sanitizeLog(conf.model)}): ${sanitizeLog(r.error)}`)
        texts.push('')
        errors.push(r.error)
      }
    } catch (err) {
      texts.push('')
      errors.push(sanitizeLog(err?.message || err))
    }
  }
  return {
    ok: texts.some(Boolean),
    texts,
    text: texts.filter(Boolean).join('\n'),
    errors,
  }
}
