import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PLUGIN_ROOT = path.join(__dirname, '..')
const CONFIG_DIR = path.join(PLUGIN_ROOT, 'config')
const DATA_DIR = path.join(PLUGIN_ROOT, 'data')
const DEFAULT_CONFIG = path.join(CONFIG_DIR, 'default_config.yaml')
const USER_CONFIG = path.join(CONFIG_DIR, 'config.yaml')

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const defaultConfigContent = `# AI0-Plugin 配置文件

# 模型配置
model:
  # 默认使用的模型
  default: openai-compatible

  # OpenAI 兼容格式（支持任意兼容此格式的服务）
  openai-compatible:
    name: "AI0模型"
    apiBase: "https://api.openai.com/v1"
    apiKey: "sk-your-api-key-here"
    model: "gpt-3.5-turbo"
    temperature: 0.8
    maxTokens: 2000
    timeout: 60000

# 对话设置
chat:
  # 是否开启群聊艾特回复
  groupAtReply: true
  # 是否开启私聊回复
  privateReply: true
  # 触发前缀（不需要艾特直接触发），留空则只有艾特/私聊触发
  triggerPrefix: []
  # 上下文消息数量（不含当前轮）
  contextSize: 10
  # 单用户最大同时对话数（旧的会被清理）
  maxSessionsPerUser: 3
  # 对话过期时间（毫秒），-1 为永不过期
  sessionTimeout: 1800000

  # --- 上下文增强（默认全部开启，可单独关闭） ---
  # 是否注入"引用消息"（QQ回复/引用按钮选中的那条消息）作为上下文
  includeQuote: true
  # 是否解析"合并转发聊天记录"并把其中每条对话平铺进上下文
  includeForward: true
  # 是否在每条上下文消息前面加上【发送者】标签（便于AI区分谁发的；AI自己之前发的消息会额外带"（AI）"后缀标识）
  includeSenderTag: true
  # true=引用消息以独立的 system 提示块注入（推荐，更不容易被模型当成新一轮提问）
  # false=引用消息按角色注入成普通 user/assistant 对话
  quoteAsSystem: true

  # --- 全局AI模式 ---
  # 开启后，在下方 globalAIGroups 列表中的群，不需要@机器人也会回复所有消息
  # 关闭时，群聊中仅回复@机器人的消息（即 groupAtReply 逻辑）
  globalAI: false
  # 启用全局AI的群号列表（仅在这些群中，globalAI=true 时生效）
  globalAIGroups: []
  # 全局AI模式下忽略的消息前缀（以这些开头的消息不触发AI回复，比如命令）
  globalAIIgnorePrefix: ['#', '/', '！']

# 群操作设置（踢出/禁言/设置管理员/授头衔）
groupOps:
  # 总开关
  enabled: true
  # 允许踢出群员（仅群主/管理员/机器人主人可发起；不可对群主/管理员/机器人主人使用）
  allowKick: true
  # 允许禁言群员（同上权限限制）
  allowMute: true
  # 允许设置/取消管理员（仅机器人主人可发起；机器人必须是群主）
  allowAdmin: true
  # 允许授予群成员头衔（群内所有人都能自助申请）
  allowTitle: true
  # 默认禁言时长（秒），不指定时使用
  defaultMuteDuration: 600

# 系统提示词
system:
  prompt: |
    你是一个友善、乐于助人的AI助手，正在通过QQ机器人与用户交流。
    请用简洁、自然的中文回答用户的问题。
    - 如果涉及违规/违法/敏感内容，请直接拒绝回答。
    - 保持礼貌，适度使用颜文字和emoji。
    - 不要主动透露你是基于什么模型运行的。

# 白名单/黑名单
permissions:
  # true: 白名单模式（只有列表内可用），false: 黑名单模式
  whitelistMode: false
  # 允许的用户QQ号（白名单模式生效）
  allowedUsers: []
  # 允许的群号（白名单模式生效）
  allowedGroups: []
  # 禁止的用户QQ号（黑名单模式生效）
  blockedUsers: []
  # 禁止的群号（黑名单模式生效）
  blockedGroups: []
  # 主人QQ（可以执行管理命令）
  masters: []

# 响应设置
response:
  # 是否使用转发消息（长文本时）
  useForwardMsg: true
  # 超过多少字使用转发（设大则禁用）
  forwardThreshold: 500
  # 是否在回复前发送「我正在思考中...」占位提示。默认关闭（只输出AI纯回复）
  showThinkingHint: false
  # 如果开启了 showThinkingHint，延迟多少毫秒后发送占位提示（避免回复很快时一闪而过）。0=立刻发
  thinkingDelay: 500
  # 是否在回复末尾追加模型名（如"\\n\\n—— AI0模型"）。默认关闭，只输出AI纯回复
  showModelTag: false

# 网页管理后台
web:
  # 插件加载时是否自动启动
  autoStart: true
  # 监听端口
  port: 12580
  # 绑定地址（建议加引号，避免部分 YAML 解析器把裸 0.0.0.0 当成数字 0）：
  #   "127.0.0.1"  仅本机访问（默认）
  #   "0.0.0.0"    允许局域网/公网访问（请同时放行 云服务器安全组 + 系统防火墙 TCP 端口）
  #   "::"         IPv6 all（同上）
  host: "127.0.0.1"
`

if (!fs.existsSync(DEFAULT_CONFIG)) {
  fs.writeFileSync(DEFAULT_CONFIG, defaultConfigContent, 'utf-8')
}
// config.yaml 是用户本地配置：首次不存在才初始化一份默认值，后续绝不写入仓库，避免 git pull/强制覆盖 把用户配置洗掉
if (!fs.existsSync(USER_CONFIG)) {
  fs.writeFileSync(USER_CONFIG, defaultConfigContent, 'utf-8')
}

let cachedConfig = null
let lastMtime = 0

export function loadConfig() {
  try {
    const mtime = fs.statSync(USER_CONFIG).mtimeMs
    if (cachedConfig && mtime === lastMtime) {
      return cachedConfig
    }
    const userContent = fs.readFileSync(USER_CONFIG, 'utf-8')
    cachedConfig = YAML.parse(userContent) || {}
    lastMtime = mtime
    return cachedConfig
  } catch (err) {
    logger.error(`[ai0-plugin] 读取配置失败: ${err.message}`)
    return {}
  }
}

export function saveConfig(config) {
  try {
    const content = YAML.stringify(config)
    fs.writeFileSync(USER_CONFIG, content, 'utf-8')
    cachedConfig = config
    lastMtime = fs.statSync(USER_CONFIG).mtimeMs
    return true
  } catch (err) {
    logger.error(`[ai0-plugin] 保存配置失败: ${err.message}`)
    return false
  }
}

export function get(key, defaultValue) {
  const config = loadConfig()
  const keys = key.split('.')
  let curr = config
  for (const k of keys) {
    if (curr == null || typeof curr !== 'object') return defaultValue
    curr = curr[k]
  }
  return curr === undefined ? defaultValue : curr
}

/**
 * 统一解析 web.host / web.port：
 * - 某些 YAML 解析器会把裸写 host: 0.0.0.0 解析成数字 0；这里做归一化
 * - 也兼容字符串 "0"/"0.0.0.0"/"::"/"127.0.0.1" 等
 * 返回 { host, port } 都是"解析后真正会用于绑定的"值，便于 #ai网页启动/初始化/#ai诊断 三处一致。
 */
export function normalizeWebBind({ host, port } = {}) {
  let p = Number(port)
  if (!Number.isFinite(p) || p <= 0 || p >= 65536) p = 12580

  let h = host
  if (h == null) h = '127.0.0.1'
  // 数字 0 / 字符串 "0" 都视为 0.0.0.0（YAML 裸写 0.0.0.0 被当作数字 0 的经典坑）
  if (typeof h === 'number') {
    if (h === 0) h = '0.0.0.0'
    else h = String(h)
  }
  if (typeof h !== 'string') h = String(h)
  h = h.trim()
  if (h === '0') h = '0.0.0.0'
  if (h === '::1/128') h = '::1' // 常见脏值兼容
  if (!h) h = '127.0.0.1'

  return { host: h, port: p }
}

/** 从当前配置里取出 web 绑定（已经做归一化） */
export function getWebBindFromConfig() {
  const c = loadConfig()
  return normalizeWebBind({ host: c?.web?.host, port: c?.web?.port })
}
