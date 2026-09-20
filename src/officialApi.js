import https from 'node:https'

export const OFFICIAL_KIND = 'official'
export const CUSTOM_KIND = 'custom'
export const OFFICIAL_HOST = 'api.djyun.click'
export const OFFICIAL_API_BASE = 'https://api.djyun.click/v1'
export const OFFICIAL_DISPLAY_NAME = '官方API'
export const OFFICIAL_KEY_PREFIX = 'official'
export const OFFICIAL_REGISTER_PATH = '/plugin/register'
export const OFFICIAL_ASSOCIATE_PATH = '/plugin/associate'
export const OFFICIAL_PLUGIN_NAME = 'ai0-plugin'

function normalizeHostname(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/^\[|\]$/g, '')
}

/**
 * 目标主机是否为官方合作方域名（含其子域）。仅此类主机允许放宽 TLS 证书校验，
 * 避免官方证书链异常时注册/关联/拉模型列表全部失败，同时不对其他主机降级。
 */
export function isOfficialHost(hostname) {
  const h = normalizeHostname(hostname)
  if (!h) return false
  if (h === OFFICIAL_HOST) return true
  return h.endsWith('.' + OFFICIAL_HOST)
}

let _officialHttpsAgent = null
/**
 * 供官方域名使用的 https agent（跳过证书校验）。全局复用，避免每次请求新建连接池。
 */
export function officialHttpsAgent() {
  if (!_officialHttpsAgent) {
    _officialHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false })
  }
  return _officialHttpsAgent
}

export function isOfficialKind(kind) {
  return String(kind || '').trim().toLowerCase() === OFFICIAL_KIND
}

export function normalizeProviderKind(kind) {
  return isOfficialKind(kind) ? OFFICIAL_KIND : CUSTOM_KIND
}

export function allocateOfficialKey(existingKeys) {
  const taken = new Set((existingKeys || []).map((k) => String(k || '').trim()).filter(Boolean))
  if (!taken.has(OFFICIAL_KEY_PREFIX)) return OFFICIAL_KEY_PREFIX
  let n = 2
  while (taken.has(`${OFFICIAL_KEY_PREFIX}-${n}`)) n++
  return `${OFFICIAL_KEY_PREFIX}-${n}`
}

export function officialPreset(overrides = {}) {
  return {
    kind: OFFICIAL_KIND,
    name: overrides.name || OFFICIAL_DISPLAY_NAME,
    apiBase: OFFICIAL_API_BASE,
    apiKey: overrides.apiKey || '',
    model: overrides.model || '',
    temperature: overrides.temperature ?? 0.8,
    maxTokens: overrides.maxTokens ?? 2000,
    timeout: overrides.timeout ?? 60000,
  }
}

export function forceOfficialApiBase(entry) {
  if (entry && typeof entry === 'object' && isOfficialKind(entry.kind)) {
    entry.apiBase = OFFICIAL_API_BASE
  }
  return entry
}

export function hasOfficialApiKey(entry) {
  const key = String(entry?.apiKey || '').trim()
  if (!key) return false
  if (/^\*+$/.test(key)) return false
  return true
}

export function omitOfficialApiBase(entry) {
  if (!entry || typeof entry !== 'object' || !isOfficialKind(entry.kind)) return entry
  const { apiBase: _hidden, ...rest } = entry
  return rest
}

export function omitOfficialSecrets(entry) {
  if (!entry || typeof entry !== 'object' || !isOfficialKind(entry.kind)) return entry
  const { apiBase: _hiddenBase, apiKey: hiddenKey, ...rest } = entry
  rest.keyReady = hasOfficialApiKey({ apiKey: hiddenKey })
  return rest
}

export function redactOfficialText(text) {
  const host = OFFICIAL_HOST.replace(/\./g, '\\.')
  return String(text || '')
    .replace(new RegExp(`https?:\\/\\/[^\\s"'<>]*${host}[^\\s"'<>]*`, 'gi'), '[official]')
    .replace(new RegExp(host, 'gi'), '[official]')
}

export function omitOfficialProbeUrl(info, kind) {
  if (!info || typeof info !== 'object' || !isOfficialKind(kind)) return info
  const { url: _hidden, ...rest } = info
  if (rest.error) rest.error = redactOfficialText(rest.error)
  if (rest.msg) rest.msg = redactOfficialText(rest.msg)
  if (rest.note) rest.note = redactOfficialText(rest.note)
  return rest
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    const v = obj[k]
    if (v == null) continue
    const s = String(v).trim()
    if (s) return v
  }
  return undefined
}

export function officialRegisterUrl() {
  return `${OFFICIAL_API_BASE}${OFFICIAL_REGISTER_PATH}`
}

export function officialAssociateUrl() {
  return `${OFFICIAL_API_BASE}${OFFICIAL_ASSOCIATE_PATH}`
}

export function sanitizeOfficialUsername(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s) return ''
  if (s.length > 64) return ''
  if (/[\u0000-\u001f<>]/.test(s)) return ''
  if (/\s/.test(s)) return ''
  return s
}

export function sanitizeOfficialQq(value) {
  const s = String(value == null ? '' : value).trim()
  if (!/^[1-9][0-9]{4,11}$/.test(s)) return ''
  return s
}

/**
 * 关联校验用邮箱：合作方须校验该用户名绑定的邮箱等于 `<QQ>@qq.com`。
 * QQ 非法时返回空串，调用方应直接拒绝关联。
 */
export function officialAssociateExpectedEmail(value) {
  const qq = sanitizeOfficialQq(value)
  return qq ? `${qq}@qq.com` : ''
}

/**
 * 用户手填的绑定邮箱。允许字母别名（微信注册的 QQ 邮箱常是字母形式），
 * 因此只做通用邮箱格式校验，不强制 `<QQ>@qq.com`。
 */
export function sanitizeOfficialEmail(value) {
  const s = String(value == null ? '' : value).trim()
  if (!s || s.length > 254) return ''
  if (/[\u0000-\u001f\u007f<>\s]/.test(s)) return ''
  if (!/^[^@]{1,64}@[^@.]+(?:\.[^@.]+)+$/.test(s)) return ''
  return s
}

export function buildOfficialRegisterPayload({
  instanceId,
  providerKey,
  displayName,
  operatorId,
  pluginVersion,
} = {}) {
  const plugin = OFFICIAL_PLUGIN_NAME
  const version = String(pluginVersion || '').trim()
  const inst = String(instanceId || '').trim()
  const key = String(providerKey || '').trim()
  const name = String(displayName || OFFICIAL_DISPLAY_NAME).trim() || OFFICIAL_DISPLAY_NAME
  const operator = String(operatorId || '').trim()
  const qq = sanitizeOfficialQq(operator)
  const payload = {
    plugin,
    pluginVersion: version,
    plugin_version: version,
    instanceId: inst,
    instance_id: inst,
    providerKey: key,
    provider_key: key,
    displayName: name,
    display_name: name,
  }
  if (qq) {
    payload.operatorId = qq
    payload.operator_id = qq
    payload.qq = qq
  } else if (operator && operator !== 'master-magic' && operator !== 'unknown') {
    payload.operatorId = operator
    payload.operator_id = operator
  }
  return payload
}

export function parseOfficialRegisterResponse(status, data) {
  const body = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}
  const nested = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {}
  const apiKey = String(
    pickFirst(body, ['apiKey', 'api_key', 'key'])
    || pickFirst(nested, ['apiKey', 'api_key', 'key'])
    || '',
  ).trim()
  const explicitFail = body.ok === false || body.success === false
  const httpOk = Number(status) >= 200 && Number(status) < 300
  if (httpOk && apiKey && !explicitFail) {
    const usernameRaw = pickFirst(body, ['username', 'userName', 'user_name', 'account'])
      || pickFirst(nested, ['username', 'userName', 'user_name', 'account'])
      || ''
    return {
      ok: true,
      apiKey,
      username: sanitizeOfficialUsername(usernameRaw),
      keyId: String(pickFirst(body, ['keyId', 'key_id']) || pickFirst(nested, ['keyId', 'key_id']) || '').trim(),
      expiresAt: pickFirst(body, ['expiresAt', 'expires_at']) || pickFirst(nested, ['expiresAt', 'expires_at']) || null,
    }
  }
  let code = String(pickFirst(body, ['code', 'errorCode', 'error_code']) || '').trim()
  if (!code) {
    if (Number(status) === 429) code = 'RATE_LIMITED'
    else if (Number(status) === 401 || Number(status) === 403) code = 'UNAUTHORIZED'
    else if (Number(status) === 409) code = 'ALREADY_REGISTERED'
    else code = 'REGISTER_FAILED'
  }
  const rawMsg = pickFirst(body, ['message', 'msg', 'error']) || pickFirst(nested, ['message', 'msg', 'error']) || '官方密钥签发失败'
  return {
    ok: false,
    code,
    message: redactOfficialText(String(rawMsg)),
    status: Number(status) || 0,
  }
}

export function officialRegisterErrorForClient(err) {
  const raw = redactOfficialText(err?.message || String(err || '官方服务暂不可达'))
  if (/timeout|timed out|ECONNABORTED/i.test(raw)) return '官方服务响应超时，请稍后重试'
  if (/certificate|UNABLE_TO_VERIFY|CERT_/i.test(raw)) return '官方服务证书校验失败'
  if (/ECONNREFUSED|ENOTFOUND|network|socket/i.test(raw)) return '官方服务暂不可达'
  if (/拒绝访问|重定向|SSRF|私有|回环/i.test(raw)) return '官方服务暂不可达'
  return '官方密钥签发失败，请稍后重试'
}

export function getOfficialMeta() {
  return {
    displayName: OFFICIAL_DISPLAY_NAME,
    keyPrefix: OFFICIAL_KEY_PREFIX,
    connectivityUnconfirmed: true,
    certMayBeInvalid: true,
    hasRegister: true,
    hint: '官方 API 为可选项，地址由服务端管理，后台不展示。请先点「注册获取密钥」（由合作方签发，本页不显示密钥），成功后再确认平台用户名并关联 QQ，然后「拉取模型列表」。充值请在合作方网页处理。',
  }
}

export function buildOfficialAssociatePayload({
  instanceId,
  providerKey,
  username,
  operatorId,
  email,
  pluginVersion,
} = {}) {
  const plugin = OFFICIAL_PLUGIN_NAME
  const version = String(pluginVersion || '').trim()
  const inst = String(instanceId || '').trim()
  const key = String(providerKey || '').trim()
  const user = sanitizeOfficialUsername(username)
  const operator = sanitizeOfficialQq(operatorId)
  const userEmail = sanitizeOfficialEmail(email)
  const payload = {
    plugin,
    pluginVersion: version,
    plugin_version: version,
    instanceId: inst,
    instance_id: inst,
    providerKey: key,
    provider_key: key,
  }
  // 用户名可选：留空表示「按 QQ 优先匹配」，由合作方依据 operatorId 反查账号。
  if (user) {
    payload.username = user
    payload.user_name = user
  }
  if (operator) {
    payload.operatorId = operator
    payload.operator_id = operator
    payload.qq = operator
  }
  // 第一段：期望邮箱取 `<QQ>@qq.com`；第二段：用户手填的实际绑定邮箱。
  // 合作方按 expect_email / email 校验该用户名绑定邮箱是否一致。
  if (userEmail) {
    payload.email = userEmail
    payload.expectEmail = userEmail
    payload.expect_email = userEmail
  } else if (operator) {
    const expectEmail = `${operator}@qq.com`
    payload.expectEmail = expectEmail
    payload.expect_email = expectEmail
  }
  return payload
}

const ASSOCIATE_VERIFY_KEYS = [
  'verified', 'identityVerified', 'identity_verified',
  'emailVerified', 'email_verified', 'emailMatched', 'email_matched',
]

function isTruthyFlag(value) {
  if (value === true || value === 1) return true
  const s = String(value == null ? '' : value).trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

export function parseOfficialAssociateResponse(status, data, opts = {}) {
  const body = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {}
  const nested = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {}
  const explicitFail = body.ok === false || body.success === false
  const httpOk = Number(status) >= 200 && Number(status) < 300
  const usernameRaw = pickFirst(body, ['username', 'userName', 'user_name', 'account'])
    || pickFirst(nested, ['username', 'userName', 'user_name', 'account'])
    || ''
  const emailRaw = String(
    pickFirst(body, ['email', 'mail', 'userEmail', 'user_email'])
    || pickFirst(nested, ['email', 'mail', 'userEmail', 'user_email'])
    || '',
  ).trim()
  const returnedUsername = sanitizeOfficialUsername(usernameRaw)

  // 身份校验：必须由合作方证明「该用户名绑定的邮箱 == <QQ>@qq.com」。
  // 仅凭 2xx 就放行会让管理员填 `admin` 冒充他人账号，直接蹭到无限额。
  const expectedEmail = String(opts.expectedEmail || '').trim().toLowerCase()
  const expectedUsername = sanitizeOfficialUsername(opts.expectedUsername || '').toLowerCase()
  const allowQqMatch = !!opts.allowQqMatch && !expectedUsername
  const flagVerified = isTruthyFlag(
    pickFirst(body, ASSOCIATE_VERIFY_KEYS) ?? pickFirst(nested, ASSOCIATE_VERIFY_KEYS),
  )
  const emailVerified = !!(expectedEmail && emailRaw && emailRaw.toLowerCase() === expectedEmail)
  const usernameMismatch = !!(expectedUsername && returnedUsername && returnedUsername.toLowerCase() !== expectedUsername)
  // QQ 优先匹配：未提供用户名时，合作方依据 operatorId(QQ) 反查账号并回传 username，
  // 视为「QQ 已绑定该平台账号」——不需要额外 verified 标记（operatorId 由服务端登录态派生，不可伪造）。
  const qqMatched = !!(allowQqMatch && returnedUsername && httpOk && !explicitFail)
  const identityVerified = qqMatched || ((flagVerified || emailVerified) && !usernameMismatch)

  if (httpOk && !explicitFail && identityVerified) {
    return {
      ok: true,
      username: returnedUsername,
      email: emailRaw,
      verified: true,
      matchedBy: qqMatched ? 'qq' : 'email',
      associated: body.associated !== false && nested.associated !== false,
    }
  }

  let code = String(pickFirst(body, ['code', 'errorCode', 'error_code']) || pickFirst(nested, ['code', 'errorCode', 'error_code']) || '').trim()
  if (!code) {
    if (usernameMismatch) code = 'IDENTITY_MISMATCH'
    else if (httpOk && !explicitFail) code = 'IDENTITY_NOT_VERIFIED'
    else if (Number(status) === 429) code = 'RATE_LIMITED'
    else if (Number(status) === 401 || Number(status) === 403) code = 'UNAUTHORIZED'
    else if (Number(status) === 404) code = 'USER_NOT_FOUND'
    else code = 'ASSOCIATE_FAILED'
  }
  // 平台明示「需要用户提供实际绑定邮箱」：邮箱不是 <QQ>@qq.com 时（如微信注册的字母别名），
  // 插件据此弹窗让用户手填邮箱，再做第二段校验。
  const needEmailRaw = pickFirst(body, ['needEmail', 'need_email']) ?? pickFirst(nested, ['needEmail', 'need_email'])
  const needEmail = isTruthyFlag(needEmailRaw) || code === 'EMAIL_REQUIRED'
  // QQ 优先匹配失败：合作方未找到该 QQ 绑定的账号（或明示需要用户名），前端改为收集用户名后重试。
  const needUsernameRaw = pickFirst(body, ['needUsername', 'need_username']) ?? pickFirst(nested, ['needUsername', 'need_username'])
  const needUsername = isTruthyFlag(needUsernameRaw)
    || code === 'NEED_USERNAME'
    || code === 'USERNAME_REQUIRED'
    || (allowQqMatch && (code === 'USER_NOT_FOUND' || needEmail || code === 'IDENTITY_NOT_VERIFIED' || code === 'IDENTITY_MISMATCH'))
  const identityCodes = ['IDENTITY_NOT_VERIFIED', 'IDENTITY_MISMATCH', 'EMAIL_REQUIRED']
  const defaultMsg = needUsername
    ? '未找到与该 QQ 关联的平台账号，请填写你在该平台注册的用户名后重试'
    : identityCodes.includes(code)
      ? '平台未确认该用户名与其绑定邮箱匹配，请填写该用户名实际绑定的邮箱后重试'
      : code === 'USER_NOT_FOUND'
        ? '未找到该平台用户名，请确认后重试'
        : '关联官方账号失败'
  const rawMsg = pickFirst(body, ['message', 'msg', 'error']) || pickFirst(nested, ['message', 'msg', 'error']) || defaultMsg
  return {
    ok: false,
    code,
    message: redactOfficialText(String(rawMsg)),
    needEmail: needEmail || undefined,
    needUsername: needUsername || undefined,
    status: Number(status) || 0,
  }
}
