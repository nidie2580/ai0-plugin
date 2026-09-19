import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  setPrimaryIdentity,
  adoptPrimaryForMasterLogin,
  getPrimaryIdentity,
  isPrimary,
  hasPrimary,
  isPlaceholderLoginIdentity,
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

  test('已有真实主身份时不覆盖 primary，会话仍用请求者 QQ', () => {
    const seed = getPrimaryIdentity() || adoptPrimaryForMasterLogin('10001')
    const adopted = adoptPrimaryForMasterLogin('20002')
    assert.equal(adopted, '20002')
    if (!isPlaceholderLoginIdentity(seed)) {
      assert.equal(getPrimaryIdentity(), seed)
    }
  })

  test('占位主身份可被真实 QQ 升级', () => {
    if (hasPrimary() && !isPlaceholderLoginIdentity(getPrimaryIdentity())) {
      const adopted = adoptPrimaryForMasterLogin('198635967')
      assert.equal(adopted, '198635967')
      return
    }
    adoptPrimaryForMasterLogin('master-magic')
    const id = adoptPrimaryForMasterLogin('198635967')
    assert.equal(id, '198635967')
    assert.equal(getPrimaryIdentity(), '198635967')
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
