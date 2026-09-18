/**
 * 付费功能集成测试脚本
 * 测试易支付集成和付费用户管理功能
 */

import { YiPayment, PaymentConfig } from '../src/payment.js'
import { UserPremium } from '../src/userPremium.js'

// 测试配置
const TEST_CONFIG = {
  platformUrl: 'https://pay.example.com/api',
  merchantId: 'test_merchant',
  privateKey: 'test_private_key',
  callbackUrl: '/api/payment/callback',
  successUrl: '/payment/success',
  failUrl: '/payment/fail'
}

// 测试工具函数
function logTest(testName, passed, message = '') {
  const status = passed ? '✅ 通过' : '❌ 失败'
  console.log(`${status} - ${testName}${message ? ': ' + message : ''}`)
}

async function runTests() {
  console.log('🚀 开始测试付费功能集成...\n')

  let passedCount = 0
  let failedCount = 0

  // 1. 测试易支付类初始化
  console.log('1. 测试易支付类初始化')
  try {
    const payment = new YiPayment(TEST_CONFIG)
    logTest('易支付类初始化', true)
    passedCount++
  } catch (error) {
    logTest('易支付类初始化', false, error.message)
    failedCount++
  }

  // 2. 测试签名生成
  console.log('\n2. 测试签名生成')
  try {
    const payment = new YiPayment(TEST_CONFIG)
    const testParams = {
      merchantId: 'test',
      orderId: 'ORDER_123',
      amount: '10.00',
      timestamp: 1234567890
    }
    const signature = payment.generateSignature(testParams)
    logTest('签名生成', true, `签名: ${signature.substring(0, 10)}...`)
    passedCount++
  } catch (error) {
    logTest('签名生成', false, error.message)
    failedCount++
  }

  // 3. 测试用户付费状态管理
  console.log('\n3. 测试用户付费状态管理')
  try {
    const userPremium = new UserPremium()
    
    // 测试添加付费用户
    const testUserId = 'test_user_123'
    const expiryDate = new Date()
    expiryDate.setMonth(expiryDate.getMonth() + 1)
    
    userPremium.addPremiumUser(testUserId, {
      orderId: 'ORDER_TEST_001',
      amount: 19.9,
      expiryDate: expiryDate.toISOString(),
      paymentTime: new Date().toISOString(),
      timestamp: Date.now()
    })
    
    logTest('添加付费用户', true)
    passedCount++
    
    // 测试检查付费用户
    const isPremium = userPremium.isPremiumUser(testUserId)
    logTest('检查付费用户', isPremium, `用户 ${testUserId} 付费状态: ${isPremium}`)
    passedCount++
    
    // 测试功能权限
    const canUseFeature = userPremium.canUseFeature(testUserId, 'song_request')
    logTest('检查功能权限', canUseFeature, `点歌功能权限: ${canUseFeature}`)
    passedCount++
    
    // 测试移除付费用户
    userPremium.removePremiumUser(testUserId)
    const afterRemove = userPremium.isPremiumUser(testUserId)
    logTest('移除付费用户', !afterRemove, `移除后付费状态: ${!afterRemove}`)
    passedCount++
    
  } catch (error) {
    logTest('用户付费状态管理', false, error.message)
    failedCount += 4
  }

  // 4. 测试付费配置管理
  console.log('\n4. 测试付费配置管理')
  try {
    const paymentConfig = new PaymentConfig()
    
    // 测试获取支付配置
    const config = paymentConfig.getPaymentConfig()
    logTest('获取支付配置', true, `配置类型: ${typeof config}`)
    passedCount++
    
    // 测试价格配置
    const prices = paymentConfig.getPrices()
    logTest('获取价格配置', true, `价格配置: ${JSON.stringify(prices)}`)
    passedCount++
    
    // 测试功能配置
    const features = paymentConfig.getFeatures()
    logTest('获取功能配置', true, `功能数量: ${features.length}`)
    passedCount++
    
    // 测试付费开关
    const enabled = paymentConfig.isPaymentEnabled()
    logTest('检查付费开关', true, `付费功能状态: ${enabled}`)
    passedCount++
    
  } catch (error) {
    logTest('付费配置管理', false, error.message)
    failedCount += 4
  }

  // 5. 测试集成功能
  console.log('\n5. 测试集成功能')
  try {
    // 创建完整的测试场景
    const payment = new YiPayment(TEST_CONFIG)
    const userPremium = new UserPremium()
    
    // 模拟完整的支付流程
    const testUserId = 'integration_test_user'
    const expiryDate = new Date()
    expiryDate.setMonth(expiryDate.getMonth() + 1)
    
    // 添加付费用户
    userPremium.addPremiumUser(testUserId, {
      orderId: 'INTEGRATION_ORDER_001',
      amount: 199,
      expiryDate: expiryDate.toISOString(),
      paymentTime: new Date().toISOString(),
      timestamp: Date.now()
    })
    
    // 验证付费状态
    const isPremium = userPremium.isPremiumUser(testUserId)
    const canUseAllFeatures = [
      'high_quality_audio',
      'lyrics_display',
      'playlist_management',
      'premium_models',
      'song_request'
    ].every(feature => userPremium.canUseFeature(testUserId, feature))
    
    logTest('完整集成测试', isPremium && canUseAllFeatures, `付费用户状态: ${isPremium}, 所有功能权限: ${canUseAllFeatures}`)
    passedCount++
    
    // 测试订阅剩余天数
    const daysRemaining = userPremium.getSubscriptionDaysRemaining(testUserId)
    logTest('订阅剩余天数计算', daysRemaining > 0, `剩余天数: ${daysRemaining}`)
    passedCount++
    
    // 清理测试用户
    userPremium.removePremiumUser(testUserId)
    
  } catch (error) {
    logTest('集成功能', false, error.message)
    failedCount += 2
  }

  // 测试结果汇总
  console.log('\n' + '='.repeat(50))
  console.log('📊 测试结果汇总:')
  console.log(`✅ 通过: ${passedCount} 项`)
  console.log(`❌ 失败: ${failedCount} 项`)
  console.log(`📈 成功率: ${((passedCount / (passedCount + failedCount)) * 100).toFixed(1)}%`)
  console.log('='.repeat(50))

  return {
    total: passedCount + failedCount,
    passed: passedCount,
    failed: failedCount,
    successRate: ((passedCount / (passedCount + failedCount)) * 100).toFixed(1)
  }
}

// 运行测试
runTests().then(results => {
  console.log('\n🎉 测试完成!')
  
  if (results.failed === 0) {
    console.log('🎊 所有测试通过！付费功能集成正常。')
  } else {
    console.log(`⚠️  有 ${results.failed} 项测试失败，请检查相关功能。`)
  }
}).catch(error => {
  console.error('❌ 测试执行失败:', error)
})