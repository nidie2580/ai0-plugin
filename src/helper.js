import * as cfg from '../config/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAllowedOutboundUrl } from './security.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TMP_DIR = path.join(__dirname, '..', 'data', 'tmp-stickers')
try { if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true }) } catch (_) {}

// 临时文件清理：只保留近 1 小时内的，避免长期运行堆积
let _cleanupRan = 0
function cleanupTmpDir() {
  const now = Date.now()
  if (now - _cleanupRan < 10 * 60 * 1000) return  // 每 10 分钟最多跑一次
  _cleanupRan = now
  try {
    const files = fs.readdirSync(TMP_DIR)
    for (const f of files) {
      if (!f.startsWith('stk-')) continue
      const fp = path.join(TMP_DIR, f)
      try {
        const st = fs.statSync(fp)
        if (now - st.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(fp)
      } catch (_) {}
    }
  } catch (_) {}
}

function rand6() {
  return Math.random().toString(36).slice(2, 8)
}

function safeUrlPathname(u) {
  try { return new URL(u).pathname || '' } catch (_) { return '' }
}

/** 根据 Buffer 的 magic number 判断扩展名（尽量猜，猜不到就 null） */
function guessExtFromBuffer(buf) {
  if (!buf || buf.length < 4) return null
  const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3]
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return '.png'
  if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return '.jpg'
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return '.gif'
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
    if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  }
  if (b0 === 0x42 && b1 === 0x4D) return '.bmp'
  return null
}

async function downloadImageViaFetch(url, maxBytes = 20 * 1024 * 1024) {
  // SSRF 防护：拒绝指向私有/回环/链路本地地址
  const check = await isAllowedOutboundUrl(url).catch(() => ({ ok: false, reason: 'URL 校验失败' }))
  if (!check.ok) return { ok: false, error: check.reason || '拒绝访问私有/回环地址' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    // 不自动跟随重定向，避免由 Location 绕过校验
    const resp = await fetch(url, { signal: controller.signal, redirect: 'manual' })
    // 如果服务器返回 3xx 且带 Location → 拒绝（更安全）
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (loc) return { ok: false, error: '拒绝重定向以防 SSRF' }
      return { ok: false, error: `HTTP ${resp.status}` }
    }
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` }
    const declared = Number(resp.headers.get('content-length') || 0)
    if (declared > maxBytes) return { ok: false, error: `图片过大(${Math.round(declared / 1024 / 1024)}MB)已拒绝` }
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

export { cleanupTmpDir, rand6, safeUrlPathname, guessExtFromBuffer, downloadImageViaFetch }
