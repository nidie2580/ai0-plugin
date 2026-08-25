import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { callLlmWithRetry, setRateLimitRetryConfig } from '../../src/agent.js'

// 测试用短退避（10ms/最多重试 2 次），避免真实 60s 固定等待拖慢测试
function useShortRetry() {
  setRateLimitRetryConfig(10, 2)
}

/** 构造可注入的调用函数：按 behavior 序列抛错/成功 */
function makeCallFn(behavior) {
  let n = 0
  return {
    fn: async () => {
      n++
      const next = behavior.length ? behavior.shift() : 'ok'
      if (next === 'fail') throw new Error('429 Too Many Requests')
      if (next === 'err') throw new Error('connection reset')
      return { text: `res-${n}` }
    },
    count: () => n
  }
}

describe('agent: callLlmWithRetry 429 固定退避重试', () => {
  after(() => setRateLimitRetryConfig(60_000, 3)) // 恢复生产默认（60s / 最多重试 3 次）

  test('成功调用直接返回（1 次）', async () => {
    const c = makeCallFn([])
    const res = await callLlmWithRetry({ messages: [], opts: {}, callFn: c.fn })
    assert.equal(res.ok, true)
    assert.equal(res.res.text, 'res-1')
    assert.equal(c.count(), 1)
  })

  test('429 触发固定退避重试，最终成功（共 3 次尝试）', async () => {
    useShortRetry()
    const c = makeCallFn(['fail', 'fail'])
    const start = Date.now()
    const res = await callLlmWithRetry({ messages: [], opts: {}, callFn: c.fn })
    const elapsed = Date.now() - start
    assert.equal(res.ok, true)
    assert.equal(c.count(), 3, '2 次 429 后第 3 次成功')
    assert.ok(elapsed >= 20, `应包含 2 次固定退避等待（10ms×2），实际 ${elapsed}ms`)
  })

  test('429 超过最大重试次数返回错误', async () => {
    useShortRetry()
    const c = makeCallFn(['fail', 'fail', 'fail'])
    const res = await callLlmWithRetry({ messages: [], opts: {}, callFn: c.fn })
    assert.equal(res.ok, false)
    assert.ok(res.error, '应返回错误信息')
    assert.match(String(res.error?.message || res.error), /429/)
    assert.equal(c.count(), 3, '恰好重试 2 次后停止')
  })

  test('非 429 错误不重试，立即返回', async () => {
    useShortRetry()
    const c = makeCallFn(['err'])
    const res = await callLlmWithRetry({ messages: [], opts: {}, callFn: c.fn })
    assert.equal(res.ok, false)
    assert.equal(c.count(), 1, '非限流错误只调用 1 次')
    assert.match(String(res.error?.message || res.error), /connection reset/)
  })

  test('请求已中止时不重试', async () => {
    const ac = new AbortController()
    ac.abort()
    const c = makeCallFn(['fail', 'fail'])
    const res = await callLlmWithRetry({ messages: [], opts: { signal: ac.signal }, callFn: c.fn })
    assert.equal(res.ok, false)
    assert.equal(res.aborted, true)
    assert.equal(c.count(), 1, '中止后不进入退避重试')
  })
})
