import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

/**
 * 第二轮修复回归测试
 * 覆盖点：
 *  - F-1：无目标操作 targetUid 置 null + 取参改为 args[0]
 *  - F-2：blacklist 指令格式统一为 [action:blacklist:QQ:add|remove]
 *  - U1：parseAndExecuteActions 返回 { cleanText, results } 对象，命令层须用 allActionsOk 判断
 *  - M：isPrivateIpv6 补点分形式 IPv4-compatible（::127.0.0.1 等）
 *  - RECALL：撤回消息（recall）—— 消息id制/引用制、自撤/机器人消息免权限、他人消息需群管理、
 *            受保护目标拦截、发送者不可查 fail-closed、适配器能力探测、allowRecall 开关。
 *
 * 这些测试不依赖真实 bot —— 通过 mock global.Bot 模拟适配器。
 */

// 顶层 await import：node --test 在 ESM 模式下支持顶层 await
const groupOps = await import('../../src/groupOps.js')
const sec = await import('../../src/security.js')

// ========== Mock Bot 环境 ==========
function setupMockBot({ botRole = 'owner', requesterRole = 'owner', members = {} } = {}) {
  const gid = 99999
  const requesterUid = '10001'
  const membersMap = {
    [requesterUid]: { role: requesterRole, nickname: '请求者', user_id: requesterUid },
    '88888': { role: 'owner', nickname: '群主', user_id: '88888' },
    '77777': { role: 'admin', nickname: '管理员', user_id: '77777' },
    '66666': { role: 'member', nickname: '普通群员', user_id: '66666' },
    ...members
  }
  const calls = []
  const group = {
    is_owner: botRole === 'owner',
    isOwner: botRole === 'owner',
    getMemberMap: async () => {
      const m = new Map()
      for (const [uid, info] of Object.entries(membersMap)) m.set(uid, info)
      return m
    },
    getMemberInfo: async (uid) => membersMap[String(uid)] || null,
    getGroupMemberInfo: async (uid) => membersMap[String(uid)] || null,
    getInfo: async () => ({ groupName: '测试群', member_count: 5, owner_uin: '88888' }),
    muteMember: async (uid, sec) => { calls.push({ type: 'muteMember', uid, sec }); return true },
    kickMember: async (uid) => { calls.push({ type: 'kickMember', uid }); return true },
    setGroupName: async (n) => { calls.push({ type: 'setGroupName', n }); return true },
    muteAll: async (enable) => { calls.push({ type: 'muteAll', enable }); return true },
    setAdmin: async (uid, isAdmin) => { calls.push({ type: 'setAdmin', uid, isAdmin }); return true },
    setTitle: async (uid, title) => { calls.push({ type: 'setTitle', uid, title }); return true },
    setNotice: async (content) => { calls.push({ type: 'setNotice', content }); return true },
    setSearch: async (enable) => { calls.push({ type: 'setSearch', enable }); return true },
    setBlacklist: async (uid) => { calls.push({ type: 'setBlacklist', uid }); return true },
    removeBlacklist: async (uid) => { calls.push({ type: 'removeBlacklist', uid }); return true },
    setTitleDisplay: async (enable) => { calls.push({ type: 'setTitleDisplay', enable }); return true }
  }
  global.Bot = {
    uin: '88888',
    self_id: '88888',
    pickGroup: () => group,
    getGroupMemberInfo: async (gid, uid) => membersMap[String(uid)] || null
  }
  // 让 bot 角色查询到 botRole：把 bot 自己加进 membersMap
  membersMap['88888'] = { role: botRole, nickname: '机器人', user_id: '88888' }
  return { gid, requesterUid, calls, group }
}

function makeEvent(gid, requesterUid) {
  return {
    group_id: gid,
    user_id: requesterUid,
    sender: { user_id: requesterUid, role: 'owner' },
    self_id: '88888',
    message: [],
    raw_message: ''
  }
}

describe('F-1: 无目标操作 targetUid 置 null + 取参 args[0]', () => {
  it('mute_all:1 不应触发目标保护检查（targetUid 置 null）', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:mute_all:1]', gid, e)
    assert.ok(Array.isArray(r.results))
    assert.equal(r.results.length, 1, '应解析出 1 个动作')
    assert.equal(r.results[0].type, 'mute_all')
    assert.equal(r.results[0].ok, true, 'mute_all:1 应成功执行')
    // 验证确实调用了 muteAll(true)
    assert.equal(calls.length, 1, '底层 muteAll 应被调用一次')
    assert.equal(calls[0].type, 'muteAll')
    assert.equal(calls[0].enable, true)
  })

  it('mute_all:0 关闭全体禁言取参 args[0]', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:mute_all:0]', gid, e)
    assert.equal(r.results[0].ok, true)
    assert.equal(calls[0].enable, false, '应取 args[0]=0 → enable=false')
  })

  it('set_group_name:新群名 取 args[0] 作为群名（不是 args.slice(1)）', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:set_group_name:新群名]', gid, e)
    assert.equal(r.results[0].ok, true)
    assert.equal(calls[0].n, '新群名', '应取 args[0]=新群名，而不是 args.slice(1)=undefined')
  })

  it('set_notice:公告内容 取 args[0] 作为公告', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:set_notice:今日公告]', gid, e)
    assert.equal(r.results[0].ok, true)
    assert.equal(calls[0].content, '今日公告')
  })

  it('group_search:1 取 args[0] 作为开关', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:group_search:1]', gid, e)
    assert.equal(r.results[0].ok, true)
    assert.equal(calls[0].enable, true)
  })

  it('title_display:1 取 args[0] 作为开关', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:title_display:1]', gid, e)
    assert.equal(r.results[0].ok, true)
    assert.equal(calls[0].enable, true)
  })

  it('无目标操作不再因 getMemberInfo 查不到 fail-closed 拒绝', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    // mute_all:1 之前会把 '1' 当成目标QQ去查 getMemberInfo，查不到就 fail-closed 拒绝
    const r = await groupOps.parseAndExecuteActions('[action:mute_all:1]', gid, e)
    assert.equal(r.results[0].ok, true, '无目标操作不应被 fail-closed 拒绝')
    assert.equal(r.results[0].msg, '已开启全体禁言')
    assert.equal(calls.length, 1, '底层 API 应被实际调用')
  })
})

describe('F-2: blacklist 指令格式统一为 [action:blacklist:QQ:add|remove]', () => {
  it('blacklist:QQ:add 应执行 setBlacklist', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:blacklist:66666:add]', gid, e)
    assert.equal(r.results[0].ok, true)
    assert.equal(calls[0].type, 'setBlacklist')
    assert.equal(calls[0].uid, '66666')
  })

  it('blacklist:QQ:remove 应执行 removeBlacklist', async () => {
    const { gid, requesterUid, calls } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:blacklist:66666:remove]', gid, e)
    assert.equal(r.results[0].ok, true)
    assert.equal(calls[0].type, 'removeBlacklist')
    assert.equal(calls[0].uid, '66666')
  })

  it('blacklist 缺少 add/remove 动作参数应失败', async () => {
    const { gid, requesterUid } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    // 旧格式 [action:blacklist:QQ] 不再有 action → args[1] 为 undefined
    const r = await groupOps.parseAndExecuteActions('[action:blacklist:66666]', gid, e)
    assert.equal(r.results[0].ok, false, '旧格式应失败（避免假成功）')
    assert.match(r.results[0].msg, /无效的黑名单操作/)
  })

  it('blacklist:QQ:无效动作 应失败', async () => {
    const { gid, requesterUid } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:blacklist:66666:delete]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /无效的黑名单操作/)
  })
})

describe('U1: parseAndExecuteActions 返回 { cleanText, results } 对象', () => {
  it('返回值是对象不是布尔（命令层须用 allActionsOk 判断）', async () => {
    const { gid, requesterUid } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:mute_all:1]', gid, e)
    assert.equal(typeof r, 'object', '返回值应是对象')
    assert.ok('cleanText' in r, '应有 cleanText 字段')
    assert.ok('results' in r, '应有 results 字段')
    assert.ok(Array.isArray(r.results), 'results 应是数组')
    // 旧代码 const ok = await parseAndExecuteActions(...) 会把对象判为 truthy → 假成功
    // 现在测试 allActionsOk(r) 的判定逻辑
    const allOk = r.results.length > 0 && r.results.every(x => x.ok)
    assert.equal(allOk, true)
  })

  it('操作被拒绝时 results[0].ok=false，allActionsOk 判定为失败', async () => {
    // 机器人非群主/管理员 → 操作应被拒绝
    const { gid, requesterUid } = setupMockBot({ botRole: 'member' })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:mute_all:1]', gid, e)
    assert.equal(r.results[0].ok, false, '机器人普通成员应被拒绝')
    const allOk = r.results.length > 0 && r.results.every(x => x.ok)
    assert.equal(allOk, false, 'allActionsOk 应正确判为失败（不再假成功）')
    assert.ok(r.results[0].msg, '应附带失败原因 msg')
  })
})

describe('INFO: 群成员列表查询（默认 allowMemberListFor=admin，只读但仍收敛权限）', () => {
  it('member_list 返回成员清单（含昵称/QQ/角色）', async () => {
    const { gid, requesterUid } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:member_list:]', gid, e)
    assert.equal(r.results.length, 1)
    assert.equal(r.results[0].ok, true, '管理员/主人查询信息类操作应执行成功')
    assert.ok(r.results[0].msg.includes('本群共'), '应返回总人数')
    assert.ok(r.results[0].msg.includes('群主') || r.results[0].msg.includes('管理员'), '应带角色')
    assert.ok(r.results[0].msg.includes('10001'), '应包含请求者QQ')
  })

  it('关键词过滤 member_list:管理员 只返回匹配成员', async () => {
    const { gid, requesterUid } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:member_list:管理员]', gid, e)
    assert.equal(r.results[0].ok, true)
    // 只应命中名字含"管理员"的 77777
    assert.ok(r.results[0].msg.includes('77777'))
    assert.ok(!r.results[0].msg.includes('普通群员'), '不应包含不匹配成员')
  })

  it('默认 admin 策略下普通成员查询被拒（信息类操作仍收敛权限）', async () => {
    const { gid, requesterUid } = setupMockBot({ botRole: 'member', requesterRole: 'member' })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:member_list:]', gid, e)
    assert.equal(r.results[0].ok, false, '默认 admin 策略下普通成员不应查到完整成员列表')
    assert.match(r.results[0].msg, /管理员/)
  })

  it('member_list 不出现在群操作同行评审待确认清单中', async () => {
    const base = await import('../../src/groupConfirm.js')
    const out = base.parseGroupActions('[action:member_list:]')
    assert.deepEqual(out, [], '信息类操作不应触发同行评审')
  })
})

describe('member_list 权限策略 allowMemberListFor', () => {
  const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
  const backupExists = fs.existsSync(CONFIG_PATH)
  const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

  after(() => {
    if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
    else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
    cfg.setForceLoad(false)
  })

  it('allowMemberListFor=admin: 普通成员被拒，管理员可查', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ groupOps: { allowMemberListFor: 'admin' } }), 'utf-8')
    cfg.setForceLoad(true)
    // 普通群员请求
    const m1 = setupMockBot({ botRole: 'owner', requesterRole: 'member' })
    const e1 = makeEvent(m1.gid, m1.requesterUid)
    const r1 = await groupOps.parseAndExecuteActions('[action:member_list:]', m1.gid, e1)
    assert.equal(r1.results[0].ok, false)
    assert.match(r1.results[0].msg, /管理员/)
    // 管理员请求
    const m2 = setupMockBot({ botRole: 'owner', requesterRole: 'admin' })
    const e2 = makeEvent(m2.gid, m2.requesterUid)
    const r2 = await groupOps.parseAndExecuteActions('[action:member_list:]', m2.gid, e2)
    assert.equal(r2.results[0].ok, true)
  })

  it('allowMemberListFor=master: 仅机器人主人可查', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ groupOps: { allowMemberListFor: 'master' } }), 'utf-8')
    cfg.setForceLoad(true)
    // 主人（bot owner 即 master 场景）：owner 角色请求
    const m = setupMockBot({ botRole: 'owner', requesterRole: 'owner' })
    const e = makeEvent(m.gid, m.requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:member_list:]', m.gid, e)
    assert.equal(r.results[0].ok, false, 'owner 角色不一定等于机器人主人(master)，应仍受 master 门禁约束')
  })
})

describe('M: isPrivateIpv6 补点分形式 IPv4-compatible', () => {
  const { isPrivateIpv6 } = sec.__test__

  it('拒绝 ::127.0.0.1（点分 IPv4-compatible 回环）', () => {
    assert.equal(isPrivateIpv6('::127.0.0.1'), true, '::127.0.0.1 应判定为私有/保留地址')
  })

  it('拒绝 ::10.0.0.1（点分 IPv4-compatible 私有）', () => {
    assert.equal(isPrivateIpv6('::10.0.0.1'), true)
  })

  it('拒绝 ::192.168.1.1（点分 IPv4-compatible 私有）', () => {
    assert.equal(isPrivateIpv6('::192.168.1.1'), true)
  })

  it('拒绝 ::169.254.1.1（点分 IPv4-compatible 链路本地）', () => {
    assert.equal(isPrivateIpv6('::169.254.1.1'), true)
  })

  it('拒绝 ::8.8.8.8（点分 IPv4-compatible 公网IPv4部分也保守拒绝）', () => {
    // 点分形式本身就属保留段，即使 IPv4 部分是公网也保守拒绝
    assert.equal(isPrivateIpv6('::8.8.8.8'), true)
  })

  it('正常公网 IPv6 不应被拒绝', () => {
    assert.equal(isPrivateIpv6('2001:4860:4860::8888'), false)
    assert.equal(isPrivateIpv6('2606:4700:4700::1111'), false)
  })

  it('原有 IPv4-mapped ::ffff:127.0.0.1 仍正确处理', () => {
    assert.equal(isPrivateIpv6('::ffff:127.0.0.1'), true)
    assert.equal(isPrivateIpv6('::ffff:8.8.8.8'), false)
  })

  it('原有点分形式 0:0:0:0:0:0:127.0.0.1 也应拒绝', () => {
    assert.equal(isPrivateIpv6('0:0:0:0:0:0:127.0.0.1'), true)
  })
})

describe('F-2 提示词格式回归：buildGroupContext 应输出新格式', () => {
  it('AI 提示词中 blacklist 格式为 [action:blacklist:目标QQ:add]', async () => {
    const { gid, requesterUid } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const ctx = await groupOps.buildGroupContext(e)
    assert.ok(ctx, '应返回上下文')
    assert.match(ctx, /\[action:blacklist:目标QQ:add\]/, '提示词应为 [action:blacklist:目标QQ:add]')
    assert.match(ctx, /\[action:blacklist:目标QQ:remove\]/, '提示词应为 [action:blacklist:目标QQ:remove]')
    // 旧格式不应再出现
    assert.doesNotMatch(ctx, /\[action:blacklist:add:目标QQ\]/, '旧格式 [action:blacklist:add:目标QQ] 不应再出现')
  })

  it('allowRecall=true 时提示词含撤回消息用法', async () => {
    const { gid, requesterUid } = setupMockBot()
    const e = makeEvent(gid, requesterUid)
    const ctx = await groupOps.buildGroupContext(e)
    assert.ok(ctx)
    assert.match(ctx, /撤回消息（按消息id）：\[action:recall:消息id\]/, '应提示消息id制撤回')
    assert.match(ctx, /撤回消息（引用\/回复的这条）：\[action:recall:引用\]/, '应提示引用制撤回')
  })
})

// ========== RECALL：撤回消息 ==========
// setupRecallBot：在基础 mock 上扩展 发送者查询(getMsg) 与 撤回执行(recallMsg)
function setupRecallBot({ botRole = 'owner', requesterRole = 'owner', senders = {} } = {}) {
  const base = setupMockBot({ botRole, requesterRole })
  const { gid, requesterUid, calls, group } = base
  group.getMsg = async (msgId) => {
    const s = senders[String(msgId)]
    if (!s) return null
    calls.push({ type: 'getMsg', msgId: String(msgId) })
    return { user_id: s }
  }
  group.recallMsg = async (msgId) => {
    calls.push({ type: 'recallMsg', msgId: String(msgId) })
    return true
  }
  return base
}

describe('RECALL: 撤回消息（recall）', () => {
  it('请求者撤回自己的消息 → 放行（普通成员无需管理权限）', async () => {
    const { gid, requesterUid, calls } = setupRecallBot({ botRole: 'member', requesterRole: 'member', senders: { '111222': '10001' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:111222]', gid, e)
    assert.equal(r.results[0].ok, true, '撤回自己的消息应成功')
    assert.ok(calls.some((c) => c.type === 'recallMsg' && c.msgId === '111222'), '应调用 recallMsg(111222)')
  })

  it('撤回机器人自己的消息 → 放行（普通成员可代撤）', async () => {
    const { gid, requesterUid, calls } = setupRecallBot({ botRole: 'member', requesterRole: 'member', senders: { '333444': '88888' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:333444]', gid, e)
    assert.equal(r.results[0].ok, true, '机器人自己的消息任何成员可请求撤回')
    assert.ok(calls.some((c) => c.type === 'recallMsg' && c.msgId === '333444'))
  })

  it('请求者(群主)撤他人普通成员消息且机器人为群主 → 放行', async () => {
    const { gid, requesterUid, calls } = setupRecallBot({ botRole: 'owner', requesterRole: 'owner', senders: { '555666': '66666' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:555666]', gid, e)
    assert.equal(r.results[0].ok, true, '群主撤普通成员消息应成功')
    assert.ok(calls.some((c) => c.type === 'recallMsg' && c.msgId === '555666'))
  })

  it('请求者是普通成员撤他人消息 → 拒绝', async () => {
    const { gid, requesterUid } = setupRecallBot({ botRole: 'owner', requesterRole: 'member', senders: { '555666': '66666' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:555666]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /撤回他人消息需要群主\/管理员\/机器人主人权限/)
  })

  it('请求者是群主但机器人不是管理员 → 拒绝撤他人消息', async () => {
    const { gid, requesterUid } = setupRecallBot({ botRole: 'member', requesterRole: 'owner', senders: { '555666': '66666' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:555666]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /机器人不是群主或管理员/)
  })

  it('目标为管理员(77777)的消息 → 受保护拒绝', async () => {
    const { gid, requesterUid } = setupRecallBot({ botRole: 'owner', requesterRole: 'owner', senders: { '777888': '77777' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:777888]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /受保护/)
  })

  it('目标消息发送者不可查（无 getMsg 能力）→ fail-closed 拒绝', async () => {
    const { gid, requesterUid } = setupMockBot() // 无 getMsg
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:123123]', gid, e)
    assert.equal(r.results[0].ok, false, '查不到发送者应拒绝而非静默放行')
    assert.match(r.results[0].msg, /无法确认发送者/)
  })

  it('引用制：撤回本条请求引用的消息（[action:recall:引用]）', async () => {
    const { gid, requesterUid, calls } = setupRecallBot({ botRole: 'member', requesterRole: 'member', senders: { '999000': '10001' } })
    const e = makeEvent(gid, requesterUid)
    e.message = [{ type: 'reply', id: '999000', data: { id: '999000' } }]
    const r = await groupOps.parseAndExecuteActions('[action:recall:引用]', gid, e)
    assert.equal(r.results[0].ok, true, '引用制撤回自己消息应成功')
    assert.ok(calls.some((c) => c.type === 'recallMsg' && c.msgId === '999000'), '应撤回引用对应的 999000')
  })

  it('引用制但本条消息无引用 → 拒绝并提示改用消息id', async () => {
    const { gid, requesterUid } = setupRecallBot({ botRole: 'member', requesterRole: 'member' })
    const e = makeEvent(gid, requesterUid) // message 为空，无引用
    const r = await groupOps.parseAndExecuteActions('[action:recall:引用]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /未检测到引用/)
  })

  it('多消息id（逗号分隔）逐个撤回', async () => {
    const { gid, requesterUid, calls } = setupRecallBot({ botRole: 'member', requesterRole: 'member', senders: { '1': '10001', '2': '10001' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:1,2]', gid, e)
    assert.equal(r.results[0].ok, true, '两条都应是自己的消息，可撤回')
    const recalled = calls.filter((c) => c.type === 'recallMsg')
    assert.equal(recalled.length, 2, '应逐个调用 recallMsg')
    assert.match(r.results[0].msg, /已撤回 2 条/)
  })

  it('多消息id混合权限（含他人消息）→ 整体拒绝', async () => {
    const { gid, requesterUid } = setupRecallBot({ botRole: 'member', requesterRole: 'member', senders: { '1': '10001', '2': '66666' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:1,2]', gid, e)
    assert.equal(r.results[0].ok, false, '任一目标越权应整体拒绝（fail-closed）')
  })

  it('id 格式无效（非纯数字）→ 拒绝', async () => {
    const { gid, requesterUid } = setupRecallBot()
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:abc]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /消息id格式无效/)
  })

  it('超过 10 条消息 → 拒绝', async () => {
    const { gid, requesterUid } = setupRecallBot()
    const e = makeEvent(gid, requesterUid)
    const ids = Array.from({ length: 11 }, (_, i) => String(i + 1)).join(',')
    const r = await groupOps.parseAndExecuteActions(`[action:recall:${ids}]`, gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /最多撤回10条/)
  })

  it('适配器无撤回方法 → 明确报错不静默', async () => {
    const { gid, requesterUid, group } = setupMockBot() // 无 recallMsg
    group.getMsg = async () => ({ user_id: requesterUid })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:123456]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /撤回失败|不支持撤回消息/)
  })
})

describe('RECALL 开关：allowRecall=false 时拒绝', () => {
  const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
  const backupExists = fs.existsSync(CONFIG_PATH)
  const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

  before(() => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ groupOps: { allowRecall: false } }), 'utf-8')
    cfg.setForceLoad(true)
  })
  after(() => {
    if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
    else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
    cfg.setForceLoad(false)
  })

  it('allowRecall=false → 撤回功能未启用', async () => {
    const { gid, requesterUid } = setupRecallBot({ botRole: 'member', requesterRole: 'member', senders: { '111222': '10001' } })
    const e = makeEvent(gid, requesterUid)
    const r = await groupOps.parseAndExecuteActions('[action:recall:111222]', gid, e)
    assert.equal(r.results[0].ok, false)
    assert.match(r.results[0].msg, /撤回功能未启用/)
  })
})
