# ai0-plugin 证书钉扎异常修复文档

**日期**：2026-10-17

> 转存说明：本文档由本地诊断环境生成后转存入仓库；原稿末尾约 120 行（方案一收尾、
> 方案二及验证步骤）在转交时被截断，以下为收到的完整部分。代码侧已按"方案一"
> 落地诊断增强，并依据文中已确认事实（2.3 / 2.4 节）更新钉扎数据。

---

## 1. 现象

XRK-Yunzai 主进程和 QQ/OneBot 连接正常，群消息、撤回检测、防撤回回复均正常；但 AI 调用全部失败：

```text
[ai0-plugin] LLM 调用异常(post https://43.198.204.139/v1/chat/completions):
code=AI0_OFFICIAL_PIN_MISMATCH
官方域名证书钉扎校验失败，已中止连接（可能的中间人攻击）
```

因此当前不是 Yunzai 主程序死亡，而是 `ai0-plugin` 的 LLM HTTPS 请求被证书钉扎逻辑拒绝。

---

## 2. 已确认事实

### 2.1 插件更新与故障起点高度重合

- 插件版本：`1.2.0`
- `ai0-plugin/.git` 在 2026-10-16 14:19 左右发生修改
- 日志中首次出现 `AI0_OFFICIAL_PIN_MISMATCH`：

```text
2026-10-16T14:17:42.238Z
```

- systemd 的 `xrk-yunzai.service` 随后在 14:17:46 重启

源码注释显示该版本刚加入"2026-10 安全审计 P1"的证书钉扎逻辑。

### 2.2 DNS 按线路返回不同 CDN 节点

旧机上测试：

```text
系统默认解析：api.djyun.click -> 43.198.204.139
阿里 DNS 解析：api.djyun.click -> 18.166.213.94
沙盒侧曾解析到：172.237.27.84
```

这是 CDN 按 DNS 线路返回不同边缘节点，不足以单独证明 DNS 污染。

### 2.3 43.198.204.139 当前证书合法

使用 SNI=`api.djyun.click` 连接 43.198.204.139，得到：

- Subject：`CN=api.djyun.click`
- Issuer：Let's Encrypt `YR1`
- SAN 精确包含 `api.djyun.click`
- 有效期：2026-10-11 至 2027-01-09

### 2.4 当前边缘证书 SPKI 已在钉扎列表

从 43.198.204.139 当前证书计算出的 SPKI SHA-256：

```text
rK/jlci9a5PbYu1mBdnIImXuG6illDiL9MbpIW4rNXg=
```

源码中的钉扎列表包含同一指纹：

```js
'rK/jlci9a5PbYu1mBdnIImXuG6illDiL9MbpIW4rNXg=' // 2026-10-11 轮换后的当前 CDN 叶子
```

### 2.5 独立复现结果存在矛盾

在旧机上直接使用插件导出的 `isPinnedOfficialSocket()` 测试 43.198.204.139：

- 第一次测试返回 `false`
- 第二次逐步复刻测试中，直接调用同一个函数返回 `true`
- `cert.pubkey` 类型为 Buffer
- 按插件写法计算出的摘要命中钉扎列表
- SAN 检查通过
- 内嵌 YR1 中间证书 `checkIssued=true`、`verify=true`

这意味着目前不能武断地认定是某一行逻辑必然错误；需要进一步捕获实际连接时的证书、主机名、socket 状态和异常上下文。

---

## 3. 当前最可能的原因

按优先级排列：

### A. 不同 CDN 边缘返回不同证书或证书链

不同 DNS 线路会命中不同边缘。某些边缘可能：

- 仍使用旧证书
- 证书 SAN 不完整
- 返回不同的 YR1/YR2 链
- 叶子证书合法，但嵌入的中间证书验签不匹配

这能解释：同一个域名、不同时间出现 `95.40.125.89`、`43.198.204.139` 等不同目标 IP。

### B. 插件更新后的钉扎逻辑与 Node TLS 对象行为存在边界问题

源码使用：

```js
socket.getPeerCertificate(true)
socket.getPeerX509Certificate()
```

并混合使用 `cert.pubkey`、SPKI 摘要、`X509Certificate.checkIssued()`、`X509Certificate.verify()`。

需要在**真实请求的 secureConnect 回调中**记录：

- 目标 IP
- `servername`
- `cert.pubkey` 类型和长度
- SPKI 摘要
- SAN
- issuer / fingerprint256
- 每个验证分支的结果
- 被 catch 掉的具体异常

当前函数外层 `catch (_) { return false }` 会吞掉关键原因，不利于定位。

### C. 插件运行时加载的代码与手工测试代码不完全一致

需要确认：

- systemd 实际启动的 Node 路径
- 插件实际加载的文件路径
- 是否存在构建产物、缓存或重复插件副本
- systemd 启动前后 DNS/网络环境是否不同
- 是否有 HTTP 代理、DNS 代理或自定义 Agent

---

## 4. 不应直接采取的修复

在原因未确认前，不要：

1. 关闭证书钉扎
2. 设置 `rejectUnauthorized: false` 后直接发送请求
3. 删除 `AI0_OFFICIAL_PIN_MISMATCH` 判断
4. 把任意 CDN 节点 IP 永久写入 `/etc/hosts`
5. 盲目增加更多 SPKI 指纹
6. 仅为了恢复功能而接受"任意 SAN/任意 CA"证书

这些做法会使插件失去它刚加入的中间人防护。

---

## 5. 推荐修复方案

### 方案一：先增强诊断，再决定是否修逻辑（推荐）

在 `PinnedOfficialHttpsAgent.createConnection()` 的 `secureConnect` 回调中增加临时诊断日志，但不放宽验证：

```js
const cert = socket.getPeerCertificate(true)
const x509 = socket.getPeerX509Certificate?.()

logger.warn('[ai0-plugin pin-debug]', {
  address: socket.remoteAddress,
  port: socket.remotePort,
  servername: options.servername,
  pubkeyType: typeof cert?.pubkey,
  pubkeyBuffer: Buffer.isBuffer(cert?.pubkey),
  fingerprint256: cert?.fingerprint256,
  subject: cert?.subject,
  issuer: cert?.issuer,
  subjectaltname: cert?.subjectaltname,
  spkiSha256: x509
    ? crypto.createHash('sha256')
        .update(x509.publicKey.export({type: 'spki', format: 'der'}))
        .digest('base64')
    : null
})
```

然后把验证分支拆开记录：

```js
const spkiMatched = ...
const sanMatched = ...
const issuerMatched = ...
const signatureVerified = ...

if (spkiMatched || (sanMatched && issuerMatched && signatureVerified)) {
  return true
}

logger.error('[ai0-plugin pin-reject]', {
  spkiMatched,
  sanMatched,
  issuerMatched,
  signatureVerified
})
```

<!-- 原稿自此处起剩余约 120 行（方案一收尾、方案二、验证步骤）在转交时被截断 -->
