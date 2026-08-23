import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ES module 中无 __dirname 内置量，自行推导 src/auth.js 所在目录
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 会话持久化文件：进程重启后已登录用户无需重新登录
const DATA_DIR = path.join(__dirname, '..', 'data')
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json')

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

// —— P3: 会话持久化 ——
// tokens (session token) 和 MAGIC_LINKS 写入磁盘；codes / rateLimit 是短生命周期，
// 重启自然重置不会泄露也不会影响安全。load 在启动时执行一次；save 在每次 cleanup
// 周期结束后异步刷盘，以及进程退出前尽力刷一次。
//
// — P3-3: 明文存储 → AES-256-GCM 加密存储 —
// 即便 sessions.json 权限已设为 0o600，若该分区被备份/挂到镜像盘，或被另一个
// 0o600 的目录做 tar 泄露，明文 csrf / session 仍可被复用。因此：
//   - 首次启动时在 DATA_DIR 下生成 sessions.key（256-bit，0o600）
//   - payload JSON → AES-256-GCM(iv+tag+ciphertext) → base64 串写回 sessions.json
//   - 字段 {v:1, blob}，便于未来换算法或加版本号
// 若密钥丢失或损坏：等价于"所有 session 失效"，用户重新登录即可（不丢历史）。
const KEY_FILE = path.join(DATA_DIR, 'sessions.key')
const CRYPT_V = 1
const CIPHER = 'aes-256-gcm'

function loadSessionKey() {
  try {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE)
      if (raw.length === 32) return raw
    }
    const k = crypto.randomBytes(32)
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    // 先写 .tmp 再 rename，文件权限设 0o600，避免密钥被同机其他可读账号看到
    const tmp = KEY_FILE + '.tmp'
    fs.writeFileSync(tmp, k, { mode: 0o600 })
    fs.renameSync(tmp, KEY_FILE)
    try { fs.chmodSync(KEY_FILE, 0o600) } catch (_) {}
    return k
  } catch (_) {
    return null
  }
}
let SESSION_KEY = null
function getSessionKey() {
  if (SESSION_KEY === null) SESSION_KEY = loadSessionKey()
  return SESSION_KEY
}
function encryptJson(obj) {
  const key = getSessionKey()
  if (!key) return null
  const plain = Buffer.from(JSON.stringify(obj), 'utf-8')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(CIPHER, key, iv)
  const c1 = cipher.update(plain)
  const c2 = cipher.final()
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([iv, tag, c1, c2]).toString('base64')
  return { v: CRYPT_V, blob }
}
function decryptJson(enc) {
  if (!enc || typeof enc !== 'object') return null
  if (enc.v !== CRYPT_V || typeof enc.blob !== 'string') return null
  const key = getSessionKey()
  if (!key) return null
  try {
    const raw = Buffer.from(enc.blob, 'base64')
    if (raw.length < 12 + 16) return null
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const ct = raw.subarray(28)
    const decipher = crypto.createDecipheriv(CIPHER, key, iv)
    decipher.setAuthTag(tag)
    const p1 = decipher.update(ct)
    const p2 = decipher.final()
    return JSON.parse(Buffer.concat([p1, p2]).toString('utf-8'))
  } catch (_) {
    return null
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return
    // 优先尝试新版本加密存储；失败回退到旧版明文 JSON（兼容前一次推送产生的 sessions.json）
    let parsed = null
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8')
    try {
      const enc = JSON.parse(raw)
      if (enc && typeof enc === 'object' && enc.v === CRYPT_V && typeof enc.blob === 'string') {
        parsed = decryptJson(enc)
      } else {
        parsed = enc  // 旧版明文
      }
    } catch (_) { parsed = null }
    if (!parsed || typeof parsed !== 'object') return
    const now = Date.now()
    // 7 天绝对上限，与 verifySession 保持一致，避免加载远古 session
    const ABSOLUTE_MAX_MS = 7 * 24 * 60 * 60 * 1000
    if (Array.isArray(parsed.tokens)) {
      for (const [k, v] of parsed.tokens) {
        if (!v || typeof v !== 'object') continue
        if (typeof v.expireAt !== 'number' || v.expireAt < now) continue
        if (typeof v.createdAt === 'number' && now - v.createdAt > ABSOLUTE_MAX_MS) continue
        tokens.set(k, v)
      }
    }
    if (Array.isArray(parsed.magicLinks)) {
      for (const [k, v] of parsed.magicLinks) {
        if (!v || typeof v !== 'object') continue
        if (typeof v.expireAt !== 'number' || v.expireAt < now) continue
        MAGIC_LINKS.set(k, v)
      }
    }
  } catch (err) {
    // 加载失败仅记录（可能文件损坏 / 首次运行），不阻塞启动
    try {
      const { safeLogger, sanitizeLog } = await_import_global_error_only()
      safeLogger?.(`[ai0-plugin] 加载会话持久化文件失败: ${sanitizeLog?.(err?.message) || err?.message}`)
    } catch (_) {}
  }
}
// 不 import globals.js 顶部（避免循环依赖）；错误路径内只做弱引用。正常路径无日志。
function await_import_global_error_only() { return { safeLogger: (...a) => console.error(...a), sanitizeLog: x => String(x ?? '') } }

let saveTimer = null
let lastSaveSucceeded = true
function saveSessions() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    const payload = {
      tokens: Array.from(tokens.entries()),
      magicLinks: Array.from(MAGIC_LINKS.entries()),
    }
    // P2-2: 密钥无法加载/加密失败时 **绝不** 退化为明文，防止 API Key/会话在用户不知情下泄漏。
    // 仅记录 ERROR；用户看到登录"突然失效"或 #ai诊断 时能发现 sessions.key 权限/损坏问题。
    const out = encryptJson(payload)
    if (!out) {
      const msg = '[ai0-plugin] 会话加密失败（sessions.key 权限/磁盘异常？），已拒绝明文落盘。请修复 data/sessions.key 后重启。'
      try {
        const { safeLogger } = await_import_global_error_only()
        safeLogger.error?.(msg)
      } catch (_) { console.error(msg) }
      // 仅在第一次失败时报警；后续持续失败也不刷屏（保留一个 flag 便于 #ai诊断 暴露）
      if (lastSaveSucceeded) { lastSaveSucceeded = false; try { process.emitWarning?.(msg) } catch (_) {} }
      return false
    }
    lastSaveSucceeded = true
    // 临时文件 + rename，保证原子写（断电/崩溃不会留下半写的 JSON）
    const tmp = SESSION_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
    fs.renameSync(tmp, SESSION_FILE)
    return true
  } catch (err) {
    const msg = `[ai0-plugin] 会话持久化写入失败: ${String(err?.message || err)}`
    try {
      const { safeLogger } = await_import_global_error_only()
      safeLogger.error?.(msg)
    } catch (_) { console.error(msg) }
    return false
  }
}

// 启动时加载（在 cleanup timer 前执行，首次 cleanup 会立刻剔除过期/超限）
loadSessions()
// 每 30 秒：先 cleanup，再异步 save（节流）
setInterval(() => {
  cleanup()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveSessions, 200).unref?.()
}, 30_000).unref?.()
// 优雅退出前尽力刷盘（SIGTERM / SIGINT；SIGKILL 无法捕获）
const onShutdown = () => { try { saveSessions() } catch (_) {} }
try {
  process.on('SIGTERM', onShutdown)
  process.on('SIGINT', onShutdown)
  process.on('exit', onShutdown)
} catch (_) {}

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

export function generateTerminalCode(clientIp = 'unknown') {
  cleanup()
  const code = randomAlphanumeric(16)
  const id = randomId(16)
  codes.set(id, {
    code,
    expireAt: Date.now() + AUTH_CFG.codeExpireMs,
    used: false,
    failCount: 0,
    createdIp: clientIp,
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
  // — 发现D 修复：时序均衡 —
  // 在任何快速返回前都先做一次等价的 timingSafeEqual 比较（结果不使用），
  // 让"ID 不存在 / 已使用 / 已过期"与"验证码错误"三条路径的响应时间一致，
  // 防止攻击者通过响应时间差异枚举有效 ID。
  const codeBuf = Buffer.from(String(code), 'utf-8')
  const dummyCodeBuf = Buffer.from('x'.repeat(16), 'utf-8') // 固定 16 字节假值（与真实 code 等长）
  if (rec) {
    // 真实路径：走正常 timingSafeEqual
  } else {
    // 无 rec → 仍执行一次 timingSafeEqual 均衡时间（结果必然为 false）
    if (codeBuf.length === dummyCodeBuf.length) {
      try { crypto.timingSafeEqual(codeBuf, dummyCodeBuf) } catch (_) {}
    }
    return { ok: false, msg: '验证码已过期或不存在' }
  }
  if (rec.used) {
    if (codeBuf.length === dummyCodeBuf.length) {
      try { crypto.timingSafeEqual(codeBuf, dummyCodeBuf) } catch (_) {}
    }
    return { ok: false, msg: '验证码已使用' }
  }
  if (Date.now() > rec.expireAt) {
    codes.delete(id)
    if (codeBuf.length === dummyCodeBuf.length) {
      try { crypto.timingSafeEqual(codeBuf, dummyCodeBuf) } catch (_) {}
    }
    return { ok: false, msg: '验证码已过期' }
  }
  // IP 绑定校验：仅当生成时已绑定真实 IP（createdIp 非 'unknown'）才强制一致。
  // QQ 生成场景（#ai验证码 / standalone-web）拿不到 Web clientIp，createdIp='unknown'，
  // 此时【不绑定、不校验】——退化为纯单次使用 + rate limit + 5 次错误作废防护。
  // 切勿在 code 校验前用错误 code 绑定 IP：那会让攻击者通过 getPendingCodeId() 拿到 id 后
  // 抢先绑定自己的 IP，导致主人用正确 code 也被拒（IP 劫持 DoS）。
  if (rec.createdIp && rec.createdIp !== 'unknown' && rec.createdIp !== clientIp) {
    if (codeBuf.length === dummyCodeBuf.length) {
      try { crypto.timingSafeEqual(codeBuf, dummyCodeBuf) } catch (_) {}
    }
    return { ok: false, msg: '验证码与当前 IP 不匹配' }
  }
  // 始终走 timing-safe 比较，不使用前置明文 !== 短路（防止时序泄漏）
  const a = Buffer.from(String(rec.code), 'utf-8')
  const timingSafeOk = a.length === codeBuf.length && crypto.timingSafeEqual(a, codeBuf)
  if (!timingSafeOk) {
    rec.failCount = (rec.failCount || 0) + 1
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

/** 校验 magic link 是否有效。默认绑定首次访问 IP：链接被转发到其他 IP 后无法再使用。
 *  校验通过后立即标记为已消费（原子操作），消除 verify→consume 之间的竞态窗口。
 *  若后续 session 发放失败，调用方应调用 rollbackMagicLink(token) 回滚。
 *  @returns {ok, msg?, boundIp?}
 */
export function verifyMagicLink(token, clientIp = 'unknown') {
  // magic link token 碰撞空间大（40字节hex），但还是要限频，防枚举
  const ipLimit = checkRateLimit('magic-ip', clientIp, AUTH_CFG.magicRatePerIp, AUTH_CFG.rateWindowMs * 2)
  if (!ipLimit.ok) return { ok: false, msg: `尝试过于频繁，请 ${Math.ceil(ipLimit.resetIn/1000)} 秒后重试` }

  // —— 时序均衡（P2 修复）：任何快速失败路径都先执行一次恒长 timingSafeEqual，——
  // 让 "token 不存在 / 已使用 / 已过期 / IP 不匹配" 与 "验证通过" 五条路径响应时间尽量一致，
  // 防止攻击者通过响应时间差异枚举有效的 magic token。
  const tokenBuf = Buffer.from(String(token || ''), 'utf-8')
  const dummyBuf = Buffer.from('x'.repeat(40), 'utf-8') // 与 token 等长假值（40 字节 hex）
  const equalize = () => {
    if (tokenBuf.length === dummyBuf.length) {
      try { crypto.timingSafeEqual(tokenBuf, dummyBuf) } catch (_) {}
    }
  }

  const rec = MAGIC_LINKS.get(token)
  if (!rec) { equalize(); return { ok: false, msg: '链接无效或已过期' } }
  if (rec.used) { equalize(); return { ok: false, msg: '链接已使用（免登录链接仅能使用一次）' } }
  if (Date.now() > rec.expireAt) {
    MAGIC_LINKS.delete(token)
    equalize()
    return { ok: false, msg: '链接已过期' }
  }
  // IP 绑定：首次访问记录来源 IP；同一链接之后只允许该 IP 使用。
  // 仅在开启 magicBindIp 时生效；关闭时退化为纯单次使用。
  if (AUTH_CFG.magicBindIp) {
    if (rec.ip === null) {
      rec.ip = clientIp
    } else if (rec.ip !== clientIp) {
      equalize()
      return { ok: false, msg: '该链接已绑定其他 IP，请通过生成链接时的 IP 访问' }
    }
  }
  // 原子标记为已消费，消除竞态窗口
  rec.used = true
  equalize()
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
  // —— 时序均衡（P2 修复）：所有 early-return 前先做一次恒长 timingSafeEqual ——
  // session token 为 48 字节 hex；dummyBuf 取同样长度。攻击者无法通过响应
  // 时间差异分辨 "token 空 / token 无效 / 过期 / 绝对上限过期 / 验证通过"。
  const tokenBuf = Buffer.from(String(token || ''), 'utf-8')
  const dummyBuf = Buffer.from('x'.repeat(48), 'utf-8')
  const equalize = () => {
    if (tokenBuf.length === dummyBuf.length) {
      try { crypto.timingSafeEqual(tokenBuf, dummyBuf) } catch (_) {}
    }
  }

  if (!token) { equalize(); return false }
  const rec = tokens.get(token)
  if (!rec) { equalize(); return false }
  if (Date.now() > rec.expireAt) {
    tokens.delete(token)
    equalize()
    return false
  }
  // 7天绝对上限：无论是否活跃，session 最长存活 7 天
  const ABSOLUTE_MAX_MS = 7 * 24 * 60 * 60 * 1000
  if (rec.createdAt && Date.now() - rec.createdAt > ABSOLUTE_MAX_MS) {
    tokens.delete(token)
    equalize()
    return false
  }
  // IP 变更检测：记录变更次数，供审计使用
  if (currentIp && rec.lastIp && currentIp !== rec.lastIp) {
    rec.ipChanges = (rec.ipChanges || 0) + 1
    rec.lastIp = currentIp
  }
  rec.expireAt = Date.now() + AUTH_CFG.tokenExpireMs
  equalize()
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
  // 已废弃：泄露未使用验证码 ID 给攻击者，便于枚举有效 ID 后集中暴力破解 code。
  // 历史上仅在诊断命令暴露，现已无任何调用方（apps/ 与 src/ 均未使用）。
  // 保留导出签名仅为兼容旧测试，但永远返回 null，杜绝信息泄露途径。
  return null
}

