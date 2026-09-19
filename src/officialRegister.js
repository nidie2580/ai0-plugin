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
  buildOfficialRegisterPayload,
  parseOfficialRegisterResponse,
  officialRegisterErrorForClient,
  redactOfficialText,
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
    msg: '官方密钥已签发并保存，可拉取模型列表',
  }
}
