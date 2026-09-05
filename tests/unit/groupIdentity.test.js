import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 第三轮修复回归测试
 * 覆盖点：
 *  - T1：协议适配器方法 Promise 永不 resolve（掉线/风控）时，buildIdentityContext
 *        必须按 apiTimeoutMs 快速返回"未检测到"，绝不无限 pending。
 *  - T2：数据健康（接口正常返回）时，buildIdentityContext 回填 out 字段并输出完整上下文。
 *  - T3：pickHardIdentityFallback 纯逻辑——全缺失+身份问句 → 固定兜底；
 *        普通闲聊（你好/在吗）与操作类请求（帮我把群主踢了）不触发；
 *        部分数据可用 / 主人自称身份 / 群数据可用 → 不触发，交给模型。
 */

// 顶层 await import：node --test 在 ESM 模式下支持顶层 await
const groupOps = await import('../../src/groupOps.js')
groupOps.__test__.setGroupApiTimeoutMs(120)

/** 永不 resolve 的 Promise（模拟协议端掉线时既不返回也不报错） */
function hang() { return new Promise(() => {}) }

function makeHangBot() {
  const group = {
    is_owner: undefined,
    isOwner: undefined,
    getInfo: () => hang(),
    getGroupInfo: () => hang(),
    getMemberInfo: () => hang(),
    getGroupMemberInfo: () => hang(),
    getMemberMap: () => hang()
  }
  global.Bot = {
    uin: '88888',
    self_id: '88888',
    pickGroup: () => group,
    getGroupInfo: () => hang(),
    getMemberInfo: () => hang(),
    getGroupMemberInfo: () => hang()
  }
  return group
}

/** 接口全速返回的健康 mock */
function makeHealthyBot({ requesterRole = 'member', ownerUin = '88888' } = {}) {
  const requesterUid = '10001'
  const botUin = '88888'
  const membersMap = new Map([
    [botUin, { role: 'owner', nickname: '机器人', user_id: botUin }],
    [requesterUid, { role: requesterRole, nickname: '请求者', user_id: requesterUid }]
  ])
  const group = {
    is_owner: undefined,
    isOwner: undefined,
    getMemberMap: async () => membersMap,
    getMemberInfo: async (uid) => membersMap.get(String(uid)) || null,
    getInfo: async () => ({ groupName: '测试群', member_count: 5, ownerUin: ownerUin })
  }
  global.Bot = {
    uin: botUin,
    self_id: botUin,
    pickGroup: () => group
  }
  return { requesterUid, botUin, group }
}

function makeEvent(gid, uid, extra = {}) {
  return {
    group_id: gid,
    user_id: uid,
    self_id: '88888',
    sender: { user_id: uid },
    message: [],
    raw_message: '',
    ...extra
  }
}

describe('T1: 协议端不返回（掉线）时快速失败、不无限 pending', () => {
  it('所有群接口挂起 → buildIdentityContext 在超时量级内返回，out 全字段为 null', async () => {
    makeHangBot()
    const e = makeEvent('HANG001', '10001')
    const out = {}
    const started = Date.now()
    const text = await groupOps.buildIdentityContext(e, out)
    const elapsed = Date.now() - started

    assert.ok(elapsed < 2000, `应快速失败而非无限等待，实际耗时=${elapsed}ms`)
    assert.ok(typeof text === 'string' && text.length > 0, '应返回身份上下文文本')
    assert.ok(text.includes('未检测到'), '接口未返回时上下文应标记未检测到')
    assert.equal(out.requesterRole, null)
    assert.equal(out.botRole, null)
    assert.equal(out.ownerUin, null)
    assert.equal(out.groupName, null)
    assert.equal(out.memberCount, null)
  })

  it('getMemberInfo 挂起但 groupInfo 正常 → 仍快速返回且成员数据缺失不影响群信息字段', async () => {
    // 手动构造：成员接口挂起、群信息接口正常
    const group = {
      is_owner: undefined,
      isOwner: undefined,
      getMemberInfo: () => hang(),
      getMemberMap: () => hang(),
      getInfo: async () => ({ groupName: '测试群', member_count: 5, ownerUin: '88888' })
    }
    global.Bot = { uin: '88888', self_id: '88888', pickGroup: () => group }
    const e = makeEvent('HANG002', '10001')
    const out = {}
    const started = Date.now()
    await groupOps.buildIdentityContext(e, out)
    const elapsed = Date.now() - started

    assert.ok(elapsed < 2000, `应快速失败而非无限等待，实际耗时=${elapsed}ms`)
    assert.equal(out.groupName, '测试群')
    assert.equal(out.memberCount, 5)
    assert.equal(out.ownerUin, '88888')
    assert.equal(out.botRole, null, '成员接口挂起时机器人角色应保持未知')
    assert.equal(out.requesterRole, null, '成员接口挂起时发送者角色应保持未知')
  })
})

describe('T2: 数据健康时回填 out 并输出完整上下文', () => {
  it('角色/群信息齐全 → out 字段回填，上下文含具体角色与群信息', async () => {
    const { requesterUid } = makeHealthyBot({ requesterRole: 'admin' })
    const e = makeEvent('HEALTHY01', requesterUid)
    const out = {}
    const text = await groupOps.buildIdentityContext(e, out)

    assert.equal(out.botRole, 'owner')
    assert.equal(out.requesterRole, 'admin')
    assert.equal(out.ownerUin, '88888')
    assert.equal(out.groupName, '测试群')
    assert.equal(out.memberCount, 5)
    assert.ok(text.includes('群主'))
    assert.ok(text.includes('管理员'))
    assert.ok(text.includes('测试群'))
    assert.ok(text.includes('5 人'), '健康数据应写出具体成员数')
    assert.ok(text.includes('本群群主') === false, '健康数据不应误标未知角色')
  })
})

describe('T3: pickHardIdentityFallback 确定性兜底纯逻辑', () => {
  const dead = { requesterRole: null, botRole: null, ownerUin: null, memberCount: null, groupName: null }

  it('全缺失 + 身份问句 → 命中对应 kind 的固定兜底', () => {
    const self = groupOps.pickHardIdentityFallback('我是群主还是管理员？', dead)
    assert.equal(self.kind, 'self')
    assert.ok(self.reply.includes('群接口未返回数据'))

    const bot = groupOps.pickHardIdentityFallback('你是群主吗？', dead)
    assert.equal(bot.kind, 'bot')

    const botP = groupOps.pickHardIdentityFallback('你有管理权限吗？', dead)
    assert.equal(botP.kind, 'bot')

    const g1 = groupOps.pickHardIdentityFallback('群里有几个人？', dead)
    assert.equal(g1.kind, 'group')

    const g2 = groupOps.pickHardIdentityFallback('谁是群主？', dead)
    assert.equal(g2.kind, 'group')

    const g3 = groupOps.pickHardIdentityFallback('群主是谁？', dead)
    assert.equal(g3.kind, 'group')

    const g4 = groupOps.pickHardIdentityFallback('这个群叫什么名字？', dead)
    assert.equal(g4.kind, 'group')
  })

  it('普通闲聊（你好/在吗/天气）不触发兜底', () => {
    assert.equal(groupOps.pickHardIdentityFallback('你好', dead), null)
    assert.equal(groupOps.pickHardIdentityFallback('在吗？', dead), null)
    assert.equal(groupOps.pickHardIdentityFallback('今天天气怎么样？', dead), null)
  })

  it('操作类请求（帮我把群主踢了）不是身份问句，不触发兜底', () => {
    assert.equal(groupOps.pickHardIdentityFallback('帮我把群主踢了', dead), null)
    assert.equal(groupOps.pickHardIdentityFallback('把管理员禁言', dead), null)
  })

  it('部分数据可用 → 不触发兜底（交给模型/提示词规则）', () => {
    assert.equal(
      groupOps.pickHardIdentityFallback('我是群主吗？', { ...dead, requesterRole: 'member' }),
      null
    )
    assert.equal(
      groupOps.pickHardIdentityFallback('你是群主吗？', { ...dead, botRole: 'owner' }),
      null
    )
  })

  it('机器人主人自称身份（我是不是群主）→ 豁免兜底，交给模型', () => {
    assert.equal(groupOps.pickHardIdentityFallback('我是不是群主？', dead, { isMaster: true }), null)
  })

  it('非主人自问身份 → 仍命中兜底', () => {
    const r = groupOps.pickHardIdentityFallback('我是不是群主？', dead, { isMaster: false })
    assert.equal(r.kind, 'self')
  })
})
