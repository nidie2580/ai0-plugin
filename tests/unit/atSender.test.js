import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as cfg from '../../config/index.js'
import { buildAtSenderSegment } from '../../src/chatService.js'

// 「AI 回复前自动艾特发送者」（chat.autoAtSender）纯逻辑测试
// 覆盖点：
//  - 开关关闭 → 不生成艾特段（默认行为完全不变）
//  - 开关开启 + 群聊 → 返回真实 at 消息段
//  - 私聊（无 group_id）→ 不艾特
//  - 发送者是机器人自身账号 → 不艾特
//  - 缺少发送者 id → 不艾特

const CONFIG_PATH = fileURLToPath(new URL('../../config/config.yaml', import.meta.url))
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(chatExtra = {}) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ chat: { ...chatExtra } }), 'utf-8')
  cfg.setForceLoad(true)
}

function restoreConfig() {
  if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  cfg.setForceLoad(false)
}

describe('chatService: autoAtSender 回复前艾特发送者', () => {
  before(() => restoreConfig())
  after(() => restoreConfig())

  it('开关关闭 → 返回 null（默认行为不变）', () => {
    writeConfig({ autoAtSender: false })
    const e = { group_id: 123, self_id: 10000, user_id: 111 }
    assert.equal(buildAtSenderSegment(e, 111), null)
  })

  it('开关未配置 → 返回 null', () => {
    writeConfig({})
    const e = { group_id: 123, self_id: 10000, user_id: 111 }
    assert.equal(buildAtSenderSegment(e, 111), null)
  })

  it('开关开启 + 群聊 → 返回真实 at 段（qq 字符串化）', () => {
    writeConfig({ autoAtSender: true })
    const e = { group_id: 123, self_id: 10000, user_id: 111 }
    assert.deepEqual(buildAtSenderSegment(e, 111), { type: 'at', qq: '111' })
    assert.deepEqual(buildAtSenderSegment(e, '111'), { type: 'at', qq: '111' })
  })

  it('开关开启但为私聊（无 group_id）→ 返回 null', () => {
    writeConfig({ autoAtSender: true })
    const e = { self_id: 10000, user_id: 111 }
    assert.equal(buildAtSenderSegment(e, 111), null)
  })

  it('发送者是机器人自身账号 → 返回 null', () => {
    writeConfig({ autoAtSender: true })
    const e = { group_id: 123, self_id: 10000 }
    assert.equal(buildAtSenderSegment(e, 10000), null)
  })

  it('缺少发送者 id → 返回 null', () => {
    writeConfig({ autoAtSender: true })
    const e = { group_id: 123, self_id: 10000 }
    assert.equal(buildAtSenderSegment(e, ''), null)
    assert.equal(buildAtSenderSegment(e, null), null)
  })
})
