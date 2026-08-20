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

/** 获取群成员信息（role: owner/admin/member）
 *  尝试多种适配器实现，兼容 XRK-Yunzai + NapCat/LLOneBot/ICQQ/QSign 等不同后端
 */
async function getMemberInfo(groupId, userId) {
  if (!groupId || !userId) return null
  try {
    const bot = global.Bot || global.bot
    if (!bot) return null
    const group = bot.pickGroup?.(groupId) || bot.getGroup?.(groupId) || bot.Group?.pick?.(groupId)
    if (!group) return null

    // 1) 标准方法
    if (typeof group.getMemberInfo === 'function') {
      const r = await group.getMemberInfo(userId).catch(() => null)
      if (r) return r
    }
    // 2) 别名
    for (const fn of ['getMember', 'getGroupMemberInfo', 'getMemberInfoV2']) {
      if (typeof group[fn] === 'function') {
        const r = await group[fn](userId).catch(() => null)
        if (r) return r
      }
    }
    // 3) getMemberMap（同步/异步都兼容）再兜底
    if (typeof group.getMemberMap === 'function') {
      const map = await Promise.resolve(group.getMemberMap()).catch(() => null)
      if (map) {
        const entry = map.get?.(userId) ?? map?.[userId] ?? map.get?.(String(userId)) ?? map.get?.(Number(userId))
        if (entry) return entry
        // 有些实现是 Map<Number,Object>；遍历值找 uid/uin/user_id 匹配
        if (typeof map.values === 'function') {
          for (const v of map.values()) {
            const u = String(v?.uin ?? v?.uid ?? v?.user_id ?? v?.qq ?? v?.userId ?? '')
            if (u && u === String(userId)) return v
          }
        }
      }
    }
    // 4) bot 直接方法
    for (const fn of ['getGroupMemberInfo', 'getMemberInfo']) {
      if (typeof bot[fn] === 'function') {
        const r = await bot[fn](groupId, userId).catch(() => null)
        if (r) return r
      }
    }
    // 5) group.info.members 数组兜底（极少数情况）
    const members = group?.info?.members || group?.memberList || group?.members || []
    if (Array.isArray(members) && members.length) {
      const hit = members.find(m => String(m?.uin ?? m?.uid ?? m?.user_id ?? m?.qq ?? '') === String(userId))
      if (hit) return hit
    }
    // 6) 部分适配器（ICQQ/真寻）把群员缓存在 group成员数组字段上（通过 Object.getOwnPropertyNames 猜测）
    try {
      const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(group)).concat(Object.keys(group))
      const cacheKey = keys.find(k => /(member|cache|list|map|all).{0,10}(member|cache|list|map|info)/i.test(k) && typeof group[k] !== 'function')
      if (cacheKey) {
        const v = group[cacheKey]
        if (v?.get instanceof Function) {
          const maybe = v.get(userId) || v.get(String(userId))
          if (maybe) return maybe
        } else if (Array.isArray(v)) {
          const hit = v.find(m => String(m?.uin ?? m?.uid ?? m?.user_id ?? m?.qq ?? '') === String(userId))
          if (hit) return hit
        } else if (typeof v === 'object' && v) {
          const maybe = v[userId] || v[String(userId)]
          if (maybe) return maybe
        }
      }
    } catch (_) {}
  } catch (_) {}
  return null
}

/** 提取 owner/role 字段（兼容多种字段命名） */
export function _roleOf(obj) {
  if (!obj) return null
  const r = obj.role ?? obj.type ?? obj.permission ?? obj.user_role ?? obj.group_role ?? obj.memberRole ?? null
  if (r == null) return null
  const s = String(r).toLowerCase()
  if (s === 'owner' || s.includes('群主') || s === '1' || s === 1) return 'owner'
  if (s === 'admin' || s === 'administrator' || s.includes('管理') || s === '2' || s === 2) return 'admin'
  if (s === 'member' || s === 'common' || s.includes('普通') || s === '0' || s === 0) return 'member'
  // 数字：ICQQ/NapCat 常见 0=普通 1=群主 2=管理员
  if (s === '1') return 'owner'
  if (s === '2') return 'admin'
  if (s === '0') return 'member'
  return s || null
}

/** 获取机器人在群内的角色
 *  兼容：group.is_owner（XRK适配器直接布尔字段）+ getMemberMap 查自己条目
 */
async function getBotRole(groupId) {
  if (!groupId) return null
  try {
    const bot = global.Bot || global.bot
    const selfId = String(bot?.uin || bot?.self_id || '')
    if (!selfId) return null
    const group = bot.pickGroup?.(groupId) || bot.getGroup?.(groupId) || bot.Group?.pick?.(groupId)
    if (!group) return null

    // 0 成本布尔兜底：XRK适配器在 group.is_owner（true/false）上直接给出"机器人是否群主"
    if (group.is_owner === true) return 'owner'
    if (typeof group.is_owner !== 'undefined' && group.is_owner === false) {
      // 群主是 false → 但可能是 admin；继续往下查
    }
    // 也有 isOwner 驼峰写法
    if (group.isOwner === true) return 'owner'

    // 查 getMemberInfo 自己条目（老逻辑 + 新兼容）
    const info = await getMemberInfo(groupId, selfId)
    const r = _roleOf(info)
    if (r) return r

    // 最后：如果 is_owner=false 但我们又没拿到角色，默认至少是 member 吗？
    // 不返回 null，先保持未知 → 交给上层 unknown 保守处理
    return null
  } catch (_) {}
  return null
}

/** 获取群信息：群名 / 成员数 / 群主 UIN 等
 *  同样做多层适配，覆盖 NapCat/LLOneBot/ICQQ 各种字段命名
 */
async function getGroupInfo(groupId) {
  if (!groupId) return null
  try {
    const bot = global.Bot || global.bot
    if (!bot) return null
    const group = bot.pickGroup?.(groupId) || bot.getGroup?.(groupId) || bot.Group?.pick?.(groupId)
    if (!group) return null

    let info = null
    // A) pickGroup 上的标准方法
    for (const fn of ['getInfo', 'getGroupInfo', 'info', 'fetchInfo', 'refreshInfo']) {
      if (typeof group[fn] === 'function') {
        const r = await group[fn]().catch(() => null)
        if (r && typeof r === 'object') { info = r; break }
      }
    }
    // B) bot 直接方法
    if (!info) {
      for (const fn of ['getGroupInfo', 'getGroup', 'pickGroupInfo', 'getGroupDetail']) {
        if (typeof bot[fn] === 'function') {
          const r = await bot[fn](groupId).catch(() => null)
          if (r && typeof r === 'object') { info = r; break }
        }
      }
    }
    // C) 已经挂在 group.info / group.groupInfo / group.$info 上
    if (!info) {
      for (const k of ['info', 'groupInfo', '$info', '_info', 'rawInfo']) {
        const v = group[k]
        if (v && typeof v === 'object' && (v.groupName || v.name || v.group_name)) { info = v; break }
      }
    }
    // D) 事件对象 e 上会挂，但这里没法直接取；调用方会再兜底 e.group_name

    // 同步属性兜底（有些实现直接挂在 group 上）
    // XRK 诊断：group.group_name / group.member_count / group.max_member_count 直接挂在根上（下划线风格）
    const name =
      info?.groupName ?? info?.group_name ?? info?.name ?? info?.groupName2 ?? info?.GroupName ??
      group.name ?? group.groupName ?? group.group_name ??
      null
    const memberCount = Number(
      info?.memberCount ?? info?.member_count ?? info?.memberNum ?? info?.memberNumber ??
      info?.member_size ?? info?.members?.length ??
      group.memberCount ?? group.member_count ?? group.memberNum ??
      null
    )
    const maxMember = Number(
      info?.maxMember ?? info?.max_member ?? info?.maxMemberCount ??
      group.maxMember ?? group.max_member_count ?? group.maxMemberCount ??
      null
    )
    let ownerUin =
      info?.ownerUin ?? info?.owner ?? info?.owner_id ?? info?.ownerUin2 ?? info?.OwnerUin ??
      info?.owner_qq ?? info?.creatorUin ?? info?.creator ??
      group.ownerUin ?? group.owner ?? group.owner_id ??
      null

    // E) 终极兜底：getGroupInfo 没有 owner 字段（XRK就是这个情况），
    //    那就扫 getMemberMap() 找第一个 role==='owner' 的 user_id 作为群主 UIN。
    //    为避免大群卡死，上限 500 人；超过 500 人时不做此兜底。
    if (ownerUin == null && typeof group.getMemberMap === 'function') {
      try {
        const map = await Promise.resolve(group.getMemberMap()).catch(() => null)
        if (map) {
          const size = map.size ?? Object.keys(map).length ?? 0
          if (size > 0 && size <= 500) {
            const values = typeof map.values === 'function'
              ? Array.from(map.values())
              : Object.values(map)
            for (const v of values) {
              const role = _roleOf(v)
              if (role === 'owner') {
                const uid = String(v?.user_id ?? v?.uin ?? v?.qq ?? v?.uid ?? v?.userId ?? '')
                if (uid) { ownerUin = uid; break }
              }
            }
          }
        }
      } catch (_) {}
    }

    if (!name && memberCount == null && ownerUin == null) {
      // 信息全部取不到，返回 null 让上层统一标"未检测到"
      return null
    }
    return {
      name,
      memberCount: Number.isFinite(memberCount) ? memberCount : null,
      maxMember: Number.isFinite(maxMember) ? maxMember : null,
      ownerUin: ownerUin != null ? String(ownerUin) : null,
      _rawInfoKeys: info ? Object.keys(info).slice(0, 30) : null   // 诊断时方便
    }
  } catch (_) {}
  return null
}

/** 角色 → 中文标签 */
function roleToLabel(role, unknownAsMember = false) {
  if (role === 'owner') return '群主'
  if (role === 'admin') return '管理员'
  if (role === 'member') return '普通群员'
  if (unknownAsMember) return '普通群员'
  return '未检测到（机器人接口未返回，不要脑补为普通群员）'
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
 *  - 群号 / 群名 / 成员数 / 群主 UIN
 *  - 机器人本身的 QQ + 昵称 + 群内角色(群主/管理员/普通/未检测到)
 *  - 当前消息发送者的 QQ + 昵称 + 群内角色
 *  - 明确告诉 AI：信息未检测到时，回答"我这边暂未获取到"，不要脑补成默认的普通群员。
 */
export async function buildIdentityContext(e) {
  if (!e?.group_id) return null
  const groupId = e.group_id
  const userId = helper.getUserId(e)

  // 从 e 上兜底抓群名（很多适配器会把 group_name 挂在事件对象上）
  const eGroupName = e.groupName || e.group_name || e.group?.groupName || e.group?.name || null

  const botSelf = getBotSelf()
  const [botRoleRaw, requesterInfo, groupInfo] = await Promise.all([
    getBotRole(groupId),
    userId ? getMemberInfo(groupId, userId) : null,
    getGroupInfo(groupId)
  ])

  // 发送者角色：0成本优先从事件对象 e.sender.role / permission / group_role 取
  // （XRK诊断已证实 e.sender.role = "owner" 直接有值，无需API请求）
  const senderRoleFromE = e.sender ? _roleOf(e.sender) : null
  const requesterRoleRaw = senderRoleFromE || _roleOf(requesterInfo)
  const requesterName = requesterInfo?.nickname || requesterInfo?.card || e.sender?.card || e.sender?.nickname || (userId ? `QQ${userId}` : '')
  const groupName = groupInfo?.name || eGroupName || null
  const memberCount = groupInfo?.memberCount || null
  const ownerUin = groupInfo?.ownerUin != null ? String(groupInfo.ownerUin) : null

  // 重点：拿不到角色时 DON'T fallback 为 member，而是明确标记「未检测到」
  // 这是之前出现"你们两个都是普通群员"这种错误回答的根因。
  const botRoleLabel = roleToLabel(botRoleRaw, false)
  const requesterRoleLabel = roleToLabel(requesterRoleRaw, false)
  const botRoleDesc = (() => {
    if (botRoleRaw === 'owner') return '（群主，可设置管理员）'
    if (botRoleRaw === 'admin') return '（群管理员，可踢出/禁言）'
    if (botRoleRaw === 'member') return '（普通群成员，没有管理权限）'
    return '（接口未返回，不要臆测）'
  })()
  const requesterRoleDesc = (() => {
    if (requesterRoleRaw === 'owner') return '（本群群主）'
    if (requesterRoleRaw === 'admin') return '（本群管理员）'
    if (requesterRoleRaw === 'member') return '（普通群成员）'
    return '（接口未返回，不要臆测）'
  })()

  const lines = [
    '【当前群的真实信息（重要：必须严格按此信息如实回答，信息未检测到时就说未检测到，不要瞎猜！）】',
    `群号：${groupId}`,
    `群名：${groupName ? groupName : '未检测到（机器人接口未返回群名称字段）'}`,
    `群成员数：${Number.isFinite(memberCount) ? memberCount + ' 人' : '未检测到'}`,
    `群主 UIN：${ownerUin ? ownerUin : '未检测到'}`
  ]

  lines.push('')
  lines.push(`你（AI / 机器人）：QQ=${botSelf.uin || '未知'}，昵称=${botSelf.nickname}，在本群角色=${botRoleLabel}${botRoleDesc}`)
  lines.push(`当前消息发送者：QQ=${userId || '未知'}，昵称=${requesterName}，在本群角色=${requesterRoleLabel}${requesterRoleDesc}`)

  // 如果发送者 QQ 与群主 UIN 一致、但接口没有返回 owner，仍然显式提示"根据群主UIN匹配，发送者就是群主"
  if (ownerUin && userId && String(userId) === String(ownerUin) && requesterRoleRaw !== 'owner') {
    lines.push(`⚠️ 补充：当前消息发送者的QQ(${userId})与本群群主UIN(${ownerUin})完全一致，因此发送者一定是本群群主。即使接口返回的角色不是 owner，也请按"发送者 = 群主"来回答。`)
  }
  // 如果机器人 QQ 与群主 UIN 一致同理
  if (ownerUin && botSelf.uin && String(botSelf.uin) === String(ownerUin) && botRoleRaw !== 'owner') {
    lines.push(`⚠️ 补充：你（机器人）的QQ(${botSelf.uin})与本群群主UIN(${ownerUin})完全一致，因此你就是本群群主。即使接口返回的角色不是 owner，也请按"你 = 群主"来回答。`)
  }

  lines.push('')
  lines.push('【身份问答规则（必须严格遵守！违反 = 回答错误）】')
  lines.push('当用户询问任何与"群身份 / 角色 / 基本信息"相关的问题时：')
  lines.push('  - 问题示例："我是群主还是管理员？"、"我是谁？"、"你是群主还是管理员？"')
  lines.push('            "你是什么角色？"、"谁是群主？"、"我有管理权限吗？"')
  lines.push('            "这个群叫啥？"、"群名叫什么？"、"群里有多少人？"、"群里还有谁？"')
  lines.push('  - 严格根据上方真实信息回答。')
  lines.push('  - 只有当上方明确写了"群主" / "管理员" / "普通群员"时才能这么答；')
  lines.push('    写的是"未检测到（接口未返回）"时，必须回答"我这边暂未获取到你的角色信息"，绝对不能脑补成普通群员！')
  lines.push('  - "群名"未检测到时，回答"我这边没拿到群名"，不要编。')
  lines.push('  - "群里还有谁？" / "都有谁？"：除非把群成员列表也注入给你了，否则一律回答"我只知道你和我在群里，其他成员信息没拿到不能瞎编。"')
  lines.push('  - 回答语气要自然，可以用 emoji、加一些可爱的口癖，但不能改变事实本身。')
  lines.push('  - owner = 群主，admin = 管理员，member = 普通群员，三者不要搞混。')

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
  const [botRoleRaw, requesterInfo, targetInfo, groupInfoRaw] = await Promise.all([
    getBotRole(groupId),
    userId ? getMemberInfo(groupId, userId) : null,
    targetUid ? getMemberInfo(groupId, targetUid) : null,
    getGroupInfo(groupId)
  ])
  const botRole = botRoleRaw || 'unknown'  // owner/admin/member/unknown
  const requesterRole = _roleOf(requesterInfo) || 'unknown'
  const targetRole = _roleOf(targetInfo) || 'unknown'
  const requesterName = requesterInfo?.nickname || requesterInfo?.card || `QQ${userId}`
  const targetName = targetInfo?.nickname || targetInfo?.card || (targetUid ? `QQ${targetUid}` : '')

  // 群主 UIN 兜底：如果能拿到 ownerUin，即使角色未知也能反向推断
  const ownerUin = groupInfoRaw?.ownerUin != null ? String(groupInfoRaw.ownerUin) : null
  let requesterInferred = requesterRole
  let botInferred = botRole
  if (ownerUin && userId && String(userId) === ownerUin && requesterRole === 'unknown') requesterInferred = 'owner'
  if (ownerUin) {
    const bSelf = getBotSelf()
    if (bSelf.uin && String(bSelf.uin) === ownerUin && botRole === 'unknown') botInferred = 'owner'
  }

  // 身份规则：只有明确是 owner/admin/member 才允许；unknown 一律当作"角色未知 → 不能执行操作 / 只能保守放行"
  const isRequesterElevated = requesterInferred === 'owner' || requesterInferred === 'admin' || masters.includes(String(userId))
  const botCanManage = botInferred === 'owner' || botInferred === 'admin'
  const targetIsProtected = (() => {
    if (!targetUid) return false
    if (masters.includes(targetUid)) return true
    if (targetRole === 'owner' || targetRole === 'admin') return true
    // ownerUin 反向兜底：目标 UIN 就是群主 → 受保护
    if (ownerUin && String(targetUid) === ownerUin) return true
    return false
  })()

  const allowKick = cfg.get('groupOps.allowKick', true) !== false
  const allowMute = cfg.get('groupOps.allowMute', true) !== false
  const allowAdmin = cfg.get('groupOps.allowAdmin', true) !== false
  const allowTitle = cfg.get('groupOps.allowTitle', true) !== false
  const defaultMute = cfg.get('groupOps.defaultMuteDuration', 600)

  const botRoleZh = botInferred === 'owner' ? '群主' : botInferred === 'admin' ? '管理员' : botInferred === 'member' ? '普通成员' : '未知（接口未返回，执行操作时保守处理）'
  const reqRoleZh = requesterInferred === 'owner' ? '群主' : requesterInferred === 'admin' ? '管理员' : requesterInferred === 'member' ? '普通群员' : masters.includes(String(userId)) ? '机器人主人' : '未知（接口未返回）'
  const tgtRoleZh = targetRole === 'owner' ? '群主' : targetRole === 'admin' ? '管理员' : targetRole === 'member' ? '普通群员' : (targetUid ? '未知' : '-')

  const lines = [
    '【群操作能力】',
    `当前群号：${groupId}`,
    `机器人角色：${botRoleZh}${botInferred === 'owner' ? '（群主，可设置管理员）' : botInferred === 'admin' ? '（管理员，可踢出/禁言）' : botInferred === 'member' ? '（普通成员，无法执行管理操作）' : '（身份未知，按保守策略不允许执行管理操作）'}`,
    `机器人主人QQ：${masters.length ? masters.join(', ') : '(无)'}`,
    `机器人主人说明：以上QQ号是机器人主人，任何人（包括群主）都不能对他们执行踢出/禁言操作。`,
    `说明：接口未返回明确角色时一律按 unknown 处理，不要脑补为普通成员。` + (ownerUin ? `（已确认群主UIN=${ownerUin}）` : ''),
    '',
    `当前请求者：QQ=${userId}，昵称=${requesterName}，群内角色=${reqRoleZh}`,
    `  → 请求者${isRequesterElevated ? (requesterInferred === 'owner' ? '是群主，有权踢出/禁言普通群员和管理员' : requesterInferred === 'admin' ? '是管理员，有权踢出/禁言普通群员' : '是机器人主人，有权踢出/禁言普通群员') : '身份非群主/管理员/主人，无权管理群员'}`
  ]

  if (targetUid) {
    lines.push('')
    lines.push(`被@目标：QQ=${targetUid}，昵称=${targetName}，群内角色=${tgtRoleZh}`)
    lines.push(`  → 目标${targetIsProtected ? '⚠️ 受保护（群主/管理员/机器人主人），不可对其执行踢出/禁言' : '是普通群员，可被踢出/禁言（前提：请求者有权限、且机器人有管理权限）'}`)
  }

  lines.push('', '【可用操作与规则】')
  // 只有明确知道 bot 是 owner/admin 才允许它执行管理操作；身份 unknown 时一律禁止（宁可保守，不能越权）
  if (allowKick && botCanManage) {
    lines.push('  - 踢出：需要请求者是群主/管理员/机器人主人，且目标不是群主/管理员/机器人主人。机器人身份不明确时不得执行。')
  }
  if (allowMute && botCanManage) {
    lines.push(`  - 禁言：同上权限限制。不指定时长时默认${formatDuration(defaultMute)}。可解禁（时长设为0）`)
  }
  if (allowAdmin && botInferred === 'owner') {
    lines.push('  - 设置/取消管理员：仅机器人主人可发起（机器人必须明确是群主）')
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
 * 将 userId/sessionId 等外部输入做"路径安全化"：
 *  1) 仅允许 ASCII 字母/数字/-/_/.，其他字符一律剔除
 *  2) 禁止 .. 和开头的 .
 *  3) 空串返回 null
 */
function safePathComponent(raw, allowDotSlash = false) {
  if (raw == null) return null
  let s = String(raw).trim()
  if (!s) return null
  if (!allowDotSlash) s = s.replace(/\.\./g, '').replace(/^\.+/, '')
  s = s.replace(/[^\w.-]/g, '')
  // 再兜底：path.join 仍可能被 / 绕过，所以去掉 / \
  s = s.replace(/[\/\\]/g, '')
  return s || null
}

/**
 * 请求者权限判定（代码层强校验，不依赖 LLM）：
 *   kick/mute       → owner 或 admin 或 master
 *   set_admin       → 仅 master（无论在群里是什么角色）
 *   remove_admin    → 仅 master（无论在群里是什么角色）
 *   set_title       → 给自己：任何人；给他人：owner/admin/master
 *  requesterRole: 'owner'|'admin'|'member'|'unknown'，requesterIsMaster: bool
 */
function _requesterMay(actionType, requesterRole, requesterIsMaster) {
  const elevated = requesterRole === 'owner' || requesterRole === 'admin' || !!requesterIsMaster
  switch (actionType) {
    case 'mute':
    case 'kick':
      return elevated
    case 'set_admin':
    case 'remove_admin':
      return !!requesterIsMaster
    case 'set_title':
      return true  // 动作层会再区分"给自己 vs 给他人"
    default:
      return false
  }
}

/**
 * 从 AI 回复中解析操作指令并执行（代码层强校验，杜绝提示词注入越权）
 *
 * @param {string} replyText - AI 回复原文
 * @param {object} groupId   - 群号
 * @param {object} ctx       - 必须的请求上下文（架构级强制：不再只靠 prompt 让 AI 自觉）
 *   - requesterUid:  string | number      当前消息发送者 QQ（必填）
 *   - requesterInfo: object | null         当前发送者 getMemberInfo 结果（可选，未传会自动查）
 *   - requesterIsMaster: boolean           当前发送者是否是机器人主人（必填；来自 helper.isMaster）
 *   - e?: object                           原始事件对象（可选，用于再取 atTargets 兜底）
 *   - atTargets?: string[]                 当前消息中 @ 的目标 QQ 列表（不含机器人自身），可选
 *   - onlyAtBind?: boolean                 动作目标是否必须等于 @ 的目标（默认 true，防止注入任意 QQ）
 * @returns {Promise<{cleanText:string, results:Array<{type,ok,msg}>}>}
 */
export async function parseAndExecuteActions(replyText, groupId, ctx) {
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

  if (!groupId) {
    results.push({ type: '<action>', ok: false, msg: '非群聊环境，不执行群操作' })
    return { cleanText, results }
  }

  // ============== 架构层修复 1/8/11：强制读取请求者身份 + 字符串化 masters ==============
  if (!ctx || ctx.requesterUid == null) {
    results.push({ type: '<action>', ok: false, msg: '群操作缺少请求者身份（内部错误，拒绝执行）' })
    return { cleanText, results }
  }
  const requesterUid = safePathComponent(String(ctx.requesterUid))   // 归一化为安全字符串
  if (!requesterUid) {
    results.push({ type: '<action>', ok: false, msg: '请求者QQ非法，拒绝执行' })
    return { cleanText, results }
  }
  const requesterIsMaster = !!ctx.requesterIsMaster
  const mastersAll = helper.listMasters().map(x => String(x))   // 统一字符串化（修复 11）
  const mastersSet = new Set(mastersAll)                       // 统一用 Set 检查

  // 取群信息（含 ownerUin）+ 机器人角色
  const [botRoleRaw, groupInfoForAction, requesterInfoRaw] = await Promise.all([
    getBotRole(groupId),
    getGroupInfo(groupId).catch(() => null),
    (ctx.requesterInfo != null) ? Promise.resolve(ctx.requesterInfo) : getMemberInfo(groupId, requesterUid)
  ])
  const ownerUinForAction = groupInfoForAction?.ownerUin != null ? String(groupInfoForAction.ownerUin) : null
  const botRole = botRoleRaw || 'unknown'

  // 机器人自身角色校验：机器人身份未知 → 一律 fail-closed（拒绝所有群操作）
  if (!['owner', 'admin', 'member'].includes(botRole)) {
    for (const ma of matches) {
      results.push({ type: ma.type, ok: false, msg: '机器人群内身份未知（接口未返回），为安全起见拒绝执行所有管理操作' })
    }
    return { cleanText, results }
  }

  // 机器人 UIN（用于"不能对机器人自己动手"判定）
  const botSelf = getBotSelf()
  const botUin = botSelf?.uin ? String(botSelf.uin) : null

  // 消息中真实 @ 的目标（排除机器人自身）
  let atTargets = Array.isArray(ctx?.atTargets) ? ctx.atTargets.map(x => safePathComponent(String(x))).filter(Boolean) : null
  if (!atTargets && ctx?.e?.message) {
    atTargets = []
    for (const seg of ctx.e.message) {
      if (seg?.type === 'at' && seg.qq) {
        const uid = safePathComponent(String(seg.qq))
        if (uid && uid !== botUin) atTargets.push(uid)
      }
    }
  }
  const onlyAtBind = ctx?.onlyAtBind !== false

  // 对每个 action 做代码层校验（修复 1/2/3/4/9/10）
  for (const match of matches) {
    const { type, args } = match
    try {
      const targetUidRaw = args[0]
      if (!targetUidRaw) {
        results.push({ type, ok: false, msg: '未指定目标QQ' })
        continue
      }
      const targetUid = safePathComponent(String(targetUidRaw))
      if (!targetUid) {
        results.push({ type, ok: false, msg: '目标QQ格式非法' })
        continue
      }
      // 基本格式校验：QQ 号通常为纯数字，长度在 5-20 位（进一步防止任意字符串被传给底层群 API）
      if (!/^\d{5,20}$/.test(targetUid)) {
        results.push({ type, ok: false, msg: '目标QQ格式非法或未指定' })
        continue
      }

      // ========== 修复 8：动作目标必须等于消息里 @ 的人（onlyAtBind=true 时） ==========
      if (onlyAtBind && atTargets && atTargets.length > 0 && !atTargets.includes(targetUid)) {
        results.push({ type, ok: false, msg: `拒绝执行：动作目标(${targetUid})与本消息实际@对象(${atTargets.join(',') || '无'})不一致（防注入）` })
        continue
      }

      // ========== 修复 9：目标角色判定 fail-closed（未知一律按"受保护"处理，防止误踢管理员） ==========
      const targetInfo = await getMemberInfo(groupId, targetUid)
      const targetRole = _roleOf(targetInfo) || 'unknown'
      const targetIsOwnerByUin = ownerUinForAction && targetUid === ownerUinForAction
      const targetIsSelf = botUin && targetUid === botUin
      const targetIsMaster = mastersSet.has(targetUid)
      // fail-closed：角色 unknown（接口没返回）时 仍归入保护集，宁可漏执行也绝不能误踢/误禁言
      const protectedReasons = []
      if (targetIsOwnerByUin) protectedReasons.push('群主')
      if (targetRole === 'owner') protectedReasons.push('群主')
      if (targetRole === 'admin') protectedReasons.push('管理员')
      if (targetIsMaster) protectedReasons.push('机器人主人')
      if (targetIsSelf) protectedReasons.push('机器人自身')
      if (targetRole === 'unknown' && !targetIsMaster && !targetIsOwnerByUin && !targetIsSelf) {
        // 非主人/非群主，但身份未知 → 仍视为受保护（fail-closed），除非动作是给自己设头衔这种安全操作
        protectedReasons.push('身份未知(接口未返回)')
      }
      const isProtected = protectedReasons.length > 0
      // 对"给自己操作"的判定（用户可以给自己设头衔）
      const isSelfTarget = targetUid === requesterUid

      // ========== 修复 1/4：请求者权限代码层强校验 ==========
      const requesterRoleRaw =
        (ctx?.e?.sender ? _roleOf(ctx.e.sender) : null) ||
        _roleOf(requesterInfoRaw) ||
        (ownerUinForAction && requesterUid === ownerUinForAction ? 'owner' : 'unknown')
      // 如果 requesterIsMaster=true，但角色未知，仍允许其执行主人专属的 set_admin/remove_admin
      const requesterRole = requesterRoleRaw || 'unknown'
      if (!_requesterMay(type, requesterRole, requesterIsMaster)) {
        const reason =
          (type === 'set_admin' || type === 'remove_admin')
            ? '仅机器人主人可发起（代码层强校验，非提示词规则）'
            : '仅群主/管理员/机器人主人可发起（代码层强校验，非提示词规则）'
        results.push({ type, ok: false, msg: `❌ 请求者无权限：${reason}` })
        continue
      }

      // ========== 动作分支（全部做代码层权限） ==========
      if (type === 'mute') {
        if (cfg.get('groupOps.allowMute', true) === false) {
          results.push({ type, ok: false, msg: '禁言功能配置已关闭（groupOps.allowMute=false）' })
          continue
        }
        if (botRole !== 'owner' && botRole !== 'admin') {
          results.push({ type, ok: false, msg: '机器人不是管理员/群主，无法执行禁言' })
          continue
        }
        if (isProtected && !(isSelfTarget && protectedReasons.length === 1 && protectedReasons[0] === '身份未知(接口未返回)')) {
          results.push({ type, ok: false, msg: `目标 ${targetUid} 受保护：${protectedReasons.join('、')}（防误禁言）` })
          continue
        }
        // ========== 修复 10：禁言时长上限 ==========
        // QQ 禁言最大约 30 天（2592000s）。此处设上限 30 天；0 = 解禁特殊处理不受上限约束。
        const MAX_MUTE_SEC = 30 * 86400
        const DEFAULT_MUTE_SEC = Math.min(Number(cfg.get('groupOps.defaultMuteDuration', 600)) || 600, MAX_MUTE_SEC)
        const rawDur = parseInt(args[1], 10)
        let seconds = Number.isFinite(rawDur) ? Math.max(0, rawDur) : DEFAULT_MUTE_SEC
        if (seconds > MAX_MUTE_SEC) seconds = MAX_MUTE_SEC
        await executeMute(groupId, targetUid, seconds)
        const display = seconds === 0 ? '解除禁言' : formatDuration(seconds)
        results.push({ type, ok: true, msg: `已${display} ${targetUid}${rawDur !== seconds && seconds === MAX_MUTE_SEC ? `（时长已被上限限制到${formatDuration(MAX_MUTE_SEC)}，防滥用）` : ''}` })

      } else if (type === 'kick') {
        if (cfg.get('groupOps.allowKick', true) === false) {
          results.push({ type, ok: false, msg: '踢出功能配置已关闭（groupOps.allowKick=false）' })
          continue
        }
        if (botRole !== 'owner' && botRole !== 'admin') {
          results.push({ type, ok: false, msg: '机器人不是管理员/群主，无法执行踢出' })
          continue
        }
        if (isProtected) {
          results.push({ type, ok: false, msg: `目标 ${targetUid} 受保护：${protectedReasons.join('、')}（防误踢）` })
          continue
        }
        await executeKick(groupId, targetUid)
        results.push({ type, ok: true, msg: `已踢出 ${targetUid}` })

      } else if (type === 'set_admin') {
        // ========== 修复 3：allowAdmin 开关检查 ==========
        if (cfg.get('groupOps.allowAdmin', true) === false) {
          results.push({ type, ok: false, msg: '管理员功能配置已关闭（groupOps.allowAdmin=false）' })
          continue
        }
        // ========== 修复 4：仅机器人主人可发起 ==========
        if (!requesterIsMaster) {
          results.push({ type, ok: false, msg: '❌ 设置管理员仅机器人主人可发起（代码层强校验）' })
          continue
        }
        if (botRole !== 'owner') {
          results.push({ type, ok: false, msg: '机器人不是群主，无法设置管理员' })
          continue
        }
        // 不能对受保护对象之外的人也不能对主人/群主之外乱设，这里只简单不允许对群主再设管理员
        if (targetIsOwnerByUin || targetRole === 'owner') {
          results.push({ type, ok: false, msg: `目标 ${targetUid} 已经是群主，不能重复设管理员` })
          continue
        }
        await executeSetAdmin(groupId, targetUid, true)
        results.push({ type, ok: true, msg: `已将 ${targetUid} 设为管理员` })

      } else if (type === 'remove_admin') {
        // ========== 修复 3：同样检查 allowAdmin 开关（之前缺失） ==========
        if (cfg.get('groupOps.allowAdmin', true) === false) {
          results.push({ type, ok: false, msg: '管理员功能配置已关闭（groupOps.allowAdmin=false）' })
          continue
        }
        // ========== 修复 4：仅机器人主人可发起 ==========
        if (!requesterIsMaster) {
          results.push({ type, ok: false, msg: '❌ 取消管理员仅机器人主人可发起（代码层强校验）' })
          continue
        }
        if (botRole !== 'owner') {
          results.push({ type, ok: false, msg: '机器人不是群主，无法取消管理员' })
          continue
        }
        // 11 号问题：masters 检查用 Set<strings>
        if (mastersSet.has(targetUid)) {
          results.push({ type, ok: false, msg: '不可取消机器人主人的管理员身份' })
          continue
        }
        if (targetIsOwnerByUin || targetRole === 'owner') {
          results.push({ type, ok: false, msg: `目标 ${targetUid} 是群主，不能取消群主的管理员身份` })
          continue
        }
        await executeSetAdmin(groupId, targetUid, false)
        results.push({ type, ok: true, msg: `已取消 ${targetUid} 的管理员身份` })

      } else if (type === 'set_title') {
        // ========== 修复 2：代码层权限 + 目标保护 ==========
        if (cfg.get('groupOps.allowTitle', true) === false) {
          results.push({ type, ok: false, msg: '头衔功能配置已关闭（groupOps.allowTitle=false）' })
          continue
        }
        // set_title 分两种：
        //   a) 目标=自己 → 任何人都能设置（自助申请头衔）
        //   b) 目标=他人 → 只有 owner/admin/master 可设置
        if (!isSelfTarget) {
          const elevated = requesterRole === 'owner' || requesterRole === 'admin' || requesterIsMaster
          if (!elevated) {
            results.push({ type, ok: false, msg: '给他人设置头衔需群主/管理员/机器人主人（代码层强校验）' })
            continue
          }
          // 另外不能给群主/管理员/机器人主人设置"奇怪头衔"（毕竟这是一个可见标识）
          if (targetIsMaster || targetIsOwnerByUin || targetRole === 'owner' || targetRole === 'admin' || targetIsSelf) {
            const reasons = [
              targetIsMaster ? '机器人主人' : null,
              targetIsOwnerByUin || targetRole === 'owner' ? '群主' : null,
              targetRole === 'admin' ? '群管理员' : null,
              targetIsSelf ? '机器人自身' : null,
            ].filter(Boolean)
            results.push({ type, ok: false, msg: `不能为受保护对象（${reasons.join('/')}）设置头衔（代码层强校验）` })
            continue
          }
        }
        const titleText = args.slice(1).join(':').trim()
        if (!titleText) {
          results.push({ type, ok: false, msg: '未指定头衔内容' })
          continue
        }
        // 头衔长度+字符白名单：只允许常见中文/英文/数字/emoji 基本集，避免注入文本型脏数据（例如换行/XML/控制字符）
        const MAX_TITLE_LEN = 18
        const safeTitle = titleText.replace(/[\u0000-\u001F\u007F\r\n<>[\]]/g, '').slice(0, MAX_TITLE_LEN)
        if (!safeTitle) {
          results.push({ type, ok: false, msg: '头衔内容为空或包含非法控制字符' })
          continue
        }
        await executeSetTitle(groupId, targetUid, safeTitle)
        results.push({ type, ok: true, msg: `已为 ${targetUid} 设置头衔：${safeTitle}` })

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
