import crypto from 'node:crypto'

const tokens = new Map()
const codes = new Map()
const MAGIC_LINKS = new Map()

export const AUTH_CFG = {
  codeExpireMs: 5 * 60 * 1000,
  tokenExpireMs: 2 * 60 * 60 * 1000,
  magicExpireMs: 10 * 60 * 1000
}

function randomId(len = 32) {
  return crypto.randomBytes(len).toString('hex')
}

function randomDigits(len = 6) {
  let s = ''
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10)
  return s
}

function cleanup() {
  const now = Date.now()
  for (const [k, v] of tokens) if (v.expireAt < now) tokens.delete(k)
  for (const [k, v] of codes) if (v.expireAt < now) codes.delete(k)
  for (const [k, v] of MAGIC_LINKS) if (v.expireAt < now) MAGIC_LINKS.delete(k)
}

setInterval(cleanup, 30_000)

export function generateTerminalCode() {
  cleanup()
  const code = randomDigits(6)
  const id = randomId(16)
  codes.set(id, {
    code,
    expireAt: Date.now() + AUTH_CFG.codeExpireMs,
    used: false
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

export function verifyCode(id, code) {
  const rec = codes.get(id)
  if (!rec) return { ok: false, msg: '验证码已过期或不存在' }
  if (rec.used) return { ok: false, msg: '验证码已使用' }
  if (Date.now() > rec.expireAt) {
    codes.delete(id)
    return { ok: false, msg: '验证码已过期' }
  }
  if (String(rec.code) !== String(code)) {
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
    used: false
  })
  return token
}

export function verifyMagicLink(token) {
  const rec = MAGIC_LINKS.get(token)
  if (!rec) return { ok: false, msg: '链接无效或已过期' }
  if (rec.used) return { ok: false, msg: '链接已使用' }
  if (Date.now() > rec.expireAt) {
    MAGIC_LINKS.delete(token)
    return { ok: false, msg: '链接已过期' }
  }
  rec.used = true
  MAGIC_LINKS.delete(token)
  return { ok: true }
}

export function issueSession() {
  const token = randomId(48)
  tokens.set(token, {
    expireAt: Date.now() + AUTH_CFG.tokenExpireMs
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
