import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

// 多模型并行回答 + 模型间互聊 回归测试
// 覆盖点：
//  - M1：listConfiguredModels —— 返回所有已配置(apiKey+apiBase)的模型 key；
//        缺 apiKey/apiBase 的模型被剔除；default 指向的模型被兜底包含。
//  - M2：collectArchiveReplies —— 从历史里抽取 [*] 机器人发言并按模型名分组；
//        普通消息(无 [*] 前缀)、乱格式不误采。
//  - M3：buildMultiChatRequest —— 互聊开启时把其他模型的历史发言以 [*] 前缀注入
//        本轮 user 消息末尾；mutiChat 关闭时原样返回；不修改传入 reqHistory。

const chatService = await import('../../src/chatService.js')

// —— 临时改写 config.yaml，保证测试独立于用户真实配置 ——
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
        temperature: 0.8,
        maxTokens: 2000,
        timeout: 60000,
      },
      'deepseek-x': {
        name: 'DeepSeek X',
        apiBase: 'https://api.deepseek.com/v1',
        apiKey: 'dk-key',
        model: 'deepseek-chat',
      },
      'qwen-vl': {
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

describe('多模型', () => {
  describe('M1: listConfiguredModels', () => {
    it('返回 apiKey+apiBase 均非空的模型，default 被兜底纳入', () => {
      writeConfig()
      const keys = chatService.listConfiguredModels()
      assert.ok(keys.includes('openai-compatible'), 'default 指向的模型必须被包含')
      assert.ok(keys.includes('deepseek-x'), '配置完整的模型必须被包含')
      assert.ok(!keys.includes('qwen-vl'), '缺 apiKey 的模型必须被剔除')
    })

    it('无任何可用模型时 default 缺失则返回空数组', () => {
      writeConfig({
        model: { default: 'missing', 'a': { apiBase: 'x', apiKey: '' } },
      })
      const keys = chatService.listConfiguredModels()
      assert.deepEqual(keys, [], 'default 指向的模型不可用时不应兜底出不可用键')
    })
  })

  describe('M2: collectArchiveReplies', () => {
    it('抽取 [*] 机器人发言并按模型名分组，跳过普通消息', () => {
      const out = chatService.collectArchiveReplies([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '[*] 模型A：我觉得是A' },
        { role: 'assistant', content: '[*] 模型B：我觉得是B1' },
        { role: 'assistant', content: '普通回复' },
        { role: 'assistant', content: '[*] 模型A：再补一句' },
      ])
      assert.deepEqual(out['模型A'], ['我觉得是A', '再补一句'])
      assert.deepEqual(out['模型B'], ['我觉得是B1'])
    })

    it('非数组输入返回空对象', () => {
      assert.deepEqual(chatService.collectArchiveReplies(null), {})
      assert.deepEqual(chatService.collectArchiveReplies(undefined), {})
    })
  })

  describe('M3: buildMultiChatRequest', () => {
    const display = (k) => '模型' + k
    const hist = [
      { role: 'assistant', content: '[*] 模型A：我选A' },
      { role: 'assistant', content: '[*] 模型B：我选B' },
    ]
    const archive = chatService.collectArchiveReplies(hist)

    it('互聊开启时把其他模型发言注入 user 消息末尾', () => {
      const req = chatService.buildMultiChatRequest({
        reqHistory: [{ role: 'system', content: 'sys' }, { role: 'user', content: '为什么？' }],
        archiveReplies: archive,
        modelKey: 'c',
        modelDisplay: display,
        multiChatEnabled: true,
      })
      const last = req[req.length - 1]
      assert.equal(last.role, 'user')
      assert.ok(last.content.includes('[*] 模型A：我选A'))
      assert.ok(last.content.includes('[*] 模型B：我选B'))
      // 本模型(c)的历史发言不应注入
      assert.ok(!last.content.includes('模型C'))
    })

    it('multiChatEnabled=false 时原样返回（复用原引用）', () => {
      const reqHistory = [{ role: 'user', content: 'hello' }]
      const req = chatService.buildMultiChatRequest({
        reqHistory,
        archiveReplies: archive,
        modelKey: 'a',
        modelDisplay: display,
        multiChatEnabled: false,
      })
      assert.equal(req, reqHistory)
    })

    it('不修改传入的 reqHistory（不可变）', () => {
      const reqHistory = [{ role: 'user', content: '原始问题' }]
      chatService.buildMultiChatRequest({
        reqHistory,
        archiveReplies: archive,
        modelKey: 'a',
        modelDisplay: display,
        multiChatEnabled: true,
      })
      assert.equal(reqHistory[0].content, '原始问题')
    })

    it('无其他模型发言时不注入任何内容', () => {
      const req = chatService.buildMultiChatRequest({
        reqHistory: [{ role: 'user', content: 'hi' }],
        archiveReplies: {},
        modelKey: 'a',
        modelDisplay: display,
        multiChatEnabled: true,
      })
      assert.equal(req[0].content, 'hi')
    })
  })
})
