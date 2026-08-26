import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeApiBase, replyReasoningAsChat } from '../../src/helper.js'

globalThis.logger = {
  info: () => {}, warn: () => {}, error: () => {}, mark: () => {}
}

describe('helper: replyReasoningAsChat 深度思考聊天记录发送', () => {
  test('群聊 + makeForwardMsg：以合并转发（聊天记录）发送', async () => {
    let fwdNodes = null
    const makeForwardMsg = async (nodes) => {
      fwdNodes = nodes
      return { type: 'forward', data: {} }
    }
    const replies = []
    const e = {
      group_id: 123,
      self_id: 10000,
      bot: { makeForwardMsg },
      reply: async (msg) => { replies.push(msg) }
    }
    const out = await replyReasoningAsChat(e, '先思考 A，再思考 B')
    assert.equal(out, true)
    assert.ok(Array.isArray(fwdNodes) && fwdNodes.length === 1, '短思考应为单节点转发')
    assert.equal(fwdNodes[0].nickname, '深度思考')
    assert.match(fwdNodes[0].message[0].text, /先思考 A/)
    assert.equal(replies.length, 1, '应回复转发消息')
  })

  test('长思考分段为多个节点', async () => {
    let fwdNodes = null
    const makeForwardMsg = async (nodes) => {
      fwdNodes = nodes
      return { type: 'forward', data: {} }
    }
    const e = {
      group_id: 123,
      self_id: 10000,
      bot: { makeForwardMsg },
      reply: async () => {}
    }
    await replyReasoningAsChat(e, '行\n'.repeat(4000))
    assert.ok(fwdNodes.length > 1, `长文本应拆多节点，实际 ${fwdNodes?.length}`)
  })

  test('私聊（无 group_id）降级普通回复并带前缀', async () => {
    const replies = []
    const e = { self_id: 10000, reply: async (msg) => { replies.push(msg) } }
    await replyReasoningAsChat(e, '思考内容')
    assert.equal(replies.length, 1)
    assert.match(String(replies[0]), /深度思考/)
    assert.match(String(replies[0]), /思考内容/)
  })

  test('makeForwardMsg 抛错时降级普通回复', async () => {
    const replies = []
    const e = {
      group_id: 123,
      self_id: 10000,
      bot: { makeForwardMsg: async () => { throw new Error('adapter fail') } },
      reply: async (msg) => { replies.push(msg) }
    }
    await replyReasoningAsChat(e, '降级内容')
    assert.equal(replies.length, 1)
    assert.match(String(replies[0]), /降级内容/)
  })

  test('空思考内容不发送', async () => {
    const replies = []
    const e = { group_id: 1, reply: async (msg) => { replies.push(msg) } }
    const out = await replyReasoningAsChat(e, '   ')
    assert.equal(out, null)
    assert.equal(replies.length, 0)
  })
})

describe('helper: normalizeApiBase', () => {
  test('空值/非字符串返回空串', () => {
    assert.equal(normalizeApiBase(null), '')
    assert.equal(normalizeApiBase(undefined), '')
    assert.equal(normalizeApiBase('   '), '')
    assert.equal(normalizeApiBase(123), '')
  })

  test('标准 OpenAI 地址去尾部斜杠', () => {
    assert.equal(normalizeApiBase('https://api.openai.com/v1/'), 'https://api.openai.com/v1')
  })

  test('裸域名自动补 /v1', () => {
    assert.equal(normalizeApiBase('https://api.deepseek.com'), 'https://api.deepseek.com/v1')
  })

  test('已有自定义路径段不补 /v1', () => {
    assert.equal(normalizeApiBase('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4')
    assert.equal(normalizeApiBase('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  })

  test('误填完整 /chat/completions 被裁剪', () => {
    assert.equal(normalizeApiBase('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1')
  })

  test('去掉 query 与 hash', () => {
    const out = normalizeApiBase('https://api.moonshot.cn/v1?key=abc#frag')
    assert.ok(!out.includes('key='))
    assert.ok(!out.includes('#'))
  })

  test('内网地址与本地 ollama', () => {
    assert.equal(normalizeApiBase('http://localhost:11434'), 'http://localhost:11434/v1')
  })

  test('误填 /images/generations 被裁剪', () => {
    assert.equal(normalizeApiBase('https://api.openai.com/v1/images/generations'), 'https://api.openai.com/v1')
  })
})
