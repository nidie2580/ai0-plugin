import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { callLlmWithRetry } from '../../src/agent.js'

/** 构造可注入的调用函数：按 behavior 序列抛错/成功 */
function makeCallFn(behavior) {
  let n = 0
  return {
    fn: async () => {
      n++
      const next = behavior.length ? behavior.shift() : 'ok'
      if (next === 'fail') throw new Error('429 Too Many Requests')
      return { text: `res-${n}` }
    },
    count: () => n
  }
}

describe('agent: callLlmWithRetry 速率限制与重试', () => {
  test('成功调用直接返回（1 次）', async () => {
    const c = makeCallFn([])
    const res = await callLlmWithRetry({ messages: [], opts: {}, callFn: c.fn })
    assert.equal(res.ok, true)
    assert.equal(res.res.text, 'res-1')
    assert.equal(c.count(), 1)
  })

  test('失败后按退避重试（1s→2s），最终成功（共 3 次）', async () => {
    const c = makeCallFn(['fail', 'fail'])
    const start = Date.now()
    const res = await callLlmWithRetry({ messages: [], opts: {}, callFn: c.fn })
    const elapsed = Date.now() - start
    assert.equal(res.ok, true)
    assert.equal(c.count(), 3)
    assert.ok(elapsed >= 2800, `应包含 1s+2s 退避等待，实际 ${elapsed}ms`)
  })

  test('全部失败返回错误且不继续无限重试', async () => {
    const c = makeCallFn(['fail', 'fail', 'fail'])
    const res = await callLlmWithRetry({ messages: [], opts: {}, callFn: c.fn })
    assert.equal(res.ok, false)
    assert.ok(res.error, '应返回错误信息')
    assert.match(String(res.error?.message || res.error), /429/)
    assert.equal(c.count(), 3, '恰好重试 2 次后停止')
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
