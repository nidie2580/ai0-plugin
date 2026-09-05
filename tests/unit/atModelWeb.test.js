import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

// "/<模型名>" 艾特解析 + 模型联网开关 回归测试
// 覆盖点：
//  - A1：resolveAtModel —— 用 /key /name /model 任一别名命中模型 key；未命中返回 null。
//  - A2：buildAtModelIndex —— 汇总所有可用模型的 key/name/model 到同一映射（小写）。
//  - A3：isModelWebEnabled —— 仅 web:true 的模型返回 true，缺省为 false。
//  - A4：resolveAtModel 不误伤普通文本 / 空串 / 非字符串。

const chatService = await import('../../src/chatService.js')

const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(extra) {
  const base = {
    model: {
      default: 'openai-compatible',
      'openai-compatible': {
        name: '默认模型',
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-3.5-turbo',
      },
      'deepseek': {
        name: 'DeepSeek X',
        apiBase: 'https://api.deepseek.com/v1',
        apiKey: 'dk-key',
        model: 'deepseek-chat',
        web: true,
      },
      'qwen-vl': {
        name: '通义千问',
        apiBase: 'https://dashscope.aliyuncs.com/v1',
        apiKey: '',
        model: 'qwen-vl-max',
      },
    },
    chat: { groupAtReply: false, privateReply: true, triggerPrefix: [] },
    ...extra,
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(base), 'utf-8')
  cfg.setForceLoad(true)
}

function restoreConfig() {
  if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  cfg.setForceLoad(false)
}

before(() => restoreConfig())
after(() => restoreConfig())

describe('艾特解析 + 联网开关', () => {
  describe('A1: resolveAtModel', () => {
    it('用模型 key 匹配（/deepseek）命中', () => {
      writeConfig()
      assert.equal(chatService.resolveAtModel('/deepseek 你的观点我不认同'), 'deepseek')
    })

    it('用模型 name 匹配（/deepseek x）命中（忽略大小写）', () => {
      writeConfig()
      assert.equal(chatService.resolveAtModel('/DeepSeek x 观点呢'), 'deepseek')
    })

    it('用模型 model 字段匹配（/deepseek-chat）命中', () => {
      writeConfig()
      assert.equal(chatService.resolveAtModel('/deepseek-chat 引述来源？'), 'deepseek')
    })

    it('未匹配到任何模型别名时返回 null', () => {
      writeConfig()
      assert.equal(chatService.resolveAtModel('/unknown 随便说点'), null)
    })

    it('空串/仅斜杠/非字符串均返回 null', () => {
      writeConfig()
      assert.equal(chatService.resolveAtModel(''), null)
      assert.equal(chatService.resolveAtModel('/'), null)
      assert.equal(chatService.resolveAtModel(null), null)
      assert.equal(chatService.resolveAtModel(undefined), null)
      assert.equal(chatService.resolveAtModel(123), null)
    })
  })

  describe('A2: buildAtModelIndex', () => {
    it('key/name/model 均归一化到同一 key，且缺 apiKey 的模型不收录', () => {
      writeConfig()
      const idx = chatService.buildAtModelIndex()
      assert.equal(idx.get('deepseek'), 'deepseek', 'key 别名')
      assert.equal(idx.get('deepseek x'), 'deepseek', 'name 别名')
      assert.equal(idx.get('deepseek-chat'), 'deepseek', 'model 别名')
      assert.equal(idx.get('openai-compatible'), 'openai-compatible', 'default 指向模型')
      assert.equal(idx.has('qwen-vl'), false, '缺 apiKey 不发')
    })
  })

  describe('A3: isModelWebEnabled', () => {
    it('仅 web:true 的模型为 true，缺省 false，未知 key false', () => {
      writeConfig()
      assert.equal(chatService.isModelWebEnabled('deepseek'), true)
      assert.equal(chatService.isModelWebEnabled('openai-compatible'), false)
      assert.equal(chatService.isModelWebEnabled('not-exist'), false)
    })
  })
})
