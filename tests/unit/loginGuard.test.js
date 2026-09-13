import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  setPrimaryIdentity,
  adoptPrimaryForMasterLogin,
  getPrimaryIdentity,
  isPrimary,
  hasPrimary,
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
