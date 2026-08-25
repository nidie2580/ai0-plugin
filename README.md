# AI0-Plugin

> 适用于 **XRK-Yunzai** 的轻量 AI 聊天插件（附带 **网页管理后台**）  
> 基于 OpenAI 兼容协议，可接入任意大模型服务（支持 ChatGLM、DeepSeek、硅基流动、Kimi、通义千问 等）

---

## ✨ 功能特性

### 🗨️ 对话
- 群内 @机器人 / 私聊直接提问
- 自动上下文记忆，多轮对话
- 长回复自动合并转发，避免刷屏
- 自定义触发前缀（不用 @ 也能触发）

### 🔌 多模型接入
任何兼容 `/v1/chat/completions` 格式的服务均可接入：
官方 OpenAI、DeepSeek、硅基流动 SiliconFlow、零一万物 Kimi、
智谱 GLM、阿里通义、本地 Ollama / LM Studio 等。

### 🛡️ 权限控制
- 白名单 / 黑名单模式
- 独立主人权限（可执行管理命令、访问网页后台）

### 🌐 **网页管理后台** (v1.1.0 新增)
- 📝 可视化配置编辑（模型、对话、权限、网页后台）
- 💬 会话历史浏览 / 删除
- 🧪 模型连通性一键测试
- 🔐 两种登录方式，安全便捷

---

## 📦 安装

```bash
cd Yunzai/plugins
git clone https://github.com/nidie2580/ai0-plugin.git
cd ai0-plugin
npm install
```

重启 Yunzai 即可（插件会自动尝试启动网页后台）。

---

## 🌐 网页管理后台：两种登录方式

> 默认地址：<http://127.0.0.1:12580>  
> 默认只绑定 `127.0.0.1`，只有机器本身能访问；如需局域网访问，把 `config.yaml`
> 中 `web.host` 改为 `0.0.0.0` 并开放防火墙端口。

### 方式 A：主人命令一键直链（推荐）
以 **主人身份** 向机器人发送：
```
#ai网页管理
```
机器人会立刻回复一条 **10分钟有效、一次性** 的免登录链接，点击即可进入后台。

> 建议在 **私聊** 中使用；若在群里使用，请在点击后尽快撤回该消息。

### 方式 B：终端验证码（ID + Code 双输入）
有两种生成验证码的方式：
1. **独立启动**（不用先启动 Yunzai）：
   ```bash
   cd plugins/ai0-plugin
   npm run web
   ```
   启动后会直接在终端打印 32 位 ID + 16 位 Code 和访问地址。
2. **在 Yunzai 内**：主人向机器人发送 `#ai验证码`，
   验证码会同时出现在 Yunzai 运行终端和 QQ 回复消息里。

然后在登录页的「终端验证码」标签页填入生成的 **ID + Code** 即可。

### 其他网页管理命令
| 命令 | 说明 |
|------|------|
| `#ai网页管理` / `#aiweb` | 启动后台 + 生成一次性直链 |
| `#ai网页启动` | 只启动后台 |
| `#ai网页关闭` | 关闭后台 |
| `#ai验证码` | 生成终端验证码（ID + Code） |

---

## ⚙️ 配置

> **🔐 安全提示（务必阅读）**
> - 下方示例中的 `apiKey` 均为**占位符**，请勿直接使用。把真实密钥写进 `config.yaml` 后，
>   **不要**将包含密钥的 `config.yaml` 提交到公开仓库（`config.yaml` 默认已被 `.gitignore` 忽略）。
> - **推荐用环境变量代替**，密钥完全不落盘：
>   - `AI0_LLM_API_KEY`：默认模型的 API Key（必填项，推荐）
>   - `AI0_LLM_API_BASE`：默认模型的 API Base（可选，覆盖配置文件）
>   - `AI0_IMAGE_API_KEY`：图片生成的 API Key（可选）
>   - 例：`AI0_LLM_API_KEY=sk-xxxxx AI0_LLM_API_BASE=https://api.deepseek.com/v1 npm run web`
> - 设置了环境变量后，`config.yaml` 中的 `apiKey` 可留空或直接删除。

打开 `plugins/ai0-plugin/config/config.yaml`：

```yaml
# ========== 模型 ==========
model:
  default: openai-compatible
  openai-compatible:
    name: "AI0模型"
    apiBase: "https://api.openai.com/v1"   # 改这里
    apiKey: "YOUR_API_KEY_HERE"            # 改这里（或用环境变量 AI0_LLM_API_KEY）
    model: "gpt-3.5-turbo"                # 改这里
    temperature: 0.8
    maxTokens: 2000

# ========== 对话 ==========
chat:
  groupAtReply: true
  privateReply: true
  triggerPrefix: []      # 例：["#ai ", "小爱"]
  contextSize: 10        # 上下文轮数

# ========== 权限 ==========
permissions:
  masters: [123456789]   # 你的QQ号（主人），管理命令+网页后台都需要

# ========== 网页后台 ==========
web:
  autoStart: true        # Yunzai 启动时自动拉起
  port: 12580
  host: "127.0.0.1"      # 0.0.0.0 = 允许局域网访问

# ========== 系统提示词（支持动态变量） ==========
system:
  prompt: |
    你是一个友善的AI宝宝，QQ号是 <bot>。
    我的主人有：<master>；管理员有：<admin>。
    当前正与我说话的用户：<user>。
```

系统提示词中可使用以下动态变量，仅在**发送给模型前**被替换成真实值（Web 后台保存的是原始模板，编辑框里始终显示尖括号标记）：

| 变量 | 含义 |
|------|------|
| `<master>` | 主人 QQ 号列表，多个用顿号分隔 |
| `<user>` | 当前发送消息的用户 QQ |
| `<bot>` | 机器人自身的 QQ |
| `<admin>` | 管理员列表（框架 admin + 主人） |

### 🚀 常用兼容接入示例

| 服务商 | apiBase | 常见 model |
|--------|---------|------------|
| 官方 OpenAI | `https://api.openai.com/v1` | `gpt-3.5-turbo`, `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` 等 |
| 零一万物 (Kimi) | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 (GLM) | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 阿里 (通义) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` 等 |

---

## 🎮 命令一览

| 命令 | 说明 | 权限 |
|------|------|------|
| `#ai帮助` | 查看帮助菜单 | 全部 |
| `#ai新会话` | 重置上下文 | 全部 |
| `#ai模型` | 查看当前模型配置 | 全部 |
| `#ai设置模型 <模型名>` | 切换默认模型 ID | 主人 |
| `#ai设置apikey <key>` | 保存 API Key | 主人 |
| `#ai设置api <URL>` | 设置 API Base | 主人 |
| `#ai添加主人 <QQ>` | 新增主人 | 主人 |
| `#ai重载` | 重新加载配置 | 主人 |
| `#ai网页管理` / `#aiweb` | 启动并生成一次性免登录直链 | 主人 |
| `#ai网页启动` / `#ai网页关闭` | 启停网页后台 | 主人 |
| `#ai验证码` | 生成终端登录验证码（ID + Code） | 主人 |

---

## 📁 目录结构

```
ai0-plugin/
├── index.js                     # 插件入口 + 自动拉起网页后台
├── package.json
├── apps/
│   ├── chat.js                  # 消息监听
│   └── commands.js              # 全部 #ai 命令（含网页管理）
├── config/
│   ├── index.js                 # YAML 配置管理
│   ├── default_config.yaml
│   └── config.yaml              # 实际生效
├── src/
│   ├── auth.js                  # 验证码 / Magic link / Session
│   ├── webServer.js             # Express + 路由 API
│   ├── standalone-web.js        # npm run web 的独立入口
│   ├── chatService.js
│   ├── helper.js
│   └── llm.js                   # LLM 调用 + 会话持久化
├── web/
│   ├── login.html               # 登录页（验证码 / 直链说明）
│   ├── dashboard.html           # 管理后台首页
│   └── assets/                  # 样式与脚本
└── data/history/                # 用户会话 JSON
```

---

## 📄 开源协议

MIT License
