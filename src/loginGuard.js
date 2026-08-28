import crypto from 'node:crypto'
import { safeLogger } from './globals.js'

// 登录守卫：多身份二次确认机制。
//   - 首个有效登录成为「主身份」（primaryIdentity）。
//   - 之后任何【异身份】的验证码登录不会直接进入控制台，而是进入待审批队列
//     （前端显示"验证等待页"），同时锁定所有已登录控制台。
//   - 管理员在 XRK-Yunzai 运行终端（stdin，本插件与框架同进程，监听 process.stdin
//     即可收到同一输入，且不抢占框架自身的读取）输入：
//       `继续操作 <10位放行码 或 请求人QQ>`
//     即可放行对应待审批请求，随后解锁控制台。

export const APPROVE_PREFIX = '继续操作'

const pending = new Map()   // pendingId -> { identity, ip, code, approved, createdAt }
let primaryIdentity = null
let stdinInstalled = false
const MAX_PENDING = 50

function randomPendingId() {
  return crypto.randomBytes(12).toString('hex') // 24 hex
}
function randomApproveCode() {
  let s = ''
  for (let i = 0; i < 10; i++) s += crypto.randomInt(10)
  return s
}

/** 清空过期 / 已完成的审批请求（防止内存泄漏） */
function prune() {
  const now = Date.now()
  const TTL = 20 * 60 * 1000 // 待审批 20 分钟过期
  for (const [k, v] of pending) {
    if (v.approved || now - v.createdAt > TTL) pending.delete(k)
  }
}

/** 标记当前主身份（首个通过验证码登录的用户） */
export function setPrimaryIdentity(identity) {
  if (identity == null) return
  if (primaryIdentity == null) primaryIdentity = String(identity)
}

export function getPrimaryIdentity() {
  return primaryIdentity
}

/** 该身份是否为主身份本人 */
export function isPrimary(identity) {
  if (identity == null) return false
  return primaryIdentity != null && String(identity) === String(primaryIdentity)
}

// 无主身份时视为"首次登录"，应允许直接建立。
export function hasPrimary() {
  return primaryIdentity != null
}

/**
 * 创建一个待审批的登录请求（异身份）。
 * @param {{ identity?: string, ip?: string }} opt
 * @returns {{ pendingId: string, code: string, identity: string, ip: string }}
 */
export function createPending({ identity = 'unknown', ip = 'unknown' } = {}) {
  prune()
  const pendingId = randomPendingId()
  const code = randomApproveCode()
  pending.set(pendingId, {
    identity: String(identity || 'unknown'),
    ip: String(ip || 'unknown'),
    code,
    approved: false,
    createdAt: Date.now(),
  })
  // 容量保护：超出上限则淘汰最旧的未审批项
  if (pending.size > MAX_PENDING) {
    const oldest = [...pending.entries()].filter(([, v]) => !v.approved)
      .sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    if (oldest) pending.delete(oldest[0])
  }
  return { pendingId, code, identity: pending.get(pendingId).identity, ip: pending.get(pendingId).ip }
}

/** 查询待审批请求的状态（供"验证等待页"轮询），返回其是否已放行 */
export function isApproved(pendingId) {
  const rec = pending.get(pendingId)
  return rec ? rec.approved : false
}

/** 放行后，批准方持久拿到该请求的 identity / ip，用于给等待者签发会话。
 *  仅在已被放行（approved）时才返回，否则返回 null —— 防止未获批就从 claim 接口越过守卫。 */
export function claimPending(pendingId) {
  const rec = pending.get(pendingId)
  if (!rec || !rec.approved) return null
  return { identity: rec.identity, ip: rec.ip }
}

/**
 * 通过放行凭据审批：支持 10 位放行码 或 请求人 QQ/stdin 身份。
 * @param {string} secret 管理员在终端输入的放行码 / QQ / stdin
 * @returns {{ ok: boolean, approved?: number, msg?: string }}
 */
export function approve(secret) {
  const s = String(secret == null ? '' : secret).trim()
  if (!s) return { ok: false, msg: '请输入放行码或请求人' }
  let matched = 0
  for (const rec of pending.values()) {
    if (rec.approved) continue
    if (rec.code === s || rec.identity === s) {
      rec.approved = true
      matched++
    }
  }
  if (matched) return { ok: true, approved: matched }
  return { ok: false, msg: '无匹配的待审批登录请求（请确认放行码或请求人 QQ）' }
}

/** 是否有人在等待放行（用于控制台锁定） */
export function isLocked() {
  prune()
  for (const rec of pending.values()) if (!rec.approved) return true
  return false
}

/** 当前锁定态与待审批列表（供已登录控制台展示弹窗/锁定） */
export function getStatus() {
  prune()
  const list = []
  for (const [, rec] of pending) {
    list.push({
      identity: rec.identity,
      ip: rec.ip,
      approveCode: rec.code,       // 10 位放行码，展示给主管弹窗
      approved: rec.approved,
      createdAt: rec.createdAt,
    })
  }
  return { locked: isLocked(), primary: primaryIdentity, pending: list }
}

/** 从 stdin 字节流里按行提取审批指令（兼容 `继续操作 xxx` / `#继续操作 xxx`） */
function handleStdinChunk(chunk, bufferState) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk ?? '')
  bufferState.buf += text
  let idx
  while ((idx = bufferState.buf.indexOf('\n')) !== -1) {
    const line = bufferState.buf.slice(0, idx)
    bufferState.buf = bufferState.buf.slice(idx + 1)
    tryHandleStdinLine(line)
  }
  if (bufferState.buf.length > 4096) bufferState.buf = '' // 防异常膨胀
}

/** 从一行文本里提取审批指令 */
function tryHandleStdinLine(line) {
  const text = String(line || '').trim()
  if (!text) return
  // 匹配：可选 "#" / 空白，后跟 继续操作，再跟一个连续的 A-Za-z0-9 凭据（放行码或 QQ/stdin）
  const m = /(?:^|[\s#>])(?:继续操作)\s+([A-Za-z0-9]+)/.exec(text)
  if (!m) return
  const result = approve(m[1])
  if (result.ok) {
    for (const rec of pending.values()) {
      if (rec.approved) safeLogger.mark?.(`[ai0-plugin] 🔓 已放行登录请求 (身份: ${rec.identity})`)
    }
    safeLogger.info?.(`[ai0-plugin] 🔓 登录放行成功，解锁控制台（共放行 ${result.approved} 个请求）`)
  } else {
    safeLogger.warn?.(`[ai0-plugin] 放行失败：${result.msg}`)
  }
}

/** 安装一次 stdin 监听（幂等）。用 data 监听而非 readline，避免与宿主框架抢占/暂停同一 stdin。 */
export function installStdinWatcher() {
  if (stdinInstalled) return
  stdinInstalled = true
  try {
    const state = { buf: '' }
    process.stdin.on('data', (chunk) => handleStdinChunk(chunk, state))
  } catch (_) {
    // 非交互/无 stdin 环境忽略
  }
}