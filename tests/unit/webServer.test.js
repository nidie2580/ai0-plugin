import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { validateWebHost } from '../../src/webServer.js'

describe('webServer: validateWebHost（host 白名单 + trustProxy 强制）', () => {
  describe('白名单：loopback / 私有 / 通配', () => {
    test('127.0.0.1 放行（trustProxy 任意）', () => {
      assert.equal(validateWebHost('127.0.0.1', false).ok, true)
      assert.equal(validateWebHost('127.0.0.1', true).ok, true)
    })
    test('::1 放行', () => {
      assert.equal(validateWebHost('::1', false).ok, true)
    })
    test('localhost 放行', () => {
      assert.equal(validateWebHost('localhost', false).ok, true)
    })
    test('RFC1918 私有段放行 10.x / 172.16-31.x / 192.168.x', () => {
      assert.equal(validateWebHost('10.0.0.1', false).ok, true)
      assert.equal(validateWebHost('172.16.0.1', false).ok, true)
      assert.equal(validateWebHost('172.31.255.255', false).ok, true)
      assert.equal(validateWebHost('192.168.1.1', false).ok, true)
    })
    test('公网 IP 拒绝（如 8.8.8.8）', () => {
      const r = validateWebHost('8.8.8.8', false)
      assert.equal(r.ok, false)
      assert.match(r.msg, /仅允许/)
    })
    test('172.32.x.x 拒绝（不在私有段范围）', () => {
      assert.equal(validateWebHost('172.32.0.1', false).ok, false)
    })
    test('host 前后空格自动 trim', () => {
      assert.equal(validateWebHost('  127.0.0.1  ', false).ok, true)
    })
  })

  describe('通配 0.0.0.0 / :: 强制 trustProxy=true', () => {
    test('0.0.0.0 + trustProxy=false → 拒绝', () => {
      const r = validateWebHost('0.0.0.0', false)
      assert.equal(r.ok, false)
      assert.match(r.msg, /trustProxy/)
    })
    test(':: + trustProxy=false → 拒绝', () => {
      const r = validateWebHost('::', false)
      assert.equal(r.ok, false)
      assert.match(r.msg, /trustProxy/)
    })
    test('0.0.0.0 + trustProxy=true → 放行', () => {
      assert.equal(validateWebHost('0.0.0.0', true).ok, true)
    })
    test(':: + trustProxy=true → 放行', () => {
      assert.equal(validateWebHost('::', true).ok, true)
    })
  })

  describe('trustProxy 仅在通配地址时生效（私有/loopback 不要求）', () => {
    test('127.0.0.1 + trustProxy=false → 放行', () => {
      assert.equal(validateWebHost('127.0.0.1', false).ok, true)
    })
    test('10.0.0.1 + trustProxy=false → 放行', () => {
      assert.equal(validateWebHost('10.0.0.1', false).ok, true)
    })
  })
})
