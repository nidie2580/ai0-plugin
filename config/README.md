# AI0-Plugin 出站请求安全说明

## 图片下载（helper.js / imageGen.js）

- 下载图片 URL 前先做 SSRF 校验：拒绝私有 IP / 回环 / 链路本地 / 内网 DNS 解析结果。
- 关闭自动跟随重定向；遇到 3xx 时校验 Location 目标后最多跟随 1 跳，防止重定向绕过校验。
- 响应体流式读取，上限 20MB，防止恶意 URL 拖垮内存。

## LLM API 地址（config.yaml 的 apiBase）

- 管理员配置的 apiBase 不做 SSRF 拦截（用户可能部署本地 Ollama/vLLM），仅做 URL 可解析性检查。
