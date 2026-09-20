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
  sanitizeOfficialEmail,
  officialAssociateExpectedEmail,
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
    assert.equal(payload.expectEmail, '10001@qq.com')
    assert.equal(payload.expect_email, '10001@qq.com')
    assert.match(officialAssociateUrl(), /\/plugin\/associate$/)
    assert.equal(parseOfficialAssociateResponse(404, { ok: false, message: 'no user' }).code, 'USER_NOT_FOUND')
  })

  it('关联校验：只有合作方证明邮箱匹配才算成功', () => {
    const okOpts = { expectedEmail: '10001@qq.com', expectedUsername: 'alice' }
    // 显式 verified 标志
    assert.equal(parseOfficialAssociateResponse(200, { ok: true, username: 'alice', verified: true }, okOpts).ok, true)
    assert.equal(parseOfficialAssociateResponse(200, { ok: true, user_name: 'alice', identity_verified: 'true' }, okOpts).ok, true)
    // 回包邮箱与 QQ 邮箱一致
    assert.equal(parseOfficialAssociateResponse(200, { ok: true, username: 'alice', email: '10001@qq.com' }, okOpts).ok, true)
    assert.equal(parseOfficialAssociateResponse(200, { ok: true, username: 'alice', email: '10001@QQ.com' }, okOpts).ok, true)
    // 只有 2xx、没有校验证据 → 拒绝（防 admin 冒充：请求与回包都叫 admin，但没证明邮箱）
    const spoof = parseOfficialAssociateResponse(
      200,
      { ok: true, username: 'admin', associated: true },
      { expectedEmail: '10001@qq.com', expectedUsername: 'admin' },
    )
    assert.equal(spoof.ok, false)
    assert.equal(spoof.code, 'IDENTITY_NOT_VERIFIED')
    // 显式 verified:false → 拒绝
    const denied = parseOfficialAssociateResponse(200, { ok: true, username: 'alice', verified: false }, okOpts)
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'IDENTITY_NOT_VERIFIED')
    // 返回的 username 与请求不一致 → 拒绝
    const mismatch = parseOfficialAssociateResponse(200, { ok: true, username: 'bob', verified: true }, okOpts)
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.code, 'IDENTITY_MISMATCH')
    // 邮箱不匹配（别人绑到别的 QQ）→ 拒绝
    const wrongMail = parseOfficialAssociateResponse(200, { ok: true, username: 'alice', email: '99999@qq.com' }, okOpts)
    assert.equal(wrongMail.ok, false)
    assert.equal(wrongMail.code, 'IDENTITY_NOT_VERIFIED')
  })

  it('officialAssociateExpectedEmail 仅对合法 QQ 生成邮箱', () => {
    assert.equal(officialAssociateExpectedEmail('10001'), '10001@qq.com')
    assert.equal(officialAssociateExpectedEmail('master-magic'), '')
    assert.equal(officialAssociateExpectedEmail(''), '')
  })

  it('手填邮箱：允许字母别名，拒绝非法格式', () => {
    assert.equal(sanitizeOfficialEmail('abc123@qq.com'), 'abc123@qq.com')
    assert.equal(sanitizeOfficialEmail('bob.wechat@qq.com'), 'bob.wechat@qq.com')
    assert.equal(sanitizeOfficialEmail('  a@b.co  '), 'a@b.co')
    assert.equal(sanitizeOfficialEmail('bad'), '')
    assert.equal(sanitizeOfficialEmail('a b@qq.com'), '')
    assert.equal(sanitizeOfficialEmail('a@b'), '')
    assert.equal(sanitizeOfficialEmail('x@evil<script>'), '')
    assert.equal(sanitizeOfficialEmail(''), '')
  })

  it('第二段关联请求体带 email，并作为 expect_email', () => {
    const payload = buildOfficialAssociatePayload({
      instanceId: 'abc123',
      providerKey: 'official',
      username: 'bob',
      operatorId: '10001',
      email: 'bob.wechat@qq.com',
      pluginVersion: '1.2.0',
    })
    assert.equal(payload.email, 'bob.wechat@qq.com')
    assert.equal(payload.expect_email, 'bob.wechat@qq.com')
    assert.equal(payload.qq, '10001')
  })

  it('关联解析：EMAIL_REQUIRED / need_email 标记为需要补邮箱', () => {
    const first = parseOfficialAssociateResponse(403, {
      ok: false, code: 'EMAIL_REQUIRED', need_email: true, message: 'need email',
    }, { expectedEmail: '10001@qq.com' })
    assert.equal(first.ok, false)
    assert.equal(first.code, 'EMAIL_REQUIRED')
    assert.equal(first.needEmail, true)

    const flagged = parseOfficialAssociateResponse(200, {
      ok: false, needEmail: true,
    }, { expectedEmail: '10001@qq.com' })
    assert.equal(flagged.needEmail, true)
  })

  it('第二段：回包邮箱等于手填邮箱才算成功', () => {
    const opts = { expectedEmail: 'bob.wechat@qq.com', expectedUsername: 'bob' }
    assert.equal(parseOfficialAssociateResponse(200, { ok: true, username: 'bob', email: 'bob.wechat@qq.com' }, opts).ok, true)
    const wrong = parseOfficialAssociateResponse(200, { ok: true, username: 'bob', email: 'other@qq.com' }, opts)
    assert.equal(wrong.ok, false)
    assert.equal(wrong.code, 'IDENTITY_NOT_VERIFIED')
  })
})
