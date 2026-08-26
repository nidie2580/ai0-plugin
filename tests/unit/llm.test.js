import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { normalizeApiBase } from '../../src/helper.js'
import {
  buildEndpoint,
  saveHistory,
  loadHistory,
  cleanupOldSessions,
  extractReasoning
} from '../../src/llm.js'

// llm.js 引用 Yunzai 全局 logger；测试环境注入 mock
globalThis.logger = {
  info: () => {}, warn: () => {}, error: () => {}, mark: () => {}
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEST_USER = `${process.pid}`
const HISTORY_DIR = path.join(__dirname, '..', '..', 'data', 'history')

function cleanTestUser() {
  const dir = path.join(HISTORY_DIR, TEST_USER)
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)) } catch (_) {}
    }
    try { fs.rmdirSync(dir) } catch (_) {}
  }
}

describe('llm: normalizeApiBase', () => {
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
    assert.equal(out, 'https://api.moonshot.cn/v1')
  })

  test('内网地址与本地 ollama', () => {
    assert.equal(normalizeApiBase('http://localhost:11434'), 'http://localhost:11434/v1')
  })
})

describe('llm: buildEndpoint', () => {
  test('拼标准 chat/completions', () => {
    assert.equal(
      buildEndpoint('https://api.openai.com/v1/', '/chat/completions'),
      'https://api.openai.com/v1/chat/completions'
    )
  })

  test('pathSegment 不带斜杠也兼容', () => {
    assert.equal(
      buildEndpoint('https://api.openai.com/v1', 'models'),
      'https://api.openai.com/v1/models'
    )
  })

  test('裸 base 自动补 v1 再拼', () => {
    assert.equal(
      buildEndpoint('https://api.deepseek.com', '/models'),
      'https://api.deepseek.com/v1/models'
    )
  })
})

describe('llm: 会话历史持久化', () => {
  test('save → load 往返一致', async () => {
    cleanTestUser()
    const s1 = randomUUID()
    try {
      await saveHistory(TEST_USER, s1, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好！' }])
      const loaded = await loadHistory(TEST_USER, s1)
      assert.equal(loaded.length, 2)
      assert.equal(loaded[0].role, 'user')
      assert.equal(loaded[1].content, '你好！')
    } finally { cleanTestUser() }
  })

  test('不存在的 session 返回空数组', () => {
    // 必须是合法 UUID 才会走到"文件不存在 → []"分支；非法 format 本身直接抛错（属另一层防御）
    const missing = randomUUID()
    const out = loadHistory(TEST_USER, missing)
    assert.deepEqual(out, [])
  })

  test('非法 sessionId 直接抛错（防路径穿越）', () => {
    assert.throws(() => loadHistory(TEST_USER, '../etc/passwd'))
    assert.throws(() => loadHistory(TEST_USER, 'abc'))      // 非 UUID
    assert.throws(() => loadHistory(TEST_USER, 's1.bak'))   // 带 .bak 后缀
  })

  test('主文件损坏时从 .bak 恢复', async () => {
    cleanTestUser()
    const s2 = randomUUID()
    try {
      const file = path.join(HISTORY_DIR, TEST_USER, `${s2}.json`)
      await saveHistory(TEST_USER, s2, [{ role: 'user', content: 'ok' }])
      // 把 .bak 改成可识别内容，再破坏主文件
      const bak = file + '.bak'
      fs.writeFileSync(bak, JSON.stringify([{ role: 'user', content: 'from-bak' }]))
      fs.writeFileSync(file, '{broken json!!!', 'utf-8')
      const loaded = loadHistory(TEST_USER, s2)
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0].content, 'from-bak')
    } finally { cleanTestUser() }
  })

  test('主文件和 .bak 都损坏返回空数组', async () => {
    cleanTestUser()
    const s3 = randomUUID()
    try {
      const file = path.join(HISTORY_DIR, TEST_USER, `${s3}.json`)
      await saveHistory(TEST_USER, s3, [{ role: 'user', content: 'x' }])
      fs.writeFileSync(file + '.bak', '{bad', 'utf-8')
      fs.writeFileSync(file, '{also bad', 'utf-8')
      const loaded = loadHistory(TEST_USER, s3)
      assert.deepEqual(loaded, [])
    } finally { cleanTestUser() }
  })

  test('cleanupOldSessions 按数量清理最旧', async () => {
    cleanTestUser()
    const old1 = randomUUID()
    const old2 = randomUUID()
    const new1 = randomUUID()
    try {
      await saveHistory(TEST_USER, old1, [{ role: 'user', content: 'a' }])
      await saveHistory(TEST_USER, old2, [{ role: 'user', content: 'b' }])
      await saveHistory(TEST_USER, new1, [{ role: 'user', content: 'c' }])
      // 设置较早 mtime 让 old 优先被清
      const now = Date.now()
      const oldFile1 = path.join(HISTORY_DIR, TEST_USER, `${old1}.json`)
      const oldFile2 = path.join(HISTORY_DIR, TEST_USER, `${old2}.json`)
      fs.utimesSync(oldFile1, new Date(now - 100000), new Date(now - 100000))
      fs.utimesSync(oldFile2, new Date(now - 50000), new Date(now - 50000))

      const kept = cleanupOldSessions(TEST_USER, 1, -1)
      assert.equal(kept, undefined)
      const remain = fs.readdirSync(path.join(HISTORY_DIR, TEST_USER)).filter(f => f.endsWith('.json'))
      assert.deepEqual(remain, [`${new1}.json`])
      assert.equal(fs.existsSync(oldFile1), false)
      assert.equal(fs.existsSync(oldFile2), false)
    } finally { cleanTestUser() }
  })

  test('cleanupOldSessions 按时效清理', async () => {
    cleanTestUser()
    const exp1 = randomUUID()
    try {
      await saveHistory(TEST_USER, exp1, [{ role: 'user', content: 'x' }])
      const f = path.join(HISTORY_DIR, TEST_USER, `${exp1}.json`)
      const old = Date.now() - 60 * 60 * 1000
      fs.utimesSync(f, new Date(old), new Date(old))
      const kept = cleanupOldSessions(TEST_USER, 100, 30 * 60 * 1000)
      assert.equal(kept, undefined)
      assert.equal(fs.existsSync(f), false)
    } finally { cleanTestUser() }
  })
})

describe('llm: extractReasoning 深度思考内容提取', () => {
  test('message.reasoning_content（DeepSeek-R1 风格）', () => {
    const choice = { message: { content: '答案', reasoning_content: '先分析问题…' } }
    assert.equal(extractReasoning(choice), '先分析问题…')
  })

  test('message.reasoning / message.thinking 兼容', () => {
    assert.equal(extractReasoning({ message: { reasoning: 'r1' } }), 'r1')
    assert.equal(extractReasoning({ message: { thinking: 't1' } }), 't1')
  })

  test('流式 delta.reasoning_content 兼容', () => {
    assert.equal(extractReasoning({ delta: { reasoning_content: 'stream' } }), 'stream')
  })

  test('缺失/空白/非字符串返回空串', () => {
    assert.equal(extractReasoning(undefined), '')
    assert.equal(extractReasoning({}), '')
    assert.equal(extractReasoning({ message: {} }), '')
    assert.equal(extractReasoning({ message: { reasoning_content: '   ' } }), '')
    assert.equal(extractReasoning({ message: { reasoning: 123 } }), '')
  })

  test('优先级：reasoning_content > reasoning > thinking', () => {
    const choice = { message: { reasoning_content: 'a', reasoning: 'b', thinking: 'c' } }
    assert.equal(extractReasoning(choice), 'a')
  })
})
