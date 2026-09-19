import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerOfficialKey } from '../../src/officialRegister.js'
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
})
