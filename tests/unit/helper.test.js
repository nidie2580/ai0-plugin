import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeApiBase } from '../../src/helper.js'

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
