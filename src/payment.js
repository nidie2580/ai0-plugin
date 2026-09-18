/**
 * 易支付API集成模块
 * 集成易支付平台，实现支付请求、回调处理和状态验证
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { safeAxiosRequest } from './helper.js'
import { loadConfig, saveConfig } from './config/index.js'

// 易支付API配置
const PAYMENT_CONFIG = {
  // 默认配置，可在config中覆盖
  platformUrl: 'https://pay.example.com/api',
  merchantId: '',
  privateKey: '',
  // 支付回调URL（需要根据实际部署配置）
  callbackUrl: '/api/payment/callback',
  // 支付成功跳转URL
  successUrl: '/payment/success',
  // 支付失败跳转URL
  failUrl: '/payment/fail'
}

// 付费用户数据存储
const PREMIUM_USERS_FILE = path.join(process.cwd(), 'data', 'premium_users.json')

/**
 * 易支付核心类
 */
export class YiPayment {
  constructor(config = {}) {
    this.config = { ...PAYMENT_CONFIG, ...config }
    this.premiumUsers = new Map()
    this.loadPremiumUsers()
  }

  /**
   * 加载付费用户数据
   */
  loadPremiumUsers() {
    try {
      if (fs.existsSync(PREMIUM_USERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(PREMIUM_USERS_FILE, 'utf-8'))
        this.premiumUsers = new Map(Object.entries(data))
      }
    } catch (err) {
      console.error('加载付费用户数据失败:', err)
    }
  }

  /**
   * 保存付费用户数据
   */
  savePremiumUsers() {
    try {
      const data = Object.fromEntries(this.premiumUsers)
      fs.writeFileSync(PREMIUM_USERS_FILE, JSON.stringify(data, null, 2))
    } catch (err) {
      console.error('保存付费用户数据失败:', err)
    }
  }

  /**
   * 创建支付订单
   * @param {string} userId - 用户ID
   * @param {number} amount - 支付金额（元）
   * @param {string} description - 支付描述
   * @param {string} [orderId] - 自定义订单ID（可选）
   * @returns {Promise<{orderId: string, paymentUrl: string}>}
   */
  async createOrder(userId, amount, description, orderId = null) {
    try {
      // 生成订单ID（如果未提供）
      const orderNumber = orderId || `ORDER_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
      
      // 准备支付请求参数
      const params = {
        merchantId: this.config.merchantId,
        orderId: orderNumber,
        amount: amount.toFixed(2),
        description,
        userId,
        callbackUrl: this.config.callbackUrl,
        successUrl: this.config.successUrl,
        failUrl: this.config.failUrl,
        timestamp: Date.now()
      }

      // 生成签名
      const signature = this.generateSignature(params)
      params.signature = signature

      // 发送支付请求
      const response = await safeAxiosRequest('post', `${this.config.platformUrl}/create_order`, params, {
        headers: {
          'Content-Type': 'application/json'
        }
      })

      if (response.status === 200 && response.data.success) {
        return {
          orderId: orderNumber,
          paymentUrl: response.data.paymentUrl
        }
      } else {
        throw new Error(response.data.message || '创建支付订单失败')
      }
    } catch (err) {
      throw new Error(`支付请求失败: ${err.message}`)
    }
  }

  /**
   * 生成支付签名
   * @param {object} params - 支付参数
   * @returns {string} 签名
   */
  generateSignature(params) {
    // 按照易支付API要求排序参数并生成签名
    const sortedParams = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&')
    
    const signature = crypto
      .createHmac('sha256', this.config.privateKey)
      .update(sortedParams)
      .digest('hex')
    
    return signature
  }

  /**
   * 处理支付回调
   * @param {object} callbackData - 回调数据
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async handleCallback(callbackData) {
    try {
      // 验证回调签名
      const isValid = this.verifyCallbackSignature(callbackData)
      if (!isValid) {
        throw new Error('回调签名验证失败')
      }

      // 验证支付状态
      if (callbackData.status !== 'SUCCESS') {
        throw new Error(`支付状态异常: ${callbackData.status}`)
      }

      // 处理支付成功
      await this.processPaymentSuccess(callbackData)

      return { success: true, message: '支付成功' }
    } catch (err) {
      console.error('处理支付回调失败:', err)
      return { success: false, message: err.message }
    }
  }

  /**
   * 验证回调签名
   * @param {object} callbackData - 回调数据
   * @returns {boolean} 签名是否有效
   */
  verifyCallbackSignature(callbackData) {
    const { signature, ...params } = callbackData
    const generatedSignature = this.generateSignature(params)
    return signature === generatedSignature
  }

  /**
   * 处理支付成功
   * @param {object} paymentData - 支付数据
   */
  async processPaymentSuccess(paymentData) {
    const { orderId, userId, amount, timestamp } = paymentData
    
    // 添加或更新付费用户
    const expiryDate = new Date()
    expiryDate.setMonth(expiryDate.getMonth() + 1) // 默认1个月订阅
    
    this.premiumUsers.set(userId, {
      orderId,
      amount: parseFloat(amount),
      expiryDate: expiryDate.toISOString(),
      paymentTime: new Date().toISOString(),
      timestamp
    })

    // 保存用户数据
    this.savePremiumUsers()

    // 记录支付日志
    this.logPayment(userId, orderId, amount)
  }

  /**
   * 记录支付日志
   * @param {string} userId - 用户ID
   * @param {string} orderId - 订单ID
   * @param {number} amount - 支付金额
   */
  logPayment(userId, orderId, amount) {
    const logEntry = {
      userId,
      orderId,
      amount,
      timestamp: new Date().toISOString(),
      type: 'payment_success'
    }

    // 这里可以添加日志存储逻辑
    console.log('支付成功:', logEntry)
  }

  /**
   * 验证支付状态
   * @param {string} orderId - 订单ID
   * @returns {Promise<{status: string, amount: number}>}
   */
  async verifyPayment(orderId) {
    try {
      const params = {
        merchantId: this.config.merchantId,
        orderId,
        timestamp: Date.now()
      }

      const signature = this.generateSignature(params)
      params.signature = signature

      const response = await safeAxiosRequest('post', `${this.config.platformUrl}/verify_payment`, params)

      if (response.status === 200 && response.data.success) {
        return {
          status: response.data.status,
          amount: parseFloat(response.data.amount)
        }
      } else {
        throw new Error(response.data.message || '验证支付状态失败')
      }
    } catch (err) {
      throw new Error(`验证支付失败: ${err.message}`)
    }
  }

  /**
   * 检查用户是否为付费用户
   * @param {string} userId - 用户ID
   * @returns {boolean}
   */
  isPremiumUser(userId) {
    const user = this.premiumUsers.get(userId)
    if (!user) return false

    // 检查订阅是否过期
    const expiryDate = new Date(user.expiryDate)
    if (expiryDate < new Date()) {
      this.premiumUsers.delete(userId)
      this.savePremiumUsers()
      return false
    }

    return true
  }

  /**
   * 获取用户订阅信息
   * @param {string} userId - 用户ID
   * @returns {object|null}
   */
  getUserSubscription(userId) {
    const user = this.premiumUsers.get(userId)
    if (!user) return null

    // 检查订阅是否过期
    const expiryDate = new Date(user.expiryDate)
    if (expiryDate < new Date()) {
      this.premiumUsers.delete(userId)
      this.savePremiumUsers()
      return null
    }

    return user
  }

  /**
   * 移除付费用户
   * @param {string} userId - 用户ID
   */
  removePremiumUser(userId) {
    this.premiumUsers.delete(userId)
    this.savePremiumUsers()
  }

  /**
   * 获取所有付费用户
   * @returns {Map<string, object>}
   */
  getAllPremiumUsers() {
    return new Map(this.premiumUsers)
  }
}

/**
 * 支付配置管理
 */
export class PaymentConfig {
  constructor() {
    this.config = loadConfig()
  }

  /**
   * 获取支付配置
   * @returns {object}
   */
  getPaymentConfig() {
    return this.config.payment || {}
  }

  /**
   * 更新支付配置
   * @param {object} newConfig - 新配置
   */
  updatePaymentConfig(newConfig) {
    this.config.payment = { ...this.config.payment, ...newConfig }
    saveConfig(this.config)
  }

  /**
   * 检查是否启用付费功能
   * @returns {boolean}
   */
  isPaymentEnabled() {
    return this.config.payment?.enabled || false
  }

  /**
   * 获取支付价格配置
   * @returns {object}
   */
  getPrices() {
    return this.config.payment?.prices || {}
  }

  /**
   * 获取功能权限配置
   * @returns {Array<object>}
   */
  getFeatures() {
    return this.config.payment?.features || []
  }
}

// 导出易支付实例（单例模式）
let yiPaymentInstance = null

export function getYiPaymentInstance() {
  if (!yiPaymentInstance) {
    const config = loadConfig().payment || {}
    yiPaymentInstance = new YiPayment(config)
  }
  return yiPaymentInstance
}

export { PaymentConfig }