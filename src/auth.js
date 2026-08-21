import crypto from 'node:crypto'

const tokens = new Map()
const codes = new Map()
const MAGIC_LINKS = new Map()
const rateLimit = new Map()   // key(scope:id) → { count, resetAt }

// Map 容量上限，防止内存耗尽攻击
const MAX_TOKENS = 10_000
const MAX_CODES = 200
const MAX_MAGIC_LINKS = 200
const MAX_RATE_LIMIT = 10_000

export const AUTH_CFG = {
  codeExpireMs: 5 * 60 * 1000,
  tokenExpireMs: 2 * 60 * 60 * 1000,
  magicExpireMs: 10 * 60 * 1000,
  // 速率限制：每 IP / 每验证码 id 每 60 秒最多 10 次尝试（防止6位验证码暴力破解）
  rateWindowMs: 60 * 1000,
  rateMaxAttempts: 10,
  // 单个 magic link 校验速率（防止重放撞 token）
  magicRatePerIp: 30,
  // magic link 是否绑定首次访问 IP（防止链接被转发到其他 IP 后仍可用）。
  // 注意：若部署在反向代理后且未正确设置 web.trustProxy，所有请求的 clientIp 可能相同，
  // 绑定仍会生效（只是绑到代理 IP）；若用户经常更换出口 IP，可设为 false 仅保留单次使用。
  magicBindIp: true,
}

function randomId(len = 32) {
  return crypto.randomBytes(len).toString('hex')
}

function randomDigits(len = 6) {
  let s = ''
  for (let i = 0; i < len; i++) s += crypto.randomInt(10)
  return s
}

const ALPHANUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function randomAlphanumeric(len = 16) {
  let s = ''
  for (let i = 0; i < len; i++) s += ALPHANUM_CHARS[crypto.randomInt(ALPHANUM_CHARS.length)]
  return s
}

function cleanup() {
  const now = Date.now()
  for (const [k, v] of tokens) if (v.expireAt < now) tokens.delete(k)
  for (const [k, v] of codes) if (v.expireAt < now) codes.delete(k)
  for (const [k, v] of MAGIC_LINKS) if (v.expireAt < now) MAGIC_LINKS.delete(k)
  for (const [k, v] of rateLimit) if (v.resetAt < now) rateLimit.delete(k)
  // 容量保护：过期清理后若仍超限，FIFO 淘汰旧条目
  evictOverCapacity(tokens, MAX_TOKENS)
  evictOverCapacity(codes, MAX_CODES)
  evictOverCapacity(MAGIC_LINKS, MAX_MAGIC_LINKS)
  evictOverCapacity(rateLimit, MAX_RATE_LIMIT)
}

/** 清理超容量 Map：保留最新的一半条目（FIFO 淘汰） */
function evictOverCapacity(map, max) {
  if (map.size <= max) return
  const toDelete = map.size - Math.floor(max / 2)
  let deleted = 0
  for (const k of map.keys()) {
    if (deleted >= toDelete) break
    map.delete(k)
    deleted++
  }
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
  const code = randomAlphanumeric(16)
  const id = randomId(16)
  codes.set(id, {
    code,
    expireAt: Date.now() + AUTH_CFG.codeExpireMs,
    used: false,
    failCount: 0,
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
    // timing-safe 比较，防止时序攻击逐字符猜解
    const a = Buffer.from(String(rec.code), 'utf-8')
    const b = Buffer.from(String(code), 'utf-8')
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      rec.failCount = (rec.failCount || 0) + 1
      // 同一 id 连续错 5 次 → 作废（防猜）
      if (rec.failCount >= 5) {
        codes.delete(id)
        return { ok: false, msg: '验证码错误次数过多，已作废，请重新生成' }
      }
      return { ok: false, msg: '验证码错误' }
    }
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

/** 校验 magic link 是否有效。默认绑定首次访问 IP：链接被转发到其他 IP 后无法再使用。
 *  校验通过后立即标记为已消费（原子操作），消除 verify→consume 之间的竞态窗口。
 *  若后续 session 发放失败，调用方应调用 rollbackMagicLink(token) 回滚。
 *  @returns {ok, msg?, boundIp?}
 */
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
  // IP 绑定：首次访问记录来源 IP；同一链接之后只允许该 IP 使用。
  // 仅在开启 magicBindIp 时生效；关闭时退化为纯单次使用。
  if (AUTH_CFG.magicBindIp) {
    if (rec.ip === null) {
      rec.ip = clientIp
    } else if (rec.ip !== clientIp) {
      return { ok: false, msg: '该链接已绑定其他 IP，请通过生成链接时的 IP 访问' }
    }
  }
  // 原子标记为已消费，消除竞态窗口
  rec.used = true
  return { ok: true, boundIp: rec.ip }
}

/** 回滚 magic link 消费（session 发放失败时调用） */
export function rollbackMagicLink(token) {
  const rec = MAGIC_LINKS.get(token)
  if (rec) { rec.used = false }
}

/** 清理已消费的 magic link 记录 */
export function consumeMagicLink(token) {
  return MAGIC_LINKS.delete(token)
}

export function issueSession(createIp = 'unknown') {
  const token = randomId(48)
  const csrf = randomId(32)
  tokens.set(token, {
    expireAt: Date.now() + AUTH_CFG.tokenExpireMs,
    createdAt: Date.now(),
    csrf,
    createIp,
    lastIp: createIp,
    ipChanges: 0,
  })
  return { token, csrf }
}

export function verifySession(token, currentIp = null) {
  if (!token) return false
  const rec = tokens.get(token)
  if (!rec) return false
  if (Date.now() > rec.expireAt) {
    tokens.delete(token)
    return false
  }
  // IP 变更检测：记录变更次数，供审计使用
  if (currentIp && rec.lastIp && currentIp !== rec.lastIp) {
    rec.ipChanges = (rec.ipChanges || 0) + 1
    rec.lastIp = currentIp
  }
  rec.expireAt = Date.now() + AUTH_CFG.tokenExpireMs
  return true
}

/** 获取 session 关联的 CSRF token（用于 double-submit 校验） */
export function getSessionCsrf(token) {
  if (!token) return null
  const rec = tokens.get(token)
  if (!rec) return null
  return rec.csrf || null
}

export function destroySession(token) {
  return tokens.delete(token)
}

export function getPendingCodeId() {
  cleanup()
  for (const [id, v] of codes) if (!v.used) return id
  return null
}

