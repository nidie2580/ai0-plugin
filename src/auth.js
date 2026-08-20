import crypto from 'node:crypto'

const tokens = new Map()
const codes = new Map()
const MAGIC_LINKS = new Map()
const rateLimit = new Map()   // key(scope:id) → { count, resetAt }

export const AUTH_CFG = {
  codeExpireMs: 5 * 60 * 1000,
  tokenExpireMs: 2 * 60 * 60 * 1000,
  magicExpireMs: 10 * 60 * 1000,
  // 速率限制：每 IP / 每验证码 id 每 60 秒最多 10 次尝试（防止6位验证码暴力破解）
  rateWindowMs: 60 * 1000,
  rateMaxAttempts: 10,
  // 单个 magic link 校验速率（防止重放撞 token）
  magicRatePerIp: 30,
}

function randomId(len = 32) {
  return crypto.randomBytes(len).toString('hex')
}

function randomDigits(len = 6) {
  let s = ''
  for (let i = 0; i < len; i++) s += crypto.randomInt(10)
  return s
}

function cleanup() {
  const now = Date.now()
  for (const [k, v] of tokens) if (v.expireAt < now) tokens.delete(k)
  for (const [k, v] of codes) if (v.expireAt < now) codes.delete(k)
  for (const [k, v] of MAGIC_LINKS) if (v.expireAt < now) MAGIC_LINKS.delete(k)
  for (const [k, v] of rateLimit) if (v.resetAt < now) rateLimit.delete(k)
}

setInterval(cleanup, 30_000).unref?.()

/** 简单滑动窗口限速：允许 pass=true 放行并计数；超过阈值返回 false。
 *  scope='code' | 'magic' | 'login'；id 是 IP/验证码id 等
 */
export function checkRateLimit(scope, id, maxAttempts = AUTH_CFG.rateMaxAttempts, windowMs = AUTH_CFG.rateWindowMs) {
  const key = `${scope}:${id}`
  const now = Date.now()
  let rec = rateLimit.get(key)
  if (!rec || rec.resetAt < now) {
    rec = { count: 0, resetAt: now + windowMs }
    rateLimit.set(key, rec)
  }
  rec.count += 1
  if (rec.count > maxAttempts) {
    return { ok: false, remain: 0, resetIn: Math.max(0, rec.resetAt - now) }
  }
  return { ok: true, remain: maxAttempts - rec.count, resetIn: Math.max(0, rec.resetAt - now) }
}

export function generateTerminalCode() {
  cleanup()
  const code = randomDigits(6)
  const id = randomId(16)
  codes.set(id, {
    code,
    expireAt: Date.now() + AUTH_CFG.codeExpireMs,
    used: false,
    failCount: 0,     // 单 id 错误次数上限（防止错一次就拉黑整个IP导致正常用户被锁）
  })
  const logLine = `[ai0-plugin] ===== 网页管理验证码：${code} ===== (5分钟内有效)`
  if (typeof logger !== 'undefined') {
    const fn = (typeof logger.mark === 'function') ? logger.mark : (logger.info || console.log)
    fn(logLine)
  } else {
    console.log(logLine)
  }
  return { id, code }
}

export function verifyCode(id, code, clientIp = 'unknown') {
  // 1) 按 IP 限频（跨所有验证码 id 合并计数）
  const ipLimit = checkRateLimit('code-ip', clientIp)
  if (!ipLimit.ok) return { ok: false, msg: `尝试过于频繁，请 ${Math.ceil(ipLimit.resetIn/1000)} 秒后重试` }
  // 2) 按 验证码id 限频
  const idLimit = checkRateLimit('code-id', id, 5, AUTH_CFG.rateWindowMs)
  if (!idLimit.ok) return { ok: false, msg: '验证码尝试次数过多，请稍后重新生成' }

  const rec = codes.get(id)
  if (!rec) return { ok: false, msg: '验证码已过期或不存在' }
  if (rec.used) return { ok: false, msg: '验证码已使用' }
  if (Date.now() > rec.expireAt) {
    codes.delete(id)
    return { ok: false, msg: '验证码已过期' }
  }
  if (String(rec.code) !== String(code)) {
    rec.failCount = (rec.failCount || 0) + 1
    // 同一 id 连续错 5 次 → 作废（防猜）
    if (rec.failCount >= 5) {
      codes.delete(id)
      return { ok: false, msg: '验证码错误次数过多，已作废，请重新生成' }
    }
    return { ok: false, msg: '验证码错误' }
  }
  rec.used = true
  codes.delete(id)
  return { ok: true }
}

export function generateMagicLink() {
  cleanup()
  const token = randomId(40)
  MAGIC_LINKS.set(token, {
    expireAt: Date.now() + AUTH_CFG.magicExpireMs,
    used: false,
    createdAt: Date.now(),
    ip: null,
  })
  return token
}

export function verifyMagicLink(token, clientIp = 'unknown') {
  // magic link token 碰撞空间大（40字节hex），但还是要限频，防枚举
  const ipLimit = checkRateLimit('magic-ip', clientIp, AUTH_CFG.magicRatePerIp, AUTH_CFG.rateWindowMs * 2)
  if (!ipLimit.ok) return { ok: false, msg: `尝试过于频繁，请 ${Math.ceil(ipLimit.resetIn/1000)} 秒后重试` }

  const rec = MAGIC_LINKS.get(token)
  if (!rec) return { ok: false, msg: '链接无效或已过期' }
  if (rec.used) return { ok: false, msg: '链接已使用（免登录链接仅能使用一次）' }
  if (Date.now() > rec.expireAt) {
    MAGIC_LINKS.delete(token)
    return { ok: false, msg: '链接已过期' }
  }
  // 记录首次访问IP（便于审计/追查）
  rec.ip = clientIp
  rec.used = true
  MAGIC_LINKS.delete(token)
  return { ok: true }
}

export function issueSession() {
  const token = randomId(48)
  tokens.set(token, {
    expireAt: Date.now() + AUTH_CFG.tokenExpireMs,
    createdAt: Date.now(),
  })
  return token
}

export function verifySession(token) {
  if (!token) return false
  const rec = tokens.get(token)
  if (!rec) return false
  if (Date.now() > rec.expireAt) {
    tokens.delete(token)
    return false
  }
  rec.expireAt = Date.now() + AUTH_CFG.tokenExpireMs
  return true
}

export function destroySession(token) {
  return tokens.delete(token)
}

export function getPendingCodeId() {
  cleanup()
  for (const [id, v] of codes) if (!v.used) return id
  return null
}
