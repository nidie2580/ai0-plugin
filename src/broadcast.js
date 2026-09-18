/**
 * 群体广播功能模块
 * 实现主人向所有群聊发送消息和图片的功能
 */

import { getUserPremiumInstance } from './userPremium.js'
import { safeLogger } from './helper.js'

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