# AI0-Plugin

> 适用于 **XRK-Yunzai** 的轻量 AI 聊天插件  
> 基于 OpenAI 兼容协议，可接入任意大模型服务（支持 ChatGLM、DeepSeek、硅基流动、Kimi、通义千问 等）

---

## ✨ 功能特性

- 🗨️ **群聊 / 私聊对话**：群内艾特或私聊直接提问
- 💬 **上下文记忆**：自动保存会话历史，支持多轮对话
- 🔌 **OpenAI 兼容**：任何兼容 `/v1/chat/completions` 格式的模型均可接入
- 🎛️ **管理命令**：模型、API Key、主人权限一键设置
- 🔐 **权限控制**：白名单 / 黑名单模式，精细化控制使用人群
- 🗃️ **转发消息**：长回复自动使用合并转发，刷屏不担心

---

## 📦 安装

将本仓库克隆到 XRK-Yunzai 的 `plugins/` 目录下：

```bash
cd Yunzai/plugins
git clone <你的仓库地址> ai0-plugin
cd ai0-plugin
npm install
```

然后重启 Yunzai 即可。

---

## ⚙️ 配置

首次加载后，打开 `plugins/ai0-plugin/config/config.yaml`：

```yaml
model:
  default: openai-compatible
  openai-compatible:
    name: "AI0模型"
    apiBase: "https://api.openai.com/v1"   # 改成你的接口地址
    apiKey: "sk-xxxxxx"                    # 改成你的 API Key
    model: "gpt-3.5-turbo"                # 改成你使用的模型名
    temperature: 0.8
    maxTokens: 2000

chat:
  groupAtReply: true     # 群聊艾特回复
  privateReply: true     # 私聊回复
  triggerPrefix: []      # 可选：直接用前缀触发，如 ["#ai "]
  contextSize: 10        # 上下文轮数

permissions:
  masters: [123456789]   # 改为你的QQ号，才能使用管理命令
```

### 🚀 常用兼容接入示例

| 服务商 | apiBase | 常见 model |
|--------|---------|------------|
| 官方 OpenAI | `https://api.openai.com/v1` | `gpt-3.5-turbo`, `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 硅基流动 SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` 等 |
| 零一万物 (Kimi) | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 (GLM) | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 阿里 (通义) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |

---

## 🎮 使用方式

### 对话
- **群聊**：@机器人 直接提问（或配置触发前缀）
- **私聊**：直接发送消息即可

### 命令

| 命令 | 说明 | 权限 |
|------|------|------|
| `#ai帮助` | 查看帮助菜单 | 全部 |
| `#ai新会话` | 重置上下文，开启新对话 | 全部 |
| `#ai模型` | 查看当前模型配置 | 全部 |
| `#ai设置模型 <模型名>` | 切换模型 ID | 主人 |
| `#ai设置apikey <key>` | 设置 API Key | 主人 |
| `#ai设置api <URL>` | 设置 API Base | 主人 |
| `#ai添加主人 <QQ>` | 新增主人 | 主人 |
| `#ai重载` | 重新加载配置 | 主人 |

---

## 📁 目录结构

```
ai0-plugin/
├── index.js                # 插件入口
├── package.json            # 依赖声明
├── apps/
│   ├── chat.js             # 对话消息监听
│   └── commands.js         # 命令处理
├── config/
│   ├── index.js            # 配置管理
│   ├── default_config.yaml # 默认配置（模板）
│   └── config.yaml         # 用户配置（实际生效）
├── src/
│   ├── helper.js           # 工具函数
│   ├── llm.js              # LLM 调用 & 会话存储
│   └── chatService.js      # 对话逻辑
└── data/history/           # 各用户会话历史
```

---

## 📄 开源协议

MIT License
