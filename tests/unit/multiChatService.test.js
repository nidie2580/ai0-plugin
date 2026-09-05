import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

// 网页端「模型互聊」服务 回归测试
// 覆盖点：
//  - W1：resolveUserLabel —— 优先用登录身份(webIdentity)；无则用配置 bot.self_id/uin；再兜底 '机器人'。
//  - W2：readWebConversation / clearWebConversation —— 临时会话为空可读、可清空。
//  - W3：runWebMultiChat 无可用模型时返回 ok:false（不发起网络请求）。

const svc = await import('../../src/multiChatService.js')

const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(extra) {
  const base = {
    model: {
      default: 'openai-compatible',
      'openai-compatible': { name: '默认模型', apiBase: 'https://api.openai.com/v1', apiKey: 'test-key', model: 'gpt-3.5-turbo' },
      'deepseek': { name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', apiKey: 'dk', model: 'deepseek-chat' },
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

describe('网页端模型互聊服务', () => {
  describe('W1: resolveUserLabel', () => {
    it('优先使用登录身份（webIdentity）', () => {
      writeConfig()
      assert.equal(svc.resolveUserLabel(null, { webIdentity: '123456' }), '123456')
    })

    it('无登录身份时用配置 bot.self_id', () => {
      writeConfig({ bot: { self_id: '99999' } })
      assert.equal(svc.resolveUserLabel(), '99999')
    })

    it('无登录身份且无配置时兜底为 机器人', () => {
      writeConfig({})
      assert.equal(svc.resolveUserLabel(), '机器人')
    })
  })

  describe('W2: 临时会话读写', () => {
    it('未发言时读会话为空；write 后可见，clear 后清空', () => {
      const uid = 'test-web-1'
      assert.deepEqual(svc.readWebConversation(uid), [])
      svc.clearWebConversation(uid)
      assert.deepEqual(svc.readWebConversation(uid), [])
    })
  })

  describe('W3: runWebMultiChat 无可用模型', () => {
    it('模型配置缺 apiKey/apiBase 时返回 ok:false', async () => {
      writeConfig({ model: { default: 'a', a: { apiBase: 'x', apiKey: '' } } })
      const res = await svc.runWebMultiChat({ userId: 'u1', question: '你好' })
      assert.equal(res.ok, false)
      assert.ok(res.msg && res.msg.includes('没有可用'))
    })
  })
})
