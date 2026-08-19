import * as cfg from '../config/index.js'
import * as helper from './helper.js'

/**
 * AI0-Plugin 群操作执行模块（AI驱动）
 *
 * 核心流程：
 *  1) chatService 在群聊时调用 buildGroupContext() 收集群信息
 *  2) 将群信息注入 system prompt，告诉 AI：
 *     - 机器人主人 QQ 列表（不可被操作）
 *     - 请求者 QQ + 角色
 *     - 被@目标 QQ + 角色
 *     - 机器人角色
 *     - 可用操作 + 权限规则
 *     - 动作输出格式约定
 *  3) AI 回复后，chatService 调用 parseAndExecuteActions() 解析回复中的动作标签并执行
 */

/** 获取群成员信息（role: owner/admin/member） */
async function getMemberInfo(groupId, userId) {
  try {
    const bot = global.Bot || global.bot
    const group = bot?.pickGroup?.(groupId)
    if (!group) return null
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

/** 获取机器人自身的 QQ 号和昵称 */
function getBotSelf() {
  try {
    const bot = global.Bot || global.bot
    const uin = bot?.uin || bot?.self_id
    const nickname = bot?.nickname || bot?.nickName || bot?.info?.nickname || '机器人'
    return { uin: uin != null ? String(uin) : null, nickname: String(nickname) }
  } catch (_) {
    return { uin: null, nickname: '机器人' }
  }
}

/**
 * 构建群身份上下文（无条件注入，与是否开启群操作无关）：
 *  - 机器人本身的 QQ + 昵称 + 群内角色(群主/管理员/普通)
 *  - 当前消息发送者的 QQ + 昵称 + 群内角色(群主/管理员/普通)
 *  - 群号
 *  - 并且明确告诉 AI：当被问"我是群主还是管理员？/你是什么角色？/谁是群主..."
 *    必须严格按照以上真实信息回答，不能瞎猜（不要假设谁是群主谁是管理员）。
 */
export async function buildIdentityContext(e) {
  if (!e?.group_id) return null
  const groupId = e.group_id
  const userId = helper.getUserId(e)

  const botSelf = getBotSelf()
  const [botRole, requesterInfo] = await Promise.all([
    getBotRole(groupId),
    userId ? getMemberInfo(groupId, userId) : null
  ])

  const requesterRole = requesterInfo?.role || requesterInfo?.type || 'member'
  const requesterName = requesterInfo?.nickname || requesterInfo?.card || (userId ? `QQ${userId}` : '')
  const botRoleLabel = botRole === 'owner' ? '群主' : botRole === 'admin' ? '管理员' : '普通群员'
  const requesterRoleLabel = requesterRole === 'owner' ? '群主' : requesterRole === 'admin' ? '管理员' : '普通群员'

  const lines = [
    '【当前群的真实身份信息（重要：必须严格按此信息如实回答，不要瞎猜！）】',
    `群号：${groupId}`,
    `你（AI / 机器人）：QQ=${botSelf.uin || '未知'}，昵称=${botSelf.nickname}，在本群角色=${botRoleLabel}${botRole === 'owner' ? '（群主）' : botRole === 'admin' ? '（群管理员）' : '（普通群成员，没有管理权限）'}`,
    `当前消息发送者：QQ=${userId || '未知'}，昵称=${requesterName}，在本群角色=${requesterRoleLabel}${requesterRole === 'owner' ? '（本群群主）' : requesterRole === 'admin' ? '（本群管理员）' : '（普通群成员）'}`
  ]

  lines.push('')
  lines.push('【身份问答规则（必须严格遵守）】')
  lines.push('当用户询问任何与"群内身份/角色"相关的问题时（包括但不限于：')
  lines.push('  "我是群主还是管理员？"、"我是谁？"、"你是群主还是管理员？"、')
  lines.push('  "你是什么角色？"、"谁是群主？"、"谁是管理员？"、"我有管理权限吗？"等），')
  lines.push('你必须严格根据上面提供的真实身份信息来回答，不要靠猜测或假设。')
  lines.push('  - 如果用户问"我是群主还是管理员？"，根据"当前消息发送者"的 role 如实回答。')
  lines.push('  - 如果用户问"你是管理员还是群员？"，根据"你（AI / 机器人）"的 role 如实回答。')
  lines.push('  - 群角色 owner=群主、admin=管理员、member=普通群员，不要搞混。')
  lines.push('  - 没有被问到的第三方身份不要瞎编，说"我只知道当前群里你和我的身份"即可。')

  return lines.join('\n')
}

/** 从消息中提取被@的用户QQ号（排除@机器人本身） */
function extractAtTarget(e) {
  if (!e?.message) return null
  for (const seg of e.message) {
    if (seg.type === 'at' && seg.qq && String(seg.qq) !== String(e.self_id)) {
      return String(seg.qq)
    }
  }
  return null
}

/** 解析时长字符串为秒 */
function parseDuration(str) {
  if (!str) return null
  const s = String(str).trim()
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

function formatDuration(seconds) {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}天`
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}小时`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分钟`
  return `${seconds}秒`
}

/**
 * 构建群操作上下文，注入到 system prompt
 * 返回一段中文文本，告诉 AI 当前群的所有信息
 */
export async function buildGroupContext(e) {
  if (!e?.group_id) return null
  if (cfg.get('groupOps.enabled', true) === false) return null

  const groupId = e.group_id
  const userId = helper.getUserId(e)
  const masters = helper.listMasters()
  const targetUid = extractAtTarget(e)

  // 并行获取角色信息
  const [botRole, requesterInfo, targetInfo] = await Promise.all([
    getBotRole(groupId),
    userId ? getMemberInfo(groupId, userId) : null,
    targetUid ? getMemberInfo(groupId, targetUid) : null
  ])

  const requesterRole = requesterInfo?.role || requesterInfo?.type || 'member'
  const requesterName = requesterInfo?.nickname || requesterInfo?.card || `QQ${userId}`
  const targetRole = targetInfo?.role || targetInfo?.type || 'member'
  const targetName = targetInfo?.nickname || targetInfo?.card || (targetUid ? `QQ${targetUid}` : '')

  const allowKick = cfg.get('groupOps.allowKick', true) !== false
  const allowMute = cfg.get('groupOps.allowMute', true) !== false
  const allowAdmin = cfg.get('groupOps.allowAdmin', true) !== false
  const allowTitle = cfg.get('groupOps.allowTitle', true) !== false
  const defaultMute = cfg.get('groupOps.defaultMuteDuration', 600)

  const lines = [
    '【群操作能力】',
    `当前群号：${groupId}`,
    `机器人角色：${botRole || '未知'}${botRole === 'owner' ? '（群主，可设置管理员）' : botRole === 'admin' ? '（管理员，可踢出/禁言）' : '（普通成员，无法执行管理操作）'}`,
    `机器人主人QQ：${masters.length ? masters.join(', ') : '(无)'}`,
    `机器人主人说明：以上QQ号是机器人主人，任何人（包括群主）都不能对他们执行踢出/禁言操作。`,
    '',
    `当前请求者：QQ=${userId}，昵称=${requesterName}，群内角色=${requesterRole}`,
    `  → 请求者${requesterRole === 'owner' ? '是群主，有权踢出/禁言普通群员和管理员' : requesterRole === 'admin' ? '是管理员，有权踢出/禁言普通群员' : masters.includes(String(userId)) ? '是机器人主人，有权踢出/禁言普通群员' : '是普通群员，无权管理群员'}`,
  ]

  if (targetUid) {
    lines.push('')
    lines.push(`被@目标：QQ=${targetUid}，昵称=${targetName}，群内角色=${targetRole}`)
    const isProtected = masters.includes(targetUid) || targetRole === 'owner' || targetRole === 'admin'
    lines.push(`  → 目标${isProtected ? '⚠️ 受保护（群主/管理员/机器人主人），不可对其执行踢出/禁言' : '是普通群员，可被踢出/禁言'}`)
  }

  lines.push('', '【可用操作与规则】')
  if (allowKick && botRole !== 'member') {
    lines.push('  - 踢出：需要请求者是群主/管理员/机器人主人，且目标不是群主/管理员/机器人主人')
  }
  if (allowMute && botRole !== 'member') {
    lines.push(`  - 禁言：同上权限限制。不指定时长时默认${formatDuration(defaultMute)}。可解禁（时长设为0）`)
  }
  if (allowAdmin && botRole === 'owner') {
    lines.push('  - 设置/取消管理员：仅机器人主人可发起（机器人必须是群主）')
  }
  if (allowTitle) {
    lines.push('  - 设置头衔：所有人可给自己设；群主/管理员/主人可给他人设')
  }

  lines.push('', '【操作输出格式】')
  lines.push('如果你判断请求合法且需要执行群操作，请在回复末尾另起一行，用以下格式输出操作指令（用户不会看到这行，系统会解析并执行）：')
  lines.push('  禁言：[action:mute:目标QQ:时长秒数]')
  lines.push('  解禁：[action:mute:目标QQ:0]')
  lines.push('  踢出：[action:kick:目标QQ]')
  lines.push('  设管理员：[action:set_admin:目标QQ]')
  lines.push('  撤管理员：[action:remove_admin:目标QQ]')
  lines.push('  设头衔：[action:set_title:目标QQ:头衔文字]')
  lines.push('示例：用户说"禁言一下@123 10分钟"，你的回复可以是：')
  lines.push('  好的，我来帮你禁言该成员10分钟。')
  lines.push('  [action:mute:123:600]')
  lines.push('')
  lines.push('重要规则：')
  lines.push('  1) 你必须先判断请求者是否有权限、目标是否受保护，如果无权或受保护，拒绝并说明原因，不要输出操作指令。')
  lines.push('  2) 如果用户没有明确说时长，禁言使用默认时长。')
  lines.push('  3) 一次回复中可以输出多个操作指令。')
  lines.push('  4) 操作指令必须放在回复的最后面，用换行分隔。')

  return lines.join('\n')
}

/**
 * 从 AI 回复中解析操作指令并执行
 * 返回 { cleanText, results }
 */
export async function parseAndExecuteActions(replyText, groupId) {
  const results = []
  // 匹配 [action:type:arg1:arg2...]
  const actionRe = /\[action:(\w+):([^\]]*)\]/g
  const matches = []
  let m
  while ((m = actionRe.exec(replyText)) !== null) {
    matches.push({ full: m[0], type: m[1], args: m[2].split(':') })
  }

  if (!matches.length) return { cleanText: replyText, results }

  // 移除操作指令，得到干净文本
  let cleanText = replyText
  for (const match of matches) {
    cleanText = cleanText.replace(match.full, '').trim()
  }

  const masters = helper.listMasters()
  const botRole = await getBotRole(groupId)

  for (const match of matches) {
    const { type, args } = match
    try {
      const targetUid = args[0]
      if (!targetUid) {
        results.push({ type, ok: false, msg: '未指定目标QQ' })
        continue
      }

      // 获取目标信息
      const targetInfo = await getMemberInfo(groupId, targetUid)
      const targetRole = targetInfo?.role || targetInfo?.type || 'member'
      const isProtected = masters.includes(targetUid) || targetRole === 'owner' || targetRole === 'admin'

      if (type === 'mute') {
        if (cfg.get('groupOps.allowMute', true) === false) {
          results.push({ type, ok: false, msg: '禁言功能未启用' })
          continue
        }
        if (botRole === 'member') {
          results.push({ type, ok: false, msg: '机器人不是管理员/群主' })
          continue
        }
        if (isProtected) {
          results.push({ type, ok: false, msg: `目标 ${targetUid} 受保护（群主/管理员/主人）` })
          continue
        }
        const duration = parseInt(args[1], 10)
        const seconds = Number.isFinite(duration) ? Math.max(0, duration) : cfg.get('groupOps.defaultMuteDuration', 600)
        await executeMute(groupId, targetUid, seconds)
        const display = seconds === 0 ? '解除禁言' : formatDuration(seconds)
        results.push({ type, ok: true, msg: `已${display} ${targetUid}` })

      } else if (type === 'kick') {
        if (cfg.get('groupOps.allowKick', true) === false) {
          results.push({ type, ok: false, msg: '踢出功能未启用' })
          continue
        }
        if (botRole === 'member') {
          results.push({ type, ok: false, msg: '机器人不是管理员/群主' })
          continue
        }
        if (isProtected) {
          results.push({ type, ok: false, msg: `目标 ${targetUid} 受保护` })
          continue
        }
        await executeKick(groupId, targetUid)
        results.push({ type, ok: true, msg: `已踢出 ${targetUid}` })

      } else if (type === 'set_admin') {
        if (cfg.get('groupOps.allowAdmin', true) === false) {
          results.push({ type, ok: false, msg: '管理员功能未启用' })
          continue
        }
        if (botRole !== 'owner') {
          results.push({ type, ok: false, msg: '机器人不是群主' })
          continue
        }
        await executeSetAdmin(groupId, targetUid, true)
        results.push({ type, ok: true, msg: `已将 ${targetUid} 设为管理员` })

      } else if (type === 'remove_admin') {
        if (botRole !== 'owner') {
          results.push({ type, ok: false, msg: '机器人不是群主' })
          continue
        }
        if (masters.includes(targetUid)) {
          results.push({ type, ok: false, msg: '不可取消机器人主人的管理员身份' })
          continue
        }
        await executeSetAdmin(groupId, targetUid, false)
        results.push({ type, ok: true, msg: `已取消 ${targetUid} 的管理员身份` })

      } else if (type === 'set_title') {
        if (cfg.get('groupOps.allowTitle', true) === false) {
          results.push({ type, ok: false, msg: '头衔功能未启用' })
          continue
        }
        const titleText = args.slice(1).join(':').trim()
        if (!titleText) {
          results.push({ type, ok: false, msg: '未指定头衔内容' })
          continue
        }
        await executeSetTitle(groupId, targetUid, titleText.slice(0, 18))
        results.push({ type, ok: true, msg: `已为 ${targetUid} 设置头衔：${titleText.slice(0, 18)}` })

      } else {
        results.push({ type, ok: false, msg: `未知操作类型：${type}` })
      }
    } catch (err) {
      results.push({ type, ok: false, msg: `执行失败：${err.message}` })
    }
  }

  return { cleanText, results }
}

/** 底层执行函数 */
async function executeMute(groupId, userId, seconds) {
  const bot = global.Bot || global.bot
  const group = bot?.pickGroup?.(groupId)
  if (!group) throw new Error('无法获取群信息')
  if (typeof group.muteMember === 'function') await group.muteMember(userId, seconds)
  else if (typeof group.mute === 'function') await group.mute(userId, seconds)
  else throw new Error('当前适配器不支持禁言操作')
}

async function executeKick(groupId, userId) {
  const bot = global.Bot || global.bot
  const group = bot?.pickGroup?.(groupId)
  if (!group) throw new Error('无法获取群信息')
  if (typeof group.kickMember === 'function') await group.kickMember(userId, false)
  else if (typeof group.kick === 'function') await group.kick(userId, false)
  else throw new Error('当前适配器不支持踢出操作')
}

async function executeSetAdmin(groupId, userId, isAdmin) {
  const bot = global.Bot || global.bot
  const group = bot?.pickGroup?.(groupId)
  if (!group) throw new Error('无法获取群信息')
  if (typeof group.setAdmin === 'function') await group.setAdmin(userId, isAdmin)
  else throw new Error('当前适配器不支持设置管理员')
}

async function executeSetTitle(groupId, userId, title) {
  const bot = global.Bot || global.bot
  const group = bot?.pickGroup?.(groupId)
  if (!group) throw new Error('无法获取群信息')
  if (typeof group.setTitle === 'function') await group.setTitle(userId, title)
  else throw new Error('当前适配器不支持设置头衔')
}
