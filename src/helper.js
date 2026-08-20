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

// ----------------- Master detection helpers (platform-first) -----------------

function normalizeId(v) {
  if (v == null) return null
  try { return String(v) } catch (_) { return null }
}

export function getUserId(e) {
  if (!e) return null
  // common event shapes used by QQ adapters: user_id, userId, user?.id, sender?.user_id
  return e.user_id ?? e.userId ?? (e.user && (e.user.id ?? e.user.user_id)) ?? (e.sender && e.sender.user_id) ?? null
}

export function getGroupId(e) {
  if (!e) return null
  return e.group_id ?? e.groupId ?? (e.group && (e.group.id ?? e.group.group_id)) ?? null
}

/**
 * isMaster: 优先使用运行时/事件平台信息判断（e.isMaster / e.master / 平台 owner 列表）���仅在无法判断时退回到 config.permissions.masters
 */
export function isMaster(userId, e = null) {
  const uid = normalizeId(userId)
  if (!uid) return false

  // 1) 事件对象显式声明（最高优先级）
  if (e && ('isMaster' in e)) return !!e.isMaster
  if (e && ('master' in e)) {
    try {
      if (normalizeId(e.master) === uid) return true
    } catch (_) {}
  }

  // 2) 平台/机器人提供的 owners/masters 信息（如 XRK-Yunzai adapter）
  try {
    const bot = global.Bot || global.bot || null
    if (bot) {
      // 常见字段名尝试
      const candidates = []
      if (Array.isArray(bot.masters)) candidates.push(...bot.masters.map(String))
      if (Array.isArray(bot.owners)) candidates.push(...bot.owners.map(String))
      if (bot.master) candidates.push(String(bot.master))
      if (bot.owner) candidates.push(String(bot.owner))
      if (bot.ownerUin) candidates.push(String(bot.ownerUin))
      if (typeof bot.getMaster === 'function') {
        try { const gm = bot.getMaster(); if (gm) candidates.push(String(gm)) } catch (_) {}
      }
      if (candidates.map(String).includes(uid)) return true
    }
  } catch (_) {}

  // 3) 最后退回到配置文件里的 permissions.masters（作为回退/手动覆盖）
  try {
    const cfgMasters = cfg.get('permissions.masters', []) || []
    for (const m of cfgMasters) if (String(m) === uid) return true
  } catch (_) {}

  return false
}

export function listMasters() {
  const out = { event: [], platform: [], config: [] }
  try {
    const cfgMasters = cfg.get('permissions.masters', []) || []
    out.config = cfgMasters.map(String)
  } catch (_) { out.config = [] }
  try {
    const bot = global.Bot || global.bot || null
    if (bot) {
      const platform = []
      if (Array.isArray(bot.masters)) platform.push(...bot.masters.map(String))
      if (Array.isArray(bot.owners)) platform.push(...bot.owners.map(String))
      if (bot.master) platform.push(String(bot.master))
      if (bot.owner) platform.push(String(bot.owner))
      out.platform = Array.from(new Set(platform))
    }
  } catch (_) { out.platform = [] }
  return out.platform.concat(out.config)
}

export function listMasterSources() {
  const sources = { platform: [], config: [] }
  try {
    const bot = global.Bot || global.bot || null
    if (bot) {
      if (Array.isArray(bot.masters)) sources.platform.push(...bot.masters.map(String))
      if (Array.isArray(bot.owners)) sources.platform.push(...bot.owners.map(String))
      if (bot.master) sources.platform.push(String(bot.master))
      if (bot.owner) sources.platform.push(String(bot.owner))
      sources.platform = Array.from(new Set(sources.platform))
    }
  } catch (_) { sources.platform = [] }
  try {
    const cfgMasters = cfg.get('permissions.masters', []) || []
    sources.config = cfgMasters.map(String)
  } catch (_) { sources.config = [] }
  return sources
}

/** 检查机器人是否能给某个用户发私信（best-effort） */
export async function isBotFriend(userId) {
  try {
    const bot = global.Bot || global.bot || null
    if (!bot) return { ok: false, reason: 'bot 未初始化' }
    if (typeof bot.isFriend === 'function') {
      const r = await bot.isFriend(userId)
      return { ok: !!r }
    }
    if (typeof bot.pickFriend === 'function') {
      try {
        const f = await bot.pickFriend(userId)
        return { ok: !!f }
      } catch (err) {
        return { ok: false, reason: err?.message || String(err) }
      }
    }
    // 无明确方法时：无法判断，返回 ok=true 以不阻塞功能（此处可按需改为更保守的默认 false）
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) }
  }
}

/** 通过机器人发送私信（best-effort） */
export async function sendPrivate(userId, message) {
  try {
    const bot = global.Bot || global.bot || null
    if (!bot) throw new Error('bot 未初始化')
    if (typeof bot.sendPrivate === 'function') {
      return await bot.sendPrivate(userId, message)
    }
    if (typeof bot.send === 'function') {
      // 某些适配器 use send({ to, type, message })
      try { return await bot.send({ to: userId, type: 'private', message }) } catch (_) {}
    }
    if (typeof bot.pickFriend === 'function') {
      const f = await bot.pickFriend(userId)
      if (f && typeof f.send === 'function') return await f.send(message)
    }
    throw new Error('适配器不支持私信发送')
  } catch (err) {
    throw err
  }
}

export { cleanupTmpDir, rand6, safeUrlPathname, guessExtFromBuffer, downloadImageViaFetch }
