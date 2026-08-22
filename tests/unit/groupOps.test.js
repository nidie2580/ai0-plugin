import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 第二轮修复回归测试
 * 覆盖点：
 *  - F-1：无目标操作 targetUid 置 null + 取参改为 args[0]
 *  - F-2：blacklist 指令格式统一为 [action:blacklist:QQ:add|remove]
 *  - U1：parseAndExecuteActions 返回 { cleanText, results } 对象，命令层须用 allActionsOk 判断
 *  - M：isPrivateIpv6 补点分形式 IPv4-compatible（::127.0.0.1 等）
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
})
