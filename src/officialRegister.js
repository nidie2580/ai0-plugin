import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as cfg from '../config/index.js'
import { safeAxiosRequest } from './security.js'
import { safeLogger } from './globals.js'
import {
  OFFICIAL_KIND,
  OFFICIAL_DISPLAY_NAME,
  allocateOfficialKey,
  officialPreset,
  forceOfficialApiBase,
  isOfficialKind,
  officialRegisterUrl,
  officialAssociateUrl,
  buildOfficialRegisterPayload,
  buildOfficialAssociatePayload,
  parseOfficialRegisterResponse,
  parseOfficialAssociateResponse,
  officialRegisterErrorForClient,
  redactOfficialText,
  sanitizeOfficialUsername,
  sanitizeOfficialQq,
  sanitizeOfficialEmail,
  officialAssociateExpectedEmail,
} from './officialApi.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.join(__dirname, '..')
const INSTANCE_FILE = path.join(PLUGIN_ROOT, 'data', 'official_instance.json')

function readPluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    return String(pkg.version || '').trim()
  } catch (_) {
    return ''
  }
}

export function getOrCreateInstanceId() {
  try {
    if (fs.existsSync(INSTANCE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf-8'))
      const id = String(parsed?.instanceId || parsed?.instance_id || '').trim()
      if (/^[a-f0-9]{32,64}$/i.test(id)) return id
    }
  } catch (_) {}
  const instanceId = crypto.randomBytes(16).toString('hex')
  try {
    const dir = path.dirname(INSTANCE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(INSTANCE_FILE, JSON.stringify({ instanceId }, null, 2), { mode: 0o600 })
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 写入官方实例 ID 失败: ${err.message}`)
  }
  return instanceId
}

export async function registerOfficialKey({ providerKey, displayName, operatorId } = {}, deps = {}) {
  const request = typeof deps.request === 'function' ? deps.request : safeAxiosRequest
  const loadConfig = typeof deps.loadConfig === 'function' ? deps.loadConfig : cfg.loadConfig
  const saveConfig = typeof deps.saveConfig === 'function' ? deps.saveConfig : cfg.saveConfig
  const instanceId = typeof deps.getInstanceId === 'function' ? deps.getInstanceId() : getOrCreateInstanceId()
  const config = structuredClone(loadConfig() || {})
  if (!config.model || typeof config.model !== 'object') config.model = {}
  const model = config.model
  const existingKeys = Object.keys(model).filter((k) => k !== 'default')
  let key = String(providerKey || '').trim()
  if (key) {
    const exist = model[key]
    if (exist && typeof exist === 'object' && !isOfficialKind(exist.kind)) {
      return { ok: false, msg: '该平台不是官方 API' }
    }
  } else {
    key = allocateOfficialKey(existingKeys)
  }
  const name = String(displayName || model[key]?.name || OFFICIAL_DISPLAY_NAME).trim() || OFFICIAL_DISPLAY_NAME
  if (!model[key] || typeof model[key] !== 'object') {
    model[key] = officialPreset({ name })
  } else {
    model[key].kind = OFFICIAL_KIND
    forceOfficialApiBase(model[key])
    if (name) model[key].name = name
  }

  const payload = buildOfficialRegisterPayload({
    instanceId,
    providerKey: key,
    displayName: name,
    operatorId,
    pluginVersion: readPluginVersion(),
  })
  let resp
  try {
    resp = await request('post', officialRegisterUrl(), payload, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20000,
    })
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 官方 API 注册请求失败: ${redactOfficialText(err?.message || err)}`)
    return { ok: false, msg: officialRegisterErrorForClient(err) }
  }

  const parsed = parseOfficialRegisterResponse(resp?.status, resp?.data)
  if (!parsed.ok) {
    safeLogger.warn(`[ai0-plugin] 官方 API 注册被拒绝: ${parsed.code || ''} ${parsed.message}`)
    return { ok: false, msg: parsed.message || '官方密钥签发失败', code: parsed.code }
  }

  model[key].apiKey = parsed.apiKey
  forceOfficialApiBase(model[key])
  const saved = saveConfig(config)
  if (!saved) {
    return { ok: false, msg: '密钥已签发但写入配置失败，请重试' }
  }
  return {
    ok: true,
    providerKey: key,
    keyReady: true,
    username: parsed.username || '',
    operatorId: sanitizeOfficialQq(operatorId),
    needAssociate: !parsed.username,
    msg: parsed.username
      ? `官方密钥已签发并保存。平台用户名：${parsed.username}`
      : '官方密钥已签发并保存。请填写该平台用户名并关联 QQ',
  }
}

export async function associateOfficialAccount({ providerKey, username, operatorId, email } = {}, deps = {}) {
  const request = typeof deps.request === 'function' ? deps.request : safeAxiosRequest
  const loadConfig = typeof deps.loadConfig === 'function' ? deps.loadConfig : cfg.loadConfig
  const instanceId = typeof deps.getInstanceId === 'function' ? deps.getInstanceId() : getOrCreateInstanceId()
  const user = sanitizeOfficialUsername(username)
  const hasUserInput = String(username == null ? '' : username).trim() !== ''
  if (hasUserInput && !user) return { ok: false, msg: '请填写有效的平台用户名（1–64 字，勿含空格或尖括号）' }
  const qq = sanitizeOfficialQq(operatorId)
  if (!qq) return { ok: false, msg: '当前登录未绑定有效 QQ，请用主人 QQ 发 #ai网页管理 重新打开直链后再关联' }
  const key = String(providerKey || '').trim()
  if (!key) return { ok: false, msg: '缺少官方平台 key' }
  // 第二段：用户手填的绑定邮箱。允许字母别名（微信注册的 QQ 邮箱）。
  const hasEmailInput = String(email == null ? '' : email).trim() !== ''
  const userEmail = sanitizeOfficialEmail(email)
  if (hasEmailInput && !userEmail) {
    return { ok: false, msg: '邮箱格式不正确，请填写该用户名实际绑定的邮箱（如 abc123@qq.com）' }
  }
  const config = loadConfig() || {}
  const entry = config.model?.[key]
  if (!entry || typeof entry !== 'object' || !isOfficialKind(entry.kind)) {
    return { ok: false, msg: '该平台不是官方 API' }
  }

  const payload = buildOfficialAssociatePayload({
    instanceId,
    providerKey: key,
    username: user,
    operatorId: qq,
    email: userEmail,
    pluginVersion: readPluginVersion(),
  })
  // 第一段期望 `<QQ>@qq.com`；第二段期望用户手填的邮箱。
  const expectedEmail = userEmail || officialAssociateExpectedEmail(qq)
  let resp
  try {
    resp = await request('post', officialAssociateUrl(), payload, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 20000,
    })
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 官方账号关联请求失败: ${redactOfficialText(err?.message || err)}`)
    return { ok: false, msg: officialRegisterErrorForClient(err) }
  }
  const parsed = parseOfficialAssociateResponse(resp?.status, resp?.data, {
    expectedEmail,
    expectedUsername: user,
    allowQqMatch: !user,
  })
  if (!parsed.ok) {
    safeLogger.warn(`[ai0-plugin] 官方账号关联被拒绝: ${parsed.code || ''} ${parsed.message}`)
    // 平台限频：同一实例 1 小时内身份校验失败 3 次 → 429/RATE_LIMITED。
    // 明确提示等待，不进入「补用户名/补邮箱」的引导重试分支，避免继续撞限。
    if (parsed.code === 'RATE_LIMITED') {
      // parse 层对空 message 会回退「关联官方账号失败」；命中该兜底时改用内置的等待提示
      const platformMsg = String(parsed.message || '').trim()
      const msg = platformMsg && platformMsg !== '关联官方账号失败'
        ? platformMsg
        : '身份校验失败次数过多（同一实例 1 小时内最多 3 次），请约 1 小时后再试'
      return { ok: false, code: 'RATE_LIMITED', msg }
    }
    // QQ 优先匹配失败：未提供用户名时，平台未找到该 QQ 绑定的账号 → 让前端收集用户名后重试。
    if (!user && (parsed.needUsername || parsed.needEmail || parsed.code === 'USER_NOT_FOUND'
      || parsed.code === 'NEED_USERNAME' || parsed.code === 'USERNAME_REQUIRED'
      || parsed.code === 'EMAIL_REQUIRED' || parsed.code === 'IDENTITY_NOT_VERIFIED')) {
      return {
        ok: false,
        needUsername: true,
        code: 'USER_NOT_FOUND',
        msg: parsed.message || '未找到与该 QQ 关联的平台账号，请填写你在该平台注册的用户名后重试',
      }
    }
    // 第一段（未提供邮箱）且平台要求补充邮箱 → 让前端弹窗收集邮箱后重试
    if (user && !userEmail && (parsed.needEmail || parsed.code === 'EMAIL_REQUIRED' || parsed.code === 'IDENTITY_NOT_VERIFIED')) {
      return {
        ok: false,
        needEmail: true,
        code: 'EMAIL_REQUIRED',
        msg: parsed.message || '该用户名绑定的邮箱不是当前 QQ 邮箱，请填写该用户名实际绑定的邮箱后重试',
      }
    }
    return { ok: false, msg: parsed.message || '关联官方账号失败', code: parsed.code }
  }
  return {
    ok: true,
    providerKey: key,
    username: parsed.username || user,
    operatorId: qq,
    email: parsed.email || userEmail || '',
    matchedBy: parsed.matchedBy || '',
    msg: `已将平台用户「${parsed.username || user}」与 QQ ${qq} 关联`,
  }
}
