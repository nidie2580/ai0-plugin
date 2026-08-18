import * as cfg from '../config/index.js'
import * as helper from '../src/helper.js'

/**
 * AI0-Plugin 群操作模块
 * 支持：踢出 / 禁言 / 设置管理员 / 授予头衔
 *
 * 权限链：
 *  - 踢出/禁言：仅群主/管理员/机器人主人可发起；不可对群主/管理员/机器人主人使用
 *  - 设置管理员：仅机器人主人可发起；机器人必须是群主
 *  - 授予头衔：群内所有人都能自助申请
 */

/** 获取群成员信息（role: owner/admin/member） */
async function getMemberInfo(groupId, userId) {
  try {
    const bot = global.Bot || global.bot
    const group = bot?.pickGroup?.(groupId)
    if (!group) return null
    // Yunzai/OneBot 兼容：getMemberMap / getMemberInfo / get_member_info
    if (typeof group.getMemberInfo === 'function') {
      return await group.getMemberInfo(userId)
    }
    if (typeof group.getMemberMap === 'function') {
      const map = await group.getMemberMap()
      const entry = map?.get?.(userId) || map?.[userId]
      if (entry) return entry
    }
  } catch (_) {}
  return null
}

/** 获取机器人在群内的角色 */
async function getBotRole(groupId) {
  try {
    const bot = global.Bot || global.bot
    const selfId = bot?.uin || bot?.self_id
    if (!selfId) return null
    const info = await getMemberInfo(groupId, selfId)
    return info?.role || info?.type || null
  } catch (_) {}
  return null
}

/** 检查目标用户是否不可操作（群主/管理员/机器人主人） */
function isProtectedTarget(targetUserId, memberInfo, masters) {
  const uid = String(targetUserId)
  // 机器人主人
  if (masters.includes(uid)) return true
  // 群成员角色
  const role = memberInfo?.role || memberInfo?.type
  if (role === 'owner' || role === 'admin') return true
  return false
}

/** 检查发起者是否有权限操作（群主/管理员/机器人主人） */
function canInitiate(userId, memberInfo, masters) {
  const uid = String(userId)
  if (masters.includes(uid)) return true
  const role = memberInfo?.role || memberInfo?.type
  if (role === 'owner' || role === 'admin') return true
  return false
}

/** 从消息中提取被@的用户QQ号 */
function extractAtTarget(e) {
  if (!e?.message) return null
  for (const seg of e.message) {
    if (seg.type === 'at' && seg.qq && String(seg.qq) !== String(e.self_id)) {
      return String(seg.qq)
    }
  }
  return null
}

/** 从消息中提取数字参数（如禁言时长） */
function extractNumber(text, reg) {
  const m = text.match(reg)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/** 解析时长字符串为秒：支持 "10分钟" "600秒" "1小时" "30" (默认秒) */
function parseDuration(str) {
  if (!str) return null
  const s = str.trim()
  const m = s.match(/^(\d+)\s*(秒|s|sec|seconds?)?$/i)
  if (m) return parseInt(m[1], 10)
  const m2 = s.match(/^(\d+)\s*(分|分钟|min|minutes?)$/i)
  if (m2) return parseInt(m2[1], 10) * 60
  const m3 = s.match(/^(\d+)\s*(时|小时|h|hr|hours?)$/i)
  if (m3) return parseInt(m3[1], 10) * 3600
  const m4 = s.match(/^(\d+)\s*(天|d|days?)$/i)
  if (m4) return parseInt(m4[1], 10) * 86400
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : null
}

export class GroupOps extends plugin {
  constructor() {
    super({
      name: 'AI0-GroupOps',
      dsc: 'AI群操作：踢出/禁言/管理员/头衔',
      event: 'message',
      priority: 4500,
      rule: [
        { reg: '^#ai(踢出|踢人|踢)(\\s+\\S+)?(\\s+.+)?$', fnc: 'kickMember', permission: 'all' },
        { reg: '^#ai(禁言|闭嘴|禁闭)(\\s+\\S+)?(\\s+.+)?$', fnc: 'muteMember', permission: 'all' },
        { reg: '^#ai(解禁|解除禁言)(\\s+\\S+)?$', fnc: 'unmuteMember', permission: 'all' },
        { reg: '^#ai(设置管理员|设管理|任命管理员)(\\s+\\S+)?$', fnc: 'setAdmin', permission: 'master' },
        { reg: '^#ai(取消管理员|撤管理)(\\s+\\S+)?$', fnc: 'removeAdmin', permission: 'master' },
        { reg: '^#ai(头衔|称号|设头衔)(\\s+.+)?$', fnc: 'setTitle', permission: 'all' },
        { reg: '^#ai(全局ai|全局AI|globalai)(\\s+\\S+)?$', fnc: 'toggleGlobalAI', permission: 'master' },
      ]
    })
  }

  /** #ai踢出 @某人 */
  async kickMember() {
    const e = this.e
    if (!e.group_id) return e.reply('❌ 此命令仅在群聊中可用。')
    if (cfg.get('groupOps.enabled', true) === false) return e.reply('❌ 群操作功能未启用。')
    if (cfg.get('groupOps.allowKick', true) === false) return e.reply('❌ 踢出功能未启用。')

    const userId = helper.getUserId(e)
    const masters = helper.listMasters()

    // 获取发起者和目标的信息
    const initiatorInfo = await getMemberInfo(e.group_id, userId)
    if (!canInitiate(userId, initiatorInfo, masters)) {
      return e.reply('❌ 权限不足：仅群主、管理员或机器人主人可以踢出群员。')
    }

    const targetUid = extractAtTarget(e)
    if (!targetUid) return e.reply('❌ 请@要踢出的群员。用法：#ai踢出 @某人')

    const targetInfo = await getMemberInfo(e.group_id, targetUid)
    if (isProtectedTarget(targetUid, targetInfo, masters)) {
      return e.reply('❌ 无法操作：该用户是群主、管理员或机器人主人，不可踢出。')
    }

    // 执行踢出
    try {
      const bot = global.Bot || global.bot
      const group = bot?.pickGroup?.(e.group_id)
      if (!group) return e.reply('❌ 无法获取群信息。')
      if (typeof group.kickMember === 'function') {
        await group.kickMember(targetUid, false)
      } else if (typeof group.kick === 'function') {
        await group.kick(targetUid, false)
      } else {
        return e.reply('❌ 当前适配器不支持踢出操作。')
      }
      return e.reply(`✅ 已踢出群员 ${targetUid}`)
    } catch (err) {
      return e.reply(`❌ 踢出失败：${err.message}`)
    }
  }

  /** #ai禁言 @某人 时长 */
  async muteMember() {
    const e = this.e
    if (!e.group_id) return e.reply('❌ 此命令仅在群聊中可用。')
    if (cfg.get('groupOps.enabled', true) === false) return e.reply('❌ 群操作功能未启用。')
    if (cfg.get('groupOps.allowMute', true) === false) return e.reply('❌ 禁言功能未启用。')

    const userId = helper.getUserId(e)
    const masters = helper.listMasters()

    const initiatorInfo = await getMemberInfo(e.group_id, userId)
    if (!canInitiate(userId, initiatorInfo, masters)) {
      return e.reply('❌ 权限不足：仅群主、管理员或机器人主人可以禁言群员。')
    }

    const targetUid = extractAtTarget(e)
    if (!targetUid) return e.reply('❌ 请@要禁言的群员。用法：#ai禁言 @某人 10分钟')

    const targetInfo = await getMemberInfo(e.group_id, targetUid)
    if (isProtectedTarget(targetUid, targetInfo, masters)) {
      return e.reply('❌ 无法操作：该用户是群主、管理员或机器人主人，不可禁言。')
    }

    // 解析禁言时长
    const text = helper.getMessageText(e)
    const afterAt = text.replace(/^#ai(禁言|闭嘴|禁闭)\s*/, '').replace(/@\S+\s*/, '').trim()
    const duration = parseDuration(afterAt) || cfg.get('groupOps.defaultMuteDuration', 600)

    try {
      const bot = global.Bot || global.bot
      const group = bot?.pickGroup?.(e.group_id)
      if (!group) return e.reply('❌ 无法获取群信息。')
      if (typeof group.muteMember === 'function') {
        await group.muteMember(targetUid, duration)
      } else if (typeof group.mute === 'function') {
        await group.mute(targetUid, duration)
      } else {
        return e.reply('❌ 当前适配器不支持禁言操作。')
      }
      const display = duration >= 3600 ? `${Math.floor(duration / 3600)}小时` : duration >= 60 ? `${Math.floor(duration / 60)}分钟` : `${duration}秒`
      return e.reply(`✅ 已禁言 ${targetUid}，时长 ${display}`)
    } catch (err) {
      return e.reply(`❌ 禁言失败：${err.message}`)
    }
  }

  /** #ai解禁 @某人 */
  async unmuteMember() {
    const e = this.e
    if (!e.group_id) return e.reply('❌ 此命令仅在群聊中可用。')

    const userId = helper.getUserId(e)
    const masters = helper.listMasters()

    const initiatorInfo = await getMemberInfo(e.group_id, userId)
    if (!canInitiate(userId, initiatorInfo, masters)) {
      return e.reply('❌ 权限不足：仅群主、管理员或机器人主人可以解除禁言。')
    }

    const targetUid = extractAtTarget(e)
    if (!targetUid) return e.reply('❌ 请@要解禁的群员。用法：#ai解禁 @某人')

    try {
      const bot = global.Bot || global.bot
      const group = bot?.pickGroup?.(e.group_id)
      if (typeof group.muteMember === 'function') {
        await group.muteMember(targetUid, 0)
      } else if (typeof group.mute === 'function') {
        await group.mute(targetUid, 0)
      } else {
        return e.reply('❌ 当前适配器不支持解禁操作。')
      }
      return e.reply(`✅ 已解除 ${targetUid} 的禁言`)
    } catch (err) {
      return e.reply(`❌ 解禁失败：${err.message}`)
    }
  }

  /** #ai设置管理员 @某人（仅机器人主人；机器人必须是群主） */
  async setAdmin() {
    const e = this.e
    if (!e.group_id) return e.reply('❌ 此命令仅在群聊中可用。')
    if (cfg.get('groupOps.allowAdmin', true) === false) return e.reply('❌ 设置管理员功能未启用。')

    const userId = helper.getUserId(e)
    const masters = helper.listMasters()
    if (!masters.includes(String(userId))) {
      return e.reply('❌ 仅机器人主人可以设置管理员。')
    }

    // 检查机器人是否是群主
    const botRole = await getBotRole(e.group_id)
    if (botRole !== 'owner') {
      return e.reply(`❌ 机器人在本群的角色是「${botRole || '未知'}」，必须是群主才能设置管理员。`)
    }

    const targetUid = extractAtTarget(e)
    if (!targetUid) return e.reply('❌ 请@要设为管理员的群员。用法：#ai设置管理员 @某人')

    try {
      const bot = global.Bot || global.bot
      const group = bot?.pickGroup?.(e.group_id)
      if (typeof group.setAdmin === 'function') {
        await group.setAdmin(targetUid, true)
      } else {
        return e.reply('❌ 当前适配器不支持设置管理员。')
      }
      return e.reply(`✅ 已将 ${targetUid} 设为管理员`)
    } catch (err) {
      return e.reply(`❌ 设置管理员失败：${err.message}`)
    }
  }

  /** #ai取消管理员 @某人（仅机器人主人；机器人必须是群主） */
  async removeAdmin() {
    const e = this.e
    if (!e.group_id) return e.reply('❌ 此命令仅在群聊中可用。')

    const userId = helper.getUserId(e)
    const masters = helper.listMasters()
    if (!masters.includes(String(userId))) {
      return e.reply('❌ 仅机器人主人可以取消管理员。')
    }

    const botRole = await getBotRole(e.group_id)
    if (botRole !== 'owner') {
      return e.reply(`❌ 机器人在本群的角色是「${botRole || '未知'}」，必须是群主才能取消管理员。`)
    }

    const targetUid = extractAtTarget(e)
    if (!targetUid) return e.reply('❌ 请@要取消管理员的群员。用法：#ai取消管理员 @某人')

    // 不可取消机器人主人
    if (masters.includes(targetUid)) {
      return e.reply('❌ 无法取消机器人主人的管理员身份。')
    }

    try {
      const bot = global.Bot || global.bot
      const group = bot?.pickGroup?.(e.group_id)
      if (typeof group.setAdmin === 'function') {
        await group.setAdmin(targetUid, false)
      } else {
        return e.reply('❌ 当前适配器不支持取消管理员。')
      }
      return e.reply(`✅ 已取消 ${targetUid} 的管理员身份`)
    } catch (err) {
      return e.reply(`❌ 取消管理员失败：${err.message}`)
    }
  }

  /** #ai头衔 头衔名  或  #ai头衔 @某人 头衔名（群内所有人都能自助申请） */
  async setTitle() {
    const e = this.e
    if (!e.group_id) return e.reply('❌ 此命令仅在群聊中可用。')
    if (cfg.get('groupOps.allowTitle', true) === false) return e.reply('❌ 头衔功能未启用。')

    const userId = helper.getUserId(e)
    const text = helper.getMessageText(e)

    // 解析：@某人 + 头衔文本
    const targetUid = extractAtTarget(e)
    let titleUid = userId // 默认给自己设头衔
    let titleText = ''

    if (targetUid) {
      // @了别人，但只有群主/管理员/主人能给其他人设头衔
      const masters = helper.listMasters()
      const initiatorInfo = await getMemberInfo(e.group_id, userId)
      const role = initiatorInfo?.role || initiatorInfo?.type
      const canSetOthers = masters.includes(String(userId)) || role === 'owner' || role === 'admin'
      if (!canSetOthers) {
        return e.reply('❌ 给他人设置头衔需要群主/管理员/机器人主人权限。你可以直接发「#ai头衔 你的头衔名」给自己设置。')
      }
      titleUid = targetUid
      titleText = text.replace(/^#ai(头衔|称号|设头衔)\s*/, '').replace(/@\S+\s*/, '').trim()
    } else {
      // 没有@别人，给自己设头衔
      titleText = text.replace(/^#ai(头衔|称号|设头衔)\s*/, '').trim()
    }

    if (!titleText) {
      return e.reply('❌ 请输入头衔内容。用法：\n  给自己：#ai头衔 我的头衔\n  给他人：#ai头衔 @某人 头衔名')
    }

    // 限制头衔长度
    if (titleText.length > 18) {
      titleText = titleText.slice(0, 18)
    }

    try {
      const bot = global.Bot || global.bot
      const group = bot?.pickGroup?.(e.group_id)
      if (typeof group.setTitle === 'function') {
        await group.setTitle(titleUid, titleText)
      } else {
        return e.reply('❌ 当前适配器不支持设置头衔。')
      }
      return e.reply(`✅ 已设置头衔：${titleText}`)
    } catch (err) {
      return e.reply(`❌ 设置头衔失败：${err.message}`)
    }
  }

  /** #ai全局ai on/off 或 #ai全局ai 群号 切换全局AI模式 */
  async toggleGlobalAI() {
    const e = this.e
    const userId = helper.getUserId(e)
    const masters = helper.listMasters()
    if (!masters.includes(String(userId))) {
      return e.reply('❌ 仅机器人主人可以切换全局AI模式。')
    }

    const text = helper.getMessageText(e)
    const arg = text.replace(/^#ai(全局ai|全局AI|globalai)\s*/i, '').trim().toLowerCase()

    const config = cfg.loadConfig()
    if (!config.chat) config.chat = {}

    if (arg === 'on' || arg === '开' || arg === '开启' || arg === 'true') {
      config.chat.globalAI = true
      // 如果当前在群聊中，自动把该群加入 globalAIGroups
      if (e.group_id) {
        if (!Array.isArray(config.chat.globalAIGroups)) config.chat.globalAIGroups = []
        const gid = String(e.group_id)
        if (!config.chat.globalAIGroups.includes(gid)) {
          config.chat.globalAIGroups.push(gid)
        }
      }
      cfg.saveConfig(config)
      const groups = (config.chat.globalAIGroups || []).join(', ')
      return e.reply(`✅ 全局AI已开启\n当前启用群：${groups || '(未设置，群聊中将不生效)'}`)
    }

    if (arg === 'off' || arg === '关' || arg === '关闭' || arg === 'false') {
      config.chat.globalAI = false
      cfg.saveConfig(config)
      return e.reply('✅ 全局AI已关闭，群聊中仅回复@机器人的消息。')
    }

    // 无参数或"列表"：显示当前状态
    const status = config.chat?.globalAI ? '✅ 开启' : '❌ 关闭'
    const groups = (config.chat?.globalAIGroups || []).join(', ')
    return e.reply(
      `全局AI模式：${status}\n` +
      `启用群号：${groups || '(空)'}\n\n` +
      `用法：\n` +
      `  #ai全局ai 开  → 开启（当前群自动加入列表）\n` +
      `  #ai全局ai 关  → 关闭\n` +
      `  也可在 config.yaml 中手动设置 chat.globalAIGroups 列表`
    )
  }
}
