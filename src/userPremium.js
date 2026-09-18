/**
 * 用户付费状态管理模块
 * 管理付费用户状态、权限控制和订阅管理
 */

import { getYiPaymentInstance } from './payment.js'

/**
 * 付费用户权限管理类
 */
export class UserPremium {
  constructor() {
    this.payment = getYiPaymentInstance()
    this.featurePermissions = new Map()
  }

  /**
   * 检查用户是否为付费用户
   * @param {string} userId - 用户ID
   * @returns {boolean}
   */
  isPremiumUser(userId) {
    return this.payment.isPremiumUser(userId)
  }

  /**
   * 检查用户是否可以使用特定功能
   * @param {string} userId - 用户ID
   * @param {string} feature - 功能名称
   * @returns {boolean}
   */
  canUseFeature(userId, feature) {
    // 首先检查是否为付费用户
    if (!this.isPremiumUser(userId)) {
      return false
    }

    // 检查功能权限配置
    const config = this.getFeatureConfig(feature)
    if (!config?.enabled) {
      return false
    }

    // 如果功能需要特定权限，检查用户是否拥有
    if (config.requiredPermissions) {
      return this.hasPermissions(userId, config.requiredPermissions)
    }

    return true
  }

  /**
   * 检查用户是否拥有特定权限
   * @param {string} userId - 用户ID
   * @param {Array<string>} permissions - 所需权限
   * @returns {boolean}
   */
  hasPermissions(userId, permissions) {
    // 这里可以扩展权限检查逻辑
    // 例如：检查用户等级、订阅类型等
    return permissions.every(permission => this.checkPermission(userId, permission))
  }

  /**
   * 检查用户是否拥有特定权限
   * @param {string} userId - 用户ID
   * @param {string} permission - 权限名称
   * @returns {boolean}
   */
  checkPermission(userId, permission) {
    // 基础权限检查
    switch (permission) {
      case 'high_quality_audio':
        return this.isPremiumUser(userId)
      case 'lyrics_display':
        return this.isPremiumUser(userId)
      case 'playlist_management':
        return this.isPremiumUser(userId)
      case 'premium_models':
        return this.isPremiumUser(userId)
      case 'song_request':
        return this.isPremiumUser(userId)
      default:
        return false
    }
  }

  /**
   * 获取功能配置
   * @param {string} feature - 功能名称
   * @returns {object|null}
   */
  getFeatureConfig(feature) {
    const config = this.payment.getPaymentConfig()
    const features = config.features || []
    return features.find(f => f.name === feature) || null
  }

  /**
   * 获取用户订阅信息
   * @param {string} userId - 用户ID
   * @returns {object|null}
   */
  getUserSubscription(userId) {
    return this.payment.getUserSubscription(userId)
  }

  /**
   * 获取用户订阅剩余天数
   * @param {string} userId - 用户ID
   * @returns {number} 剩余天数（如果未订阅返回-1）
   */
  getSubscriptionDaysRemaining(userId) {
    const subscription = this.getUserSubscription(userId)
    if (!subscription) return -1

    const expiryDate = new Date(subscription.expiryDate)
    const now = new Date()
    const diffTime = expiryDate - now
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

    return diffDays > 0 ? diffDays : 0
  }

  /**
   * 获取所有付费用户
   * @returns {Map<string, object>}
   */
  getAllPremiumUsers() {
    return this.payment.getAllPremiumUsers()
  }

  /**
   * 获取付费用户数量
   * @returns {number}
   */
  getPremiumUserCount() {
    return this.payment.getAllPremiumUsers().size
  }

  /**
   * 获取付费用户列表
   * @returns {Array<object>}
   */
  getPremiumUserList() {
    const users = []
    for (const [userId, subscription] of this.payment.getAllPremiumUsers()) {
      users.push({
        userId,
        ...subscription,
        daysRemaining: this.getSubscriptionDaysRemaining(userId)
      })
    }
    return users
  }

  /**
   * 手动添加付费用户（用于测试或管理）
   * @param {string} userId - 用户ID
   * @param {object} subscription - 订阅信息
   */
  addPremiumUser(userId, subscription) {
    this.payment.premiumUsers.set(userId, subscription)
    this.payment.savePremiumUsers()
  }

  /**
   * 手动移除付费用户
   * @param {string} userId - 用户ID
   */
  removePremiumUser(userId) {
    this.payment.removePremiumUser(userId)
  }

  /**
   * 检查功能是否需要付费
   * @param {string} feature - 功能名称
   * @returns {boolean}
   */
  isFeaturePaid(feature) {
    const config = this.getFeatureConfig(feature)
    return config?.enabled || false
  }

  /**
   * 获取功能价格
   * @param {string} feature - 功能名称
   * @returns {number|null}
   */
  getFeaturePrice(feature) {
    const config = this.getFeatureConfig(feature)
    if (!config?.enabled) return null

    const prices = this.payment.getPrices()
    return prices.monthly || prices.yearly || null
  }

  /**
   * 获取所有可用功能
   * @returns {Array<object>}
   */
  getAllFeatures() {
    const config = this.payment.getPaymentConfig()
    return config.features || []
  }

  /**
   * 检查是否启用付费功能
   * @returns {boolean}
   */
  isPaymentEnabled() {
    return this.payment.isPaymentEnabled()
  }

  /**
   * 获取支付价格配置
   * @returns {object}
   */
  getPrices() {
    return this.payment.getPrices()
  }
}

// 导出单例实例
let userPremiumInstance = null

export function getUserPremiumInstance() {
  if (!userPremiumInstance) {
    userPremiumInstance = new UserPremium()
  }
  return userPremiumInstance
}

// 导出常用功能
export function isPremiumUser(userId) {
  const instance = getUserPremiumInstance()
  return instance.isPremiumUser(userId)
}

export function canUseFeature(userId, feature) {
  const instance = getUserPremiumInstance()
  return instance.canUseFeature(userId, feature)
}

export function getSubscriptionDaysRemaining(userId) {
  const instance = getUserPremiumInstance()
  return instance.getSubscriptionDaysRemaining(userId)
}