import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeLog } from '../../src/globals.js'

describe('globals: sanitizeLog（日志注入防护）', () => {
  test('剥离 \\r \\n 防止伪造日志行', () => {
    const malicious = '正常消息\r\n[FAKE] 2026-01-01 攻击者伪造的日志行'
    const cleaned = sanitizeLog(malicious)
    assert.ok(!cleaned.includes('\r'))
    assert.ok(!cleaned.includes('\n'))
    // 攻击者伪造的伪造行标记被压成同一行
    assert.match(cleaned, /正常消息.*\[FAKE\]/)
  })

  test('剥离 Unicode 行/段分隔符 U+2028 U+2029', () => {
    const malicious = 'line1\u2028line2\u2029line3'
    const cleaned = sanitizeLog(malicious)
    assert.ok(!cleaned.includes('\u2028'))
    assert.ok(!cleaned.includes('\u2029'))
  })

  test('null / undefined / 非字符串安全降级', () => {
    assert.equal(sanitizeLog(null), '')
    assert.equal(sanitizeLog(undefined), '')
    assert.equal(sanitizeLog(123), '123')
  })

  test('正常无控制字符的消息原样返回', () => {
    const ok = 'API HTTP 200: ok'
    assert.equal(sanitizeLog(ok), ok)
  })
})
