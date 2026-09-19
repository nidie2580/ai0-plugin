# 官方 API 充值（易支付）

插件功能（对话、点歌、模型切换、生图）不因付费状态被拦截。后台已无「付费配置」页。

易支付只用于给「多API平台」里的官方 API 条目充值。官方 API 与自定义平台可同时存在多条，用「使用此平台」切换。

## 官方 API

- 地址由服务端内置，网页后台与 `/api/config` 不返回 apiBase
- 配置字段：`model.<key>.kind: official`
- 添加入口：网页后台「多API平台」→「添加官方 API」
- 官方卡片只保留拉取模型列表与易支付充值
- 不添加则不会自动成为默认平台

## 易支付商户

在 `config/payment_config.yaml` 填写商户信息：

```yaml
payment:
  platformUrl: "https://pay.example.com/api"
  merchantId: "your_merchant_id"
  privateKey: "your_private_key"
```

## 接口

- `GET /api/official/meta` — 官方显示名与提示（不含地址）
- `POST /api/official/recharge` — 对官方条目创建易支付订单（需登录）
- `GET /api/official/recharges` — 最近充值记录
- `POST /api/payment/callback` — 易支付回调

充值流水落在 `data/official_recharge.json`。回调成功只记账，不锁定任何功能。
