# 付费功能集成文档

## 概述

AI0-Plugin 现已支持易支付平台集成和付费用户管理功能，实现完整的付费订阅系统。

## 功能特性

### 1. 易支付集成
- ✅ 支持易支付平台API集成
- ✅ 支付订单创建和管理
- ✅ 支付回调处理和验证
- ✅ 签名验证机制确保支付安全

### 2. 用户付费状态管理
- ✅ 付费用户识别和管理
- ✅ 订阅到期检查和提醒
- ✅ 功能权限控制系统
- ✅ 手动添加/删除付费用户

### 3. 群体广播功能
- ✅ 主人权限验证
- ✅ 向所有群聊发送消息
- ✅ 支持文字和图片发送
- ✅ 群聊统计和管理

### 4. 点歌功能付费限制
- ✅ 付费用户专属点歌功能
- ✅ 高音质音频支持
- ✅ 歌词显示权限
- ✅ 歌单管理权限

### 5. Web后台管理
- ✅ 付费配置管理界面
- ✅ 付费用户管理界面
- ✅ 群体广播功能界面
- ✅ API配置和测试

## 安装依赖

```bash
npm install canvas
```

## 配置说明

### 1. 基础配置

在 `config/payment_config.yaml` 中配置易支付平台信息：

```yaml
payment:
  enabled: false  # 是否启用付费功能
  platformUrl: "https://pay.example.com/api"  # 易支付平台地址
  merchantId: "your_merchant_id"              # 商户ID
  privateKey: "your_private_key"              # 商户私钥
```

### 2. 价格配置

```yaml
prices:
  monthly: 19.9   # 月度订阅价格（元）
  yearly: 199     # 年度订阅价格（元）
```

### 3. 功能权限配置

```yaml
features:
  - name: "high_quality_audio"
    enabled: true
    description: "享受无损音质音频播放"
  - name: "song_request"
    enabled: true
    description: "使用点歌功能"
  # ... 更多功能配置
```

## API接口

### 支付相关接口

#### 获取付费配置
```http
GET /api/payment/config
```

#### 更新付费配置
```http
POST /api/payment/config
```

#### 获取付费用户列表
```http
GET /api/payment/users
```

#### 手动添加付费用户
```http
POST /api/payment/users
```

#### 移除付费用户
```http
DELETE /api/payment/users/:userId
```

#### 创建支付订单
```http
POST /api/payment/create-order
```

#### 处理支付回调
```http
POST /api/payment/callback
```

### 群体广播接口

#### 发送群体广播
```http
POST /api/broadcast
```

请求体：
```json
{
  "message": "要发送的消息内容",
  "image": "图片路径（可选）",
  "senderId": "发送者ID（可选，用于权限验证）"
}
```

#### 获取群聊统计
```http
GET /api/broadcast/stats
```

## 使用示例

### 1. 检查用户付费状态

```javascript
import { getUserPremiumInstance } from './src/userPremium.js'

const premium = getUserPremiumInstance()

// 检查用户是否为付费用户
const isPremium = premium.isPremiumUser('user_id_123')

// 检查用户是否可以使用特定功能
const canUseFeature = premium.canUseFeature('user_id_123', 'song_request')

// 获取用户订阅信息
const subscription = premium.getUserSubscription('user_id_123')
```

### 2. 创建支付订单

```javascript
import { getYiPaymentInstance } from './src/payment.js'

const payment = getYiPaymentInstance()

// 创建支付订单
const order = await payment.createOrder(
  'user_id_123',
  19.9,
  '月度订阅'
)

console.log('支付链接:', order.paymentUrl)
console.log('订单ID:', order.orderId)
```

### 3. 群体广播

```javascript
import { getGroupBroadcastInstance } from './src/broadcast.js'

const bot = global.Bot || {}
const broadcast = getGroupBroadcastInstance(bot)

// 向所有群聊发送消息
const results = await broadcast.broadcastToAllGroups(
  '大家好，这是系统通知！',
  'master_user_id',
  { skipErrors: true }
)

console.log('发送结果:', results)
```

## 点歌功能集成

点歌功能现已支持付费限制：

```javascript
import { sendSongsResultRich } from './src/musicService.js'

// 自动检查付费权限
const result = await sendSongsResultRich(e, songs, {
  premiumText: '点歌功能需要付费订阅，请联系管理员开通。'
})

// 如果用户未付费，会返回：
// { ok: false, msg: 'premium_required', ... }
```

## 安全考虑

### 1. 配置安全
- ✅ 敏感信息（私钥）脱敏处理
- ✅ 环境变量支持
- ✅ 权限控制（仅主人可修改付费配置）

### 2. 支付安全
- ✅ 支付回调签名验证
- ✅ 防止重复支付
- ✅ 支付状态双重验证

### 3. 用户数据安全
- ✅ 付费记录加密存储
- ✅ 用户隐私保护
- ✅ 数据访问日志

## 测试

运行测试脚本：

```bash
node test/payment.test.js
```

测试包括：
- ✅ 易支付类初始化
- ✅ 签名生成和验证
- ✅ 用户付费状态管理
- ✅ 功能权限控制
- ✅ 群体广播功能
- ✅ 付费配置管理
- ✅ 完整集成测试

## Web后台访问

1. 启动Web后台：
```bash
npm run web
```

2. 访问地址：`http://localhost:12580`

3. 登录后进入「💰 付费配置」页面管理付费功能

4. 进入「📢 群体广播」页面管理广播功能

## 常见问题

### 1. 如何手动添加付费用户？

在Web后台的「付费配置」页面，点击「手动添加用户」按钮，输入用户ID和订阅信息即可。

### 2. 如何设置付费功能？

在Web后台的「付费配置」页面，填写易支付平台信息并保存配置。默认状态为关闭，需要手动启用。

### 3. 群体广播需要什么权限？

群体广播功能需要主人权限或付费用户的广播权限。只有主人可以主动发送广播，付费用户可以通过配置获得广播权限。

### 4. 付费用户的功能权限如何控制？

在付费配置页面，可以单独控制每个功能的启用状态，也可以为特定用户分配特定权限。

## 更新日志

### v1.2.0 - 2026-09-18
- ✅ 新增易支付平台集成
- ✅ 新增用户付费状态管理
- ✅ 新增群体广播功能
- ✅ 新增点歌功能付费限制
- ✅ 新增Web后台付费配置管理
- ✅ 新增完整的测试套件

## 技术支持

如有问题或建议，请通过以下方式联系：

- GitHub Issues: https://github.com/nidie2580/ai0-plugin/issues
- 项目文档: https://github.com/nidie2580/ai0-plugin

## 许可证

MIT License - 详见项目根目录 LICENSE 文件