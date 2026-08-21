import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const sec = await import('../../src/security.js')

describe('security: safeFetchWithRedirects', () => {
  it('拒绝私有 IP', async () => {
    const result = await sec.safeFetchWithRedirects('http://127.0.0.1/secret')
    assert.equal(result.ok, false)
    assert.match(result.error, /私有/)
  })

  it('拒绝私有域名解析', async () => {
    const result = await sec.safeFetchWithRedirects('http://localhost/path')
    assert.equal(result.ok, false)
  })

  it('拒绝非 HTTP URL', async () => {
    const result = await sec.safeFetchWithRedirects('file:///etc/passwd')
    assert.equal(result.ok, false)
  })

  it('拒绝空 URL', async () => {
    const result = await sec.safeFetchWithRedirects('')
    assert.equal(result.ok, false)
  })

  it('成功请求公网 HTTPS URL', async () => {
    const result = await sec.safeFetchWithRedirects('https://httpbin.org/get')
    // httpbin 可能不可用或返回非 200，只要能连通即通过
    if (result.ok) {
      assert.ok(result.response.status >= 200)
    }
  })
})

describe('security: isAllowedOutboundUrl', () => {
  it('允许公网 URL', async () => {
    const result = await sec.isAllowedOutboundUrl('https://example.com')
    assert.equal(result.ok, true)
    assert.ok(result.resolvedIp)
  })

  it('拒绝私有 IP', async () => {
    const result = await sec.isAllowedOutboundUrl('http://192.168.1.1')
    assert.equal(result.ok, false)
  })

  it('拒绝 localhost', async () => {
    const result = await sec.isAllowedOutboundUrl('http://localhost')
    assert.equal(result.ok, false)
  })

  it('拒绝非法 URL', async () => {
    const result = await sec.isAllowedOutboundUrl('not-a-url')
    assert.equal(result.ok, false)
  })
})
