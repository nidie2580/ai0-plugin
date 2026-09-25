import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerOfficialKey, associateOfficialAccount } from '../../src/officialRegister.js'
import { OFFICIAL_API_BASE } from '../../src/officialApi.js'

describe('officialRegister', () => {
  it('合作方签发成功后把 Key 写入配置，不把明文 Key 放进返回值', async () => {
    const saved = []
    const result = await registerOfficialKey(
      { providerKey: 'official', displayName: '官方API', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { default: 'kimi' } }),
        saveConfig: (c) => { saved.push(c); return true },
        getInstanceId: () => 'aa'.repeat(16),
        request: async (method, url, payload) => {
          assert.equal(method, 'post')
          assert.equal(url.endsWith('/plugin/register'), true)
          assert.equal(payload.plugin, 'ai0-plugin')
          assert.equal(payload.instance_id, 'aa'.repeat(16))
          assert.equal(payload.provider_key, 'official')
          return { status: 200, data: { ok: true, api_key: 'sk-from-partner' } }
        },
      },
    )
    assert.equal(result.ok, true)
    assert.equal(result.providerKey, 'official')
    assert.equal(result.keyReady, true)
    assert.equal(result.apiKey, undefined)
    assert.equal(JSON.stringify(result).includes('sk-from-partner'), false)
    assert.equal(saved.length, 1)
    assert.equal(saved[0].model.official.apiKey, 'sk-from-partner')
    assert.equal(saved[0].model.official.kind, 'official')
    assert.equal(saved[0].model.official.apiBase, OFFICIAL_API_BASE)
    assert.equal(result.username, '')
    assert.equal(result.needAssociate, true)
  })

  it('注册回包带 username 时回传给前端，仍不下发明文 Key', async () => {
    const result = await registerOfficialKey(
      { providerKey: 'official', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: '' } } }),
        saveConfig: () => true,
        getInstanceId: () => 'aa'.repeat(16),
        request: async () => ({ status: 200, data: { ok: true, api_key: 'sk-from-partner', username: 'alice' } }),
      },
    )
    assert.equal(result.ok, true)
    assert.equal(result.username, 'alice')
    assert.equal(result.needAssociate, false)
    assert.equal(result.operatorId, '10001')
    assert.equal(JSON.stringify(result).includes('sk-from-partner'), false)
  })

  it('拒绝给自定义平台走官方注册', async () => {
    const result = await registerOfficialKey(
      { providerKey: 'kimi' },
      {
        loadConfig: () => ({ model: { kimi: { kind: 'custom', apiKey: 'x' } } }),
        saveConfig: () => true,
        getInstanceId: () => 'bb'.repeat(16),
        request: async () => { throw new Error('should not call') },
      },
    )
    assert.equal(result.ok, false)
    assert.match(result.msg, /不是官方/)
  })

  it('合作方失败时不落盘，错误不含官方地址', async () => {
    let saved = false
    const result = await registerOfficialKey(
      { providerKey: 'official' },
      {
        loadConfig: () => ({ model: {} }),
        saveConfig: () => { saved = true; return true },
        getInstanceId: () => 'cc'.repeat(16),
        request: async () => ({
          status: 500,
          data: { ok: false, message: `boom ${OFFICIAL_API_BASE}` },
        }),
      },
    )
    assert.equal(result.ok, false)
    assert.equal(saved, false)
    assert.equal(String(result.msg || '').includes('djyun'), false)
  })

  it('请求抛错时不污染调用方配置对象', async () => {
    const source = { model: { default: 'kimi' } }
    const result = await registerOfficialKey(
      {},
      {
        loadConfig: () => source,
        saveConfig: () => true,
        getInstanceId: () => 'dd'.repeat(16),
        request: async () => { throw new Error('ECONNREFUSED') },
      },
    )
    assert.equal(result.ok, false)
    assert.equal(source.model.official, undefined)
    assert.equal(result.msg, '官方服务暂不可达')
  })

  it('关联：把平台用户名与请求者 QQ 发给合作方', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', username: 'alice', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async (method, url, payload) => {
          assert.equal(method, 'post')
          assert.equal(url.endsWith('/plugin/associate'), true)
          assert.equal(payload.username, 'alice')
          assert.equal(payload.qq, '10001')
          assert.equal(payload.expect_email, '10001@qq.com')
          return { status: 200, data: { ok: true, username: 'alice', verified: true } }
        },
      },
    )
    assert.equal(result.ok, true)
    assert.equal(result.username, 'alice')
    assert.equal(result.operatorId, '10001')
  })

  it('关联：平台限频(429/RATE_LIMITED)时明确提示等待，不进入补用户名引导', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async () => ({ status: 429, data: { ok: false, code: 'RATE_LIMITED', message: '身份校验失败次数过多' } }),
      },
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, 'RATE_LIMITED')
    assert.equal(result.needUsername, undefined)
    assert.equal(result.needEmail, undefined)
    assert.equal(result.msg, '身份校验失败次数过多')
  })

  it('关联：429 无错误信息时回退到内置等待提示', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', username: 'alice', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async () => ({ status: 429, data: {} }),
      },
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, 'RATE_LIMITED')
    assert.match(result.msg, /1 小时后再试/)
  })

  it('关联：合作方未证明邮箱匹配时拒绝，防用户名冒充（第一段转为要求补邮箱）', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', username: 'admin', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async () => ({ status: 200, data: { ok: true, username: 'admin', associated: true } }),
      },
    )
    assert.equal(result.ok, false)
    assert.equal(result.code, 'EMAIL_REQUIRED')
    assert.equal(result.needEmail, true)
    assert.match(result.msg, /未确认该用户名与其绑定邮箱匹配/)
  })

  it('关联：回包邮箱等于 QQ 邮箱时视为已验证', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', username: 'alice', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async () => ({ status: 200, data: { ok: true, username: 'alice', email: '10001@qq.com' } }),
      },
    )
    assert.equal(result.ok, true)
    assert.equal(result.username, 'alice')
  })

  it('关联两段式：字母别名邮箱先要求补填，再带 email 二次校验成功', async () => {
    let seenEmailField = null
    const first = await associateOfficialAccount(
      { providerKey: 'official', username: 'bob', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async (method, url, payload) => {
          seenEmailField = payload.email
          assert.equal(payload.expect_email, '10001@qq.com')
          return { status: 403, data: { ok: false, code: 'EMAIL_REQUIRED', need_email: true } }
        },
      },
    )
    assert.equal(first.ok, false)
    assert.equal(first.needEmail, true)
    assert.equal(first.code, 'EMAIL_REQUIRED')
    assert.equal(seenEmailField, undefined)

    const second = await associateOfficialAccount(
      { providerKey: 'official', username: 'bob', operatorId: '10001', email: 'bob.wechat@qq.com' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async (method, url, payload) => {
          assert.equal(payload.email, 'bob.wechat@qq.com')
          assert.equal(payload.expect_email, 'bob.wechat@qq.com')
          return { status: 200, data: { ok: true, username: 'bob', email: 'bob.wechat@qq.com', verified: true } }
        },
      },
    )
    assert.equal(second.ok, true)
    assert.equal(second.username, 'bob')
    assert.equal(second.email, 'bob.wechat@qq.com')
  })

  it('关联两段式：手填邮箱格式非法时直接拒绝，不发请求', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', username: 'bob', operatorId: '10001', email: 'not-an-email' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async () => { throw new Error('should not call') },
      },
    )
    assert.equal(result.ok, false)
    assert.match(result.msg, /邮箱格式不正确/)
  })

  it('关联：登录身份不是 QQ 时拒绝', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', username: 'alice', operatorId: 'master-magic' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official' } } }),
        getInstanceId: () => 'ff'.repeat(16),
        request: async () => { throw new Error('should not call') },
      },
    )
    assert.equal(result.ok, false)
    assert.match(result.msg, /未绑定有效 QQ/)
  })

  it('关联 QQ 优先：不带用户名，合作方按 QQ 反查回传用户名即成功', async () => {
    let seenUsername
    const result = await associateOfficialAccount(
      { providerKey: 'official', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async (method, url, payload) => {
          seenUsername = payload.username
          assert.equal(payload.qq, '10001')
          return { status: 200, data: { ok: true, username: 'alice', associated: true } }
        },
      },
    )
    assert.equal(seenUsername, undefined)
    assert.equal(result.ok, true)
    assert.equal(result.username, 'alice')
    assert.equal(result.matchedBy, 'qq')
  })

  it('关联 QQ 优先：未匹配到账号 → needUsername 提示手填用户名', async () => {
    const result = await associateOfficialAccount(
      { providerKey: 'official', operatorId: '10001' },
      {
        loadConfig: () => ({ model: { official: { kind: 'official', apiKey: 'sk-x' } } }),
        getInstanceId: () => 'ee'.repeat(16),
        request: async () => ({ status: 404, data: { ok: false, code: 'USER_NOT_FOUND' } }),
      },
    )
    assert.equal(result.ok, false)
    assert.equal(result.needUsername, true)
    assert.match(result.msg, /用户名/)
  })
})
