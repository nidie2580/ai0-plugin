/**
 * 群体广播功能模块
 * 实现主人向所有群聊发送消息和图片的功能
 */

import { getUserPremiumInstance } from './userPremium.js'
import { safeLogger } from './globals.js'

/**
 * 群体广播管理类
 */
export class GroupBroadcast {
  constructor(bot) {
    this.bot = bot
    this.premium = getUserPremiumInstance()
  }

  /**
   * 向所有群聊发送消息
   * @param {string} message - 要发送的消息
   * @param {string} [senderId] - 发送者ID（可选，用于权限验证）
   * @param {object} [options] - 发送选项
   * @param {boolean} [options.includeImages] - 是否包含图片
   * @param {string} [options.imagePath] - 图片路径（如果包含图片）
   * @param {boolean} [options.skipErrors] - 是否跳过错误
   * @returns {Promise<Array<object>>} 发送结果数组
   */
  async broadcastToAllGroups(message, senderId = null, options = {}) {
    const {
      includeImages = false,
      imagePath = null,
      skipErrors = true
    } = options

    // 获取所有群聊
    const groups = await this.getGroups()
    const results = []

    // 遍历所有群聊并发送消息
    for (const group of groups) {
      try {
        // 检查发送者权限（如果是主人发送）
        if (senderId) {
          const hasPermission = await this.checkBroadcastPermission(senderId, group)
          if (!hasPermission) {
            results.push({
              groupId: group.group_id,
              groupName: group.group_name,
              success: false,
              error: '没有广播权限'
            })
            continue
          }
        }

        // 发送消息
        if (includeImages && imagePath) {
          await group.sendImage(imagePath, message)
        } else {
          await group.sendMessage(message)
        }

        results.push({
          groupId: group.group_id,
          groupName: group.group_name,
          success: true
        })
      } catch (err) {
        if (!skipErrors) {
          throw err
        }

        results.push({
          groupId: group.group_id,
          groupName: group.group_name,
          success: false,
          error: err.message
        })

        safeLogger.warn(`向群 ${group.group_name} 发送广播失败: ${err.message}`)
      }
    }

    return results
  }

  /**
   * 获取所有群聊
   * @returns {Promise<Array<object>>} 群聊列表
   */
  async getGroups() {
    try {
      return await this.bot.getGroups()
    } catch (err) {
      safeLogger.error('获取群聊列表失败:', err)
      return []
    }
  }

  /**
   * 检查用户是否有广播权限
   * @param {string} userId - 用户ID
   * @param {object} group - 群聊对象
   * @returns {Promise<boolean>}
   */
  async checkBroadcastPermission(userId, group) {
    // 检查是否为机器人主人
    const isMaster = await this.isBotMaster(userId)
    if (isMaster) {
      return true
    }

    // 检查是否为付费用户且有广播权限
    const canUseFeature = this.premium.canUseFeature(userId, 'group_broadcast')
    if (canUseFeature) {
      return true
    }

    // 检查是否为群主或管理员
    const isGroupOwner = await this.isGroupOwner(userId, group)
    const isGroupAdmin = await this.isGroupAdmin(userId, group)
    if (isGroupOwner || isGroupAdmin) {
      return true
    }

    return false
  }

  /**
   * 检查用户是否为机器人主人
   * @param {string} userId - 用户ID
   * @returns {Promise<boolean>}
   */
  async isBotMaster(userId) {
    try {
      const masters = await this.bot.getMasterList()
      return masters.includes(userId)
    } catch (err) {
      safeLogger.error('获取主人列表失败:', err)
      return false
    }
  }

  /**
   * 检查用户是否为群主
   * @param {string} userId - 用户ID
   * @param {object} group - 群聊对象
   * @returns {Promise<boolean>}
   */
  async isGroupOwner(userId, group) {
    try {
      const groupInfo = await this.bot.getGroupInfo(group.group_id)
      return groupInfo.group_owner === userId
    } catch (err) {
      safeLogger.error('获取群信息失败:', err)
      return false
    }
  }

  /**
   * 检查用户是否为群管理员
   * @param {string} userId - 用户ID
   * @param {object} group - 群聊对象
   * @returns {Promise<boolean>}
   */
  async isGroupAdmin(userId, group) {
    try {
      const groupInfo = await this.bot.getGroupInfo(group.group_id)
      return groupInfo.admins.includes(userId)
    } catch (err) {
      safeLogger.error('获取群信息失败:', err)
      return false
    }
  }

  /**
   * 向指定群聊发送广播消息
   * @param {string} groupId - 群聊ID
   * @param {string} message - 消息内容
   * @param {string} [imagePath] - 图片路径（可选）
   * @returns {Promise<boolean>}
   */
  async sendToGroup(groupId, message, imagePath = null) {
    try {
      const group = await this.bot.getGroup(groupId)
      if (!group) {
        throw new Error('群聊不存在')
      }

      if (imagePath) {
        await group.sendImage(imagePath, message)
      } else {
        await group.sendMessage(message)
      }

      return true
    } catch (err) {
      throw err
    }
  }

  /**
   * 批量发送广播消息
   * @param {Array<string>} groupIds - 群聊ID数组
   * @param {string} message - 消息内容
   * @param {string} [imagePath] - 图片路径（可选）
   * @param {boolean} [skipErrors] - 是否跳过错误
   * @returns {Promise<Array<object>>} 发送结果
   */
  async batchSendToGroups(groupIds, message, imagePath = null, skipErrors = true) {
    const results = []

    for (const groupId of groupIds) {
      try {
        await this.sendToGroup(groupId, message, imagePath)
        results.push({
          groupId,
          success: true
        })
      } catch (err) {
        if (!skipErrors) {
          throw err
        }

        results.push({
          groupId,
          success: false,
          error: err.message
        })

        safeLogger.warn(`向群 ${groupId} 发送广播失败: ${err.message}`)
      }
    }

    return results
  }

  /**
   * 获取群聊统计信息
   * @returns {Promise<object>} 群聊统计信息
   */
  async getGroupStats() {
    const groups = await this.getGroups()
    return {
      totalGroups: groups.length,
      // 可以添加更多统计信息
    }
  }

  /**
   * 清理无效的群聊
   * @returns {Promise<Array<string>>} 清理的群聊ID列表
   */
  async cleanupInvalidGroups() {
    const groups = await this.getGroups()
    const validGroupIds = []

    for (const group of groups) {
      try {
        await this.bot.getGroupInfo(group.group_id)
        validGroupIds.push(group.group_id)
      } catch (err) {
        // 群聊无效，跳过
        safeLogger.warn(`群聊 ${group.group_id} 无效，跳过`)
      }
    }

    return validGroupIds
  }
}

// 导出单例实例
let groupBroadcastInstance = null

export function getGroupBroadcastInstance(bot) {
  if (!groupBroadcastInstance) {
    groupBroadcastInstance = new GroupBroadcast(bot)
  }
  return groupBroadcastInstance
}

// 导出常用功能
export async function broadcastToAllGroups(bot, message, senderId = null, options = {}) {
  const instance = getGroupBroadcastInstance(bot)
  return instance.broadcastToAllGroups(message, senderId, options)
}

export async function sendToGroup(bot, groupId, message, imagePath = null) {
  const instance = getGroupBroadcastInstance(bot)
  return instance.sendToGroup(groupId, message, imagePath)
}

/**
 * 处理主人私聊广播命令："广播 xxx"（可附带图片）。
 * 向机器人所在的所有群聊发送消息。未命中返回 false。
 * 由 chatService 在私聊主人消息上调用（点歌命令之后）。
 */
export async function handleBroadcastCommand(e, pureText, ctx = {}) {
  const text = String(pureText || '').trim()
  const m = /^(?:#|\/)?广播(?:\s+([\s\S]*))?$/.exec(text)
  if (!m) return false

  // 仅主人可用（私聊链路已保证非群聊，这里再硬校验一次身份）
  const userId = String(ctx?.userId || e?.user_id || e?.sender?.user_id || '')
  let isMaster = false
  try {
    const { listMasters } = await import('./helper.js')
    const masters = (listMasters?.() || []).map(String)
    isMaster = masters.includes(userId)
  } catch (_) {}
  if (!isMaster) {
    try { await e.reply('❌ 只有机器人主人才可以使用广播功能。') } catch (_) {}
    return true
  }

  const content = (m[1] || '').trim()
  // 提取消息中的图片段（quote/reply 里的图片也认）
  const rawSegs = Array.isArray(e.message) ? e.message : []
  const imageSegs = rawSegs.filter((s) => s && (s.type === 'image' || s.msg_type === 'image'))
  // 文字段：标准 OneBot segment 格式（data.text）
  const textSegs = content ? [{ type: 'text', data: { text: content } }] : []

  if (!content && !imageSegs.length) {
    try { await e.reply('📢 广播用法：发送「广播 消息内容」，可附带图片。') } catch (_) {}
    return true
  }

  // 收集所有可用的机器人实例（多账号/适配器差异下尽量找全）
  const bots = []
  const pushBot = (b) => { if (b && typeof b === 'object' && !bots.includes(b)) bots.push(b) }
  try {
    if (typeof Bot !== 'undefined' && Bot) {
      pushBot(Bot)
      // 多账号：Bot 可能是数组（Bot[0..n]），或 Bot.adapter 内包含多个实例
      if (Array.isArray(Bot)) { for (const x of Bot) pushBot(x) }
      if (Array.isArray(Bot?.adapters)) { for (const x of Bot.adapters) pushBot(x) }
    }
  } catch (_) {}
  try { pushBot(globalThis?.Bot) } catch (_) {}
  try { pushBot(globalThis?.bot) } catch (_) {}
  try { pushBot(e?.bot) } catch (_) {}
  try { pushBot(e?.adapter) } catch (_) {}
  // icqq / NapCat 底层 client（getGroupList 常在这里）
  for (const b of [...bots]) {
    try { pushBot(b?.client) } catch (_) {}
    try { pushBot(b?.internal) } catch (_) {}
    try { pushBot(b?.icqq) } catch (_) {}
    try { pushBot(b?.napcat) } catch (_) {}
  }

  // 从所有实例聚合群号（Bot.gl 是 Map<群号, 群信息>，兼容普通对象与数组）
  const groupIds = new Set()
  const addFromGl = (gl) => {
    try {
      if (gl instanceof Map) {
        for (const key of gl.keys()) groupIds.add(String(key))
      } else if (Array.isArray(gl)) {
        for (const g of gl) {
          const gid = g?.group_id ?? g?.groupId ?? g?.gc ?? g?.uin ?? g
          if (gid != null && gid !== '' && String(gid) !== '0') groupIds.add(String(gid))
        }
      } else if (gl && typeof gl === 'object') {
        for (const key of Object.keys(gl)) groupIds.add(String(key))
      }
    } catch (_) {}
  }
  for (const b of bots) {
    addFromGl(b?.gl)
    addFromGl(b?.Group)
    addFromGl(b?.groups)
    // icqq 风格：Bot 可能直接是数组实例
    if (Array.isArray(b)) addFromGl(b)
  }

  // 仍为空时，尝试异步刷新群列表（getGroupList 常见于 icqq/NapCat 后端）
  if (!groupIds.size) {
    for (const b of bots) {
      try {
        if (typeof b?.getGroupList === 'function') {
          const list = await b.getGroupList()
          if (list instanceof Map) {
            for (const key of list.keys()) groupIds.add(String(key))
          } else if (Array.isArray(list)) {
            for (const g of list) {
              const gid = g?.group_id ?? g?.groupId ?? g?.gc ?? g?.uin ?? g
              if (gid != null && String(gid) !== '0') groupIds.add(String(gid))
            }
          } else if (list && typeof list === 'object') {
            for (const key of Object.keys(list)) groupIds.add(String(key))
          }
        }
      } catch (_) {}
    }
  }

  if (!groupIds.size) {
    try {
      await e.reply(`没有找到机器人所在的群聊，无法广播。（机器人实例 ${bots.length} 个，请确认协议端已登录并同步群列表）`)
    } catch (_) {}
    return true
  }

  const segs = [...textSegs, ...imageSegs]
  let ok = 0
  let fail = 0
  for (const gid of groupIds) {
    let sent = false
    for (const b of bots) {
      try {
        const group = typeof b.pickGroup === 'function' ? b.pickGroup(gid)
          : typeof b.getGroup === 'function' ? b.getGroup(gid)
          : typeof b.Group?.pick === 'function' ? b.Group.pick(gid)
          : null
        if (group && typeof group.sendMsg === 'function') {
          await group.sendMsg(segs)
          sent = true
          break
        }
        if (typeof b.sendGroupMsg === 'function') {
          await b.sendGroupMsg(gid, segs)
          sent = true
          break
        }
      } catch (_) {}
    }
    if (sent) { ok++ } else { fail++ }
  }

  try {
    await e.reply(`📢 广播完成：共 ${groupIds.size} 个群，成功 ${ok}，失败 ${fail}。`)
  } catch (_) {}
  return true
}