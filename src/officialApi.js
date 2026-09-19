export const OFFICIAL_KIND = 'official'
export const CUSTOM_KIND = 'custom'
export const OFFICIAL_HOST = 'api.djyun.click'
export const OFFICIAL_API_BASE = 'https://api.djyun.click/v1'
export const OFFICIAL_DISPLAY_NAME = '官方API'
export const OFFICIAL_KEY_PREFIX = 'official'
export const OFFICIAL_REGISTER_PATH = '/plugin/register'
export const OFFICIAL_PLUGIN_NAME = 'ai0-plugin'

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
  if (operator) {
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
    return {
      ok: true,
      apiKey,
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
    hint: '官方 API 为可选项，地址由服务端管理，后台不展示。请先点「注册获取密钥」（由合作方签发，本页不显示密钥），成功后再「拉取模型列表」。充值请在合作方网页完成后台关联。',
  }
}
