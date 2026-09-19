import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateOfficialKey,
  isOfficialKind,
  normalizeProviderKind,
  officialPreset,
  getOfficialMeta,
  forceOfficialApiBase,
  omitOfficialApiBase,
  omitOfficialSecrets,
  omitOfficialProbeUrl,
  redactOfficialText,
  hasOfficialApiKey,
  buildOfficialRegisterPayload,
  parseOfficialRegisterResponse,
  officialRegisterErrorForClient,
  officialRegisterUrl,
  officialAssociateUrl,
  buildOfficialAssociatePayload,
  parseOfficialAssociateResponse,
  sanitizeOfficialUsername,
  sanitizeOfficialQq,
  OFFICIAL_API_BASE,
} from '../../src/officialApi.js'

describe('officialApi', () => {
  it('allocateOfficialKey 避开已占用 key', () => {
    assert.equal(allocateOfficialKey([]), 'official')
    assert.equal(allocateOfficialKey(['official']), 'official-2')
    assert.equal(allocateOfficialKey(['official', 'official-2']), 'official-3')
  })

  it('kind 判定：official 以外视为 custom', () => {
    assert.equal(isOfficialKind('official'), true)
    assert.equal(isOfficialKind('OFFICIAL'), true)
    assert.equal(isOfficialKind('custom'), false)
    assert.equal(normalizeProviderKind('official'), 'official')
    assert.equal(normalizeProviderKind(undefined), 'custom')
  })

  it('官方预设使用内置地址，对外 meta 不含 host/apiBase', () => {
    const p = officialPreset()
    assert.equal(p.kind, 'official')
    assert.equal(p.apiBase, OFFICIAL_API_BASE)
    assert.equal(p.name, '官方API')
    const meta = getOfficialMeta()
    assert.equal(meta.host, undefined)
    assert.equal(meta.apiBase, undefined)
    assert.equal(meta.displayName, '官方API')
    assert.equal(meta.keyPrefix, 'official')
    assert.equal(meta.connectivityUnconfirmed, true)
    assert.equal(meta.hasRegister, true)
    assert.match(officialRegisterUrl(), /\/plugin\/register$/)
    assert.equal(officialRegisterUrl().includes('djyun'), true)
  })

  it('保存时强制写回内置地址，下发时省略 apiBase 与明文 Key', () => {
    const entry = forceOfficialApiBase({ kind: 'official', apiBase: 'https://evil.example/v1' })
    assert.equal(entry.apiBase, OFFICIAL_API_BASE)
    const publicEntry = omitOfficialApiBase({ kind: 'official', apiBase: OFFICIAL_API_BASE, name: '官方API' })
    assert.equal(publicEntry.apiBase, undefined)
    assert.equal(publicEntry.name, '官方API')
    const custom = omitOfficialApiBase({ kind: 'custom', apiBase: 'https://api.moonshot.cn/v1' })
    assert.equal(custom.apiBase, 'https://api.moonshot.cn/v1')
    const ready = omitOfficialSecrets({ kind: 'official', apiBase: OFFICIAL_API_BASE, apiKey: 'sk-secret', name: '官方API' })
    assert.equal(ready.apiBase, undefined)
    assert.equal(ready.apiKey, undefined)
    assert.equal(ready.keyReady, true)
    const empty = omitOfficialSecrets({ kind: 'official', apiBase: OFFICIAL_API_BASE, apiKey: '', name: '官方API' })
    assert.equal(empty.keyReady, false)
    assert.equal(hasOfficialApiKey({ apiKey: '********' }), false)
    assert.equal(hasOfficialApiKey({ apiKey: 'sk-ok' }), true)
  })

  it('官方探测结果省略 url 并脱敏错误中的地址', () => {
    const info = omitOfficialProbeUrl({
      ok: false,
      url: `${OFFICIAL_API_BASE}/models`,
      error: `connect ${OFFICIAL_API_BASE} failed`,
    }, 'official')
    assert.equal(info.url, undefined)
    assert.equal(info.error.includes('djyun'), false)
    assert.equal(redactOfficialText('https://api.djyun.click/v1/models'), '[official]')
  })

  it('注册请求体同时带 camelCase 与 snake_case', () => {
    const payload = buildOfficialRegisterPayload({
      instanceId: 'abc123',
      providerKey: 'official',
      displayName: '官方API',
      operatorId: '10001',
      pluginVersion: '1.2.0',
    })
    assert.equal(payload.plugin, 'ai0-plugin')
    assert.equal(payload.instanceId, 'abc123')
    assert.equal(payload.instance_id, 'abc123')
    assert.equal(payload.providerKey, 'official')
    assert.equal(payload.provider_key, 'official')
    assert.equal(payload.pluginVersion, '1.2.0')
    assert.equal(payload.plugin_version, '1.2.0')
    assert.equal(payload.operator_id, '10001')
    assert.equal(payload.qq, '10001')
  })

  it('解析合作方签发响应：snake_case / camelCase / data 嵌套', () => {
    assert.equal(parseOfficialRegisterResponse(200, { ok: true, api_key: 'sk-py' }).apiKey, 'sk-py')
    assert.equal(parseOfficialRegisterResponse(201, { success: true, apiKey: 'sk-js' }).apiKey, 'sk-js')
    assert.equal(parseOfficialRegisterResponse(200, { ok: true, data: { api_key: 'sk-nest' } }).apiKey, 'sk-nest')
    assert.equal(parseOfficialRegisterResponse(200, { ok: true, api_key: 'sk-u', username: 'alice' }).username, 'alice')
    assert.equal(parseOfficialRegisterResponse(200, { ok: true, api_key: 'sk-u', user_name: 'bob' }).username, 'bob')
    const fail = parseOfficialRegisterResponse(429, { ok: false, message: 'too many' })
    assert.equal(fail.ok, false)
    assert.equal(fail.code, 'RATE_LIMITED')
    const urlFail = parseOfficialRegisterResponse(500, { message: `fail ${OFFICIAL_API_BASE}` })
    assert.equal(urlFail.message.includes('djyun'), false)
  })

  it('注册错误文案不回显官方地址', () => {
    const msg = officialRegisterErrorForClient(new Error(`connect ${OFFICIAL_API_BASE} ECONNREFUSED`))
    assert.equal(msg.includes('djyun'), false)
    assert.equal(msg, '官方服务暂不可达')
  })

  it('关联请求体带用户名与 QQ，解析回包 username', () => {
    assert.equal(sanitizeOfficialUsername('alice_01'), 'alice_01')
    assert.equal(sanitizeOfficialUsername('bad name'), '')
    assert.equal(sanitizeOfficialQq('10001'), '10001')
    assert.equal(sanitizeOfficialQq('master-magic'), '')
    const payload = buildOfficialAssociatePayload({
      instanceId: 'abc123',
      providerKey: 'official',
      username: 'alice',
      operatorId: '10001',
      pluginVersion: '1.2.0',
    })
    assert.equal(payload.username, 'alice')
    assert.equal(payload.user_name, 'alice')
    assert.equal(payload.qq, '10001')
    assert.match(officialAssociateUrl(), /\/plugin\/associate$/)
    assert.equal(parseOfficialAssociateResponse(200, { ok: true, username: 'alice' }).ok, true)
    assert.equal(parseOfficialAssociateResponse(404, { ok: false, message: 'no user' }).code, 'USER_NOT_FOUND')
  })
})
