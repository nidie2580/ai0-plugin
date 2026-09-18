import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  setPrimaryIdentity,
  adoptPrimaryForMasterLogin,
  getPrimaryIdentity,
  isPrimary,
  hasPrimary,
  createPending,
  approve,
  isApproved,
} from '../../src/loginGuard.js'

describe('loginGuard: magic link 绑定 primary', () => {
  test('无主身份时 adopt 建立 primary', () => {
    if (hasPrimary()) {
      const existing = getPrimaryIdentity()
      const adopted = adoptPrimaryForMasterLogin('master-magic')
      assert.equal(adopted, existing)
      return
    }
    const id = adoptPrimaryForMasterLogin('master-magic')
    assert.equal(id, 'master-magic')
    assert.equal(getPrimaryIdentity(), 'master-magic')
    assert.equal(isPrimary('master-magic'), true)
    assert.equal(isPrimary('other-qq'), false)
  })

  test('已有主身份时 magic 登录沿用该身份', () => {
    const seed = getPrimaryIdentity() || adoptPrimaryForMasterLogin('seed-primary')
    const adopted = adoptPrimaryForMasterLogin('should-not-replace')
    assert.equal(adopted, seed)
    assert.equal(getPrimaryIdentity(), seed)
    assert.equal(isPrimary(adopted), true)
  })
})

describe('loginGuard: 放行码恒时比较', () => {
  test('正确放行码能匹配，错误码拒绝', () => {
    const rec = createPending({ identity: 'qq-10001', ip: '127.0.0.1' })
    assert.equal(approve('wrong-code').ok, false)
    assert.equal(isApproved(rec.pendingId), false)
    const ok = approve(rec.code)
    assert.equal(ok.ok, true)
    assert.equal(isApproved(rec.pendingId), true)
  })

  test('可用 identity 放行', () => {
    const rec = createPending({ identity: 'qq-20002', ip: '127.0.0.1' })
    const ok = approve('qq-20002')
    assert.equal(ok.ok, true)
    assert.equal(isApproved(rec.pendingId), true)
  })
})
