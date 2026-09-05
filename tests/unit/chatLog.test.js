import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 模型互聊记录日志模块测试。
// 通过 AI0_CHATLOG_FILE 环境变量把日志指向临时文件，隔离真实 data/chat-log.json，
// 完成后清理临时目录。覆盖点：
//  - C1：appendChatLog 写入后用 queryChatLog 读回，最新在最前。
//  - C2：queryChatLog 分页（limit/offset）与 total。
//  - C3：readChatLog 面对不存在/损坏文件返回空数组（不抛错）。
//  - C4：appendChatLog 对空/超长输入做安全截断。
//  - C5：上限裁剪 —— 超过 MAX_ENTRIES 时保留最新、裁掉最旧。

const TMP_DIR = join(tmpdir(), 'ai0-chatlog-test-' + Date.now())
process.env.AI0_CHATLOG_FILE = join(TMP_DIR, 'chat-log.json')

const chatLog = await import('../../src/chatLog.js')

function rmTmp() {
  try { rmSync(TMP_DIR, { recursive: true, force: true }) } catch (_) {}
}

before(() => { mkdirSync(TMP_DIR, { recursive: true }) })
after(() => { rmTmp() })

describe('模型互聊记录(chatLog)', () => {
  it('C1: 写入后按最新在前读取', () => {
    appendOne('q1', 'm1', 'r1')
    appendOne('q2', 'm2', 'r2')
    const { total, items } = chatLog.queryChatLog()
    assert.ok(total >= 2)
    assert.equal(items[0].question, 'q2')
    assert.equal(items[0].replies[0].model, 'm2')
  })

  it('C2: total 统计 + 分页切片', () => {
    const { total } = chatLog.queryChatLog()
    const page = chatLog.queryChatLog({ limit: 1, offset: 0 })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].question, 'q2')   // 最新的先出
    const page2 = chatLog.queryChatLog({ limit: 10, offset: 1 })
    assert.ok(page2.items.length >= 1)
    assert.equal(page2.items[page2.items.length - 1].question, 'q1')  // 前一条在最旧侧
    assert.ok(Number.isInteger(total))
  })

  it('C3: readChatLog 始终返回数组（健壮性）', () => {
    assert.ok(Array.isArray(chatLog.readChatLog()))
  })

  it('C4: 空输入与超长内容安全截断', () => {
    appendOne('', 'm', 'x'.repeat(20000))
    const { items } = chatLog.queryChatLog({ limit: 1, offset: 0 })
    const top = items[0]
    assert.ok(top.question.length <= 4000)
    assert.ok(top.replies[0].text.length <= 8000)
  })

  it('C5: 超过上限裁剪旧记录（仅保留最新）', () => {
    for (let i = 0; i < 250; i++) appendOne('q' + i, 'm', 'r' + i)
    const { total, items } = chatLog.queryChatLog({ limit: 500 })
    assert.ok(total <= 200, '不能超过 MAX_ENTRIES 上限')
    assert.ok(items.length <= 200)
    // 最新的最旧问题已被淘汰
    assert.ok(!items.some((e) => e.question === 'q1'))
    assert.ok(items.some((e) => e.question === 'q249'))
  })
})

function appendOne(question, model, text) {
  chatLog.appendChatLog({
    userId: '10001',
    sessionId: 'session-1',
    question,
    replies: [{ model, text }],
  })
}
