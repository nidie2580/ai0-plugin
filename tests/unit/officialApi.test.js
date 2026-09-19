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
  omitOfficialProbeUrl,
  redactOfficialText,
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
  })

  it('保存时强制写回内置地址，下发时省略 apiBase', () => {
    const entry = forceOfficialApiBase({ kind: 'official', apiBase: 'https://evil.example/v1' })
    assert.equal(entry.apiBase, OFFICIAL_API_BASE)
    const publicEntry = omitOfficialApiBase({ kind: 'official', apiBase: OFFICIAL_API_BASE, name: '官方API' })
    assert.equal(publicEntry.apiBase, undefined)
    assert.equal(publicEntry.name, '官方API')
    const custom = omitOfficialApiBase({ kind: 'custom', apiBase: 'https://api.moonshot.cn/v1' })
    assert.equal(custom.apiBase, 'https://api.moonshot.cn/v1')
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
})
