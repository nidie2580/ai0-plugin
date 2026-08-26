import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { safeLogger } from '../src/globals.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PLUGIN_ROOT = path.join(__dirname, '..')
const CONFIG_DIR = path.join(PLUGIN_ROOT, 'config')
const DATA_DIR = path.join(PLUGIN_ROOT, 'data')
const DEFAULT_CONFIG = path.join(CONFIG_DIR, 'default_config.yaml')
const USER_CONFIG = path.join(CONFIG_DIR, 'config.yaml')

// 目录需要 execute 位（rwx------=0o700），否则属主自己也无法 chdir 进入目录。
// 文件 mode 用 0o600（rw-------）才正确。
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })

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

  # --- 仅艾特机器人默认回复 ---
  # 群聊里如果消息内容只有"@机器人"（去掉@后文本为空，或无文字仅带表情），就直接用下方默认回复，
  # 不调用大模型。这样能避免"@机器人 没说话"浪费 API 额度、也能让主人更快叫起对话。
  onlyAtDefaultReply:
    # 总开关（默认开启）
    enabled: true
    # 回复文案池（每次随机挑 1 条；颜文字/语气词都建议写上）
    texts:
      - "今天又有什么事呀～"
      - "咋啦？(๑•̀ㅂ•́)و✧"
      - "在呢在呢～说吧！"
      - "叫我干嘛？你说你说！"
      - "收到呼叫！我在！请吩咐～"
      - "哼哼～我听到了哦，想让我做什么？(๑˃̵ᴗ˂̵)"
    # 回复时附加发送的表情包/图片（可选；支持本地路径、http(s)URL）
    # 空数组=只发文字。配置示例：
    #   stickers:
    #     - "https://xxx.com/emoji.png"
    #     - "D:/pictures/表情包/maozi.jpg"
    stickers: []
    # 纯文字图 还是 文字+表情包 的发送方式：
    #   "together"  文字和图片合成一条消息发送（优先，最省消息条数）
    #   "separate"  先发文字再发表情包（失败率低一点）
    #   "random"    二者 50% 随机
    sendMode: "together"


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
  # —— AI 群操作开关（可独立禁用高危操作）——
  # 允许全体禁言（mute_all）
  allowMuteAll: true
  # 允许定时禁言（timed_mute）
  allowMuteTimed: true
  # 允许修改群名
  allowGroupName: true
  # 允许修改群公告
  allowNotice: true
  # 允许修改头衔展示模式
  allowTitleDisplay: true
  # 允许群搜索
  allowSearch: true
  # 允许拉黑
  allowBlacklist: true
  # 允许自定义头衔
  allowCustomTitle: true
  # 允许等级头衔
  allowLevelTitle: true

# 图片生成设置
imageGen:
  # 是否启用图片生成功能
  enabled: false
  # 生图模型 API 地址（OpenAI 兼容 /images/generations 接口）
  apiBase: "https://api.openai.com/v1"
  # API 密钥
  apiKey: ""
  # 模型 ID（如 dall-e-3、dall-e-2、或其他兼容服务提供的模型名）
  model: "dall-e-3"
  # 默认图片尺寸（部分模型支持 1024x1024、1792x1024、1024x1792）
  defaultSize: "1024x1024"
  # 默认图片质量（仅 dall-e-3 支持 standard/hd，其他模型忽略）
  quality: "standard"
  # 生成超时（毫秒）
  timeout: 120000
  # 允许使用生图功能的用户 QQ 列表（空数组 = 所有人都能用）
  allowedUsers: []
  # 每用户每天生图次数上限（0 = 不限制）
  dailyLimit: 0
  # 每用户每天预估 token 消耗上限（0 = 不限制，按 1000 token/张 估算）
  dailyTokenEstimate: 0

# Agent 能力设置（AI 在受控沙箱工作区执行命令完成任务，仅主人可触发）
agent:
  # 是否启用 Agent 能力。默认关闭（P0 安全策略）：首次安装需主人手动开启。
  # 开启后主人会话可获得在受控沙箱执行命令的能力；非主人一律不注入（masterOnly 门控）
  enabled: false
  # 仅允许主人（permissions.masters）触发。命令执行权限较高，默认仅主人
  masterOnly: true
  # 单次任务最大执行轮数（AI 出命令→执行→回传 为一轮，>=1，无硬上限截断，受 API 配额/超时约束）。
  # 网页后台可配置，默认 5：低配额 API（如 RPM≤3）建议 2~3；高配额可 5~8 或更大
  maxRounds: 5
  # 单条命令超时（毫秒）
  commandTimeout: 30000
  # 两次 LLM 调用之间的最小间隔（毫秒）：多轮循环连续调用间隔过短会触发上游速率限制，可按需调大
  callIntervalMs: 1000
  # 额外允许的命令（追加白名单，如：gcc、make）
  extraAllowedCommands: []
  # 额外禁止的命令（追加黑名单，正则表达式，如：["gcc"]）
  extraDeniedPatterns: []

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
  # 当 web.port 被占用时，是否自动尝试下一个端口（范围 [port, port+20]）。
  # false=占用直接报错；true=自动找下一个可用端口（默认 true，防止 Yunzai 启动时因端口被占整体崩溃）
  autoPortScan: true
  # 是否信任反向代理的 X-Forwarded-For / X-Real-IP / CF-Connecting-IP 头。
  #  仅当你已经在前面架了 Nginx/Caddy/Cloudflare 并正确设置头时才设为 true。
  trustProxy: false
  # 可信代理来源网段（仅当 trustProxy=true 时生效，配合上面的头来还原真实客户端 IP）。
  #  安全说明：只有请求确实来自这些代理时才会信任转发头，否则攻击者可伪造 XFF 绕过 IP 绑定/限速。
  #  默认 ["127.0.0.1","::1"]（回环），即反向代理与插件部署在同一台机器，无需配置。
  #  若反向代理在其他机器/网段，如 Nginx 在 10.0.0.10：trustedProxies: ["10.0.0.10"]
  trustedProxies: []
`

if (!fs.existsSync(DEFAULT_CONFIG)) {
  fs.writeFileSync(DEFAULT_CONFIG, defaultConfigContent, { encoding: 'utf-8', mode: 0o600 })
  try { fs.chmodSync(DEFAULT_CONFIG, 0o600) } catch (_) {}
}
// config.yaml 是用户本地配置：首次不存在才初始化一份默认值，后续绝不写入仓库，避免 git pull/强制覆盖 把用户配置洗掉
if (!fs.existsSync(USER_CONFIG)) {
  try {
    fs.writeFileSync(USER_CONFIG, defaultConfigContent, { encoding: 'utf-8', mode: 0o600 })
    try { fs.chmodSync(USER_CONFIG, 0o600) } catch (_) {}
  } catch (err) {
    console.error('[ai0-plugin] 初始化 config.yaml 失败：', err.message)
  }
}

let cachedConfig = null
let lastMtime = 0
let lastParseError = null   // 最近一次 YAML 解析失败信息（给 #ai诊断 展示）

// 以原子方式保存到 config.yaml（与 llm.saveHistory 相同策略：先 tmp→rename，成功后写 .bak）
function atomicWriteYaml(filePath, content) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = filePath + `.tmp.${crypto.randomBytes(16).toString('hex')}`
  const bak = filePath + '.bak'
  fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 })
  // 存在旧文件 → 先写 .bak
  try {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, bak)
  } catch (_) {}
  fs.renameSync(tmp, filePath)
}

export function setForceLoad(v) {
  loadConfig.__forceLoad = !!v
}

export function loadConfig() {
  // #ai重载 可强制绕过 mtime 缓存（用 setForceLoad 设置，避免引用 ESM 模块内不存在的 cfg 标识符）
  const force = !!loadConfig.__forceLoad
  if (!force && cachedConfig && fs.existsSync(USER_CONFIG)) {
    try {
      const mtime = fs.statSync(USER_CONFIG).mtimeMs
      if (mtime === lastMtime) return cachedConfig
    } catch (_) {}
  }
  // 1. 尝试默认（config.yaml）
  try {
    let mtime = 0
    try { mtime = fs.statSync(USER_CONFIG).mtimeMs } catch (_) {}
    const userContent = fs.readFileSync(USER_CONFIG, 'utf-8')
    const parsed = YAML.parse(userContent) || {}
    applyEnvOverrides(parsed)
    cachedConfig = parsed
    lastMtime = mtime
    lastParseError = null
    return cachedConfig
  } catch (err) {
    const primaryErr = err
    lastParseError = { file: USER_CONFIG, msg: err.message, at: Date.now() }
    // 2. YAML 格式损坏 → 尝试 .bak 自动恢复
    const bak = USER_CONFIG + '.bak'
    if (fs.existsSync(bak)) {
      try {
        const raw = fs.readFileSync(bak, 'utf-8')
        const parsed = YAML.parse(raw) || {}
        safeLogger.warn(`[ai0-plugin] config.yaml 格式损坏（${primaryErr.message}），已自动从 config.yaml.bak 恢复`)
        try { atomicWriteYaml(USER_CONFIG, raw) } catch (_) {}
        applyEnvOverrides(parsed)
        cachedConfig = parsed
        try { lastMtime = fs.statSync(USER_CONFIG).mtimeMs } catch (_) { lastMtime = 0 }
        lastParseError = null
        return cachedConfig
      } catch (bakErr) {
        safeLogger.warn(`[ai0-plugin] config.yaml.bak 也解析失败：${bakErr.message}`)
      }
    }
    // 3. 实在不行 → 退回默认模板（绝不让 YAML 坏了把 Yunzai 启动也拖崩；但不会覆写坏文件，方便人工修复）
    safeLogger.error(`[ai0-plugin] 配置解析失败，退回内置默认模板（请修复 config.yaml：${primaryErr.message}）`)
    try {
      const parsed = YAML.parse(defaultConfigContent) || {}
      applyEnvOverrides(parsed)
      cachedConfig = parsed
      lastMtime = 0
      return cachedConfig
    } catch (_) {
      return {}
    }
  }
}

// 用环境变量覆盖敏感配置（可选替代方案）：设置后可不在 config.yaml 中填写密钥。
//   AI0_LLM_API_KEY    → 覆盖默认模型的 apiKey
//   AI0_LLM_API_BASE   → 覆盖默认模型的 apiBase（可选）
//   AI0_IMAGE_API_KEY  → 覆盖图片生成的 apiKey（可选）
// 返回是否有覆盖发生（供调用方判断是否需要重建缓存）。
export function applyEnvOverrides(parsed) {
  const overridden = []
  const def = parsed.model && parsed.model.default
  const envLlmKey = process.env.AI0_LLM_API_KEY
  if (def && envLlmKey) {
    const mm = parsed.model[def]
    if (mm && typeof mm === 'object') { mm.apiKey = envLlmKey; overridden.push(`model.${def}.apiKey`) }
  }
  const envLlmBase = process.env.AI0_LLM_API_BASE
  if (def && envLlmBase) {
    const mm = parsed.model[def]
    if (mm && typeof mm === 'object') { mm.apiBase = envLlmBase; overridden.push(`model.${def}.apiBase`) }
  }
  const envImgKey = process.env.AI0_IMAGE_API_KEY
  if (envImgKey) {
    if (!parsed.imageGen || typeof parsed.imageGen !== 'object') parsed.imageGen = {}
    parsed.imageGen.apiKey = envImgKey; overridden.push('imageGen.apiKey')
  }
  return overridden
}

/** 返回当前被环境变量覆盖的配置字段列表（用于 POST /api/config 写入时跳过） */
export function getEnvOverriddenKeys() {
  const keys = []
  const config = loadConfig()
  const def = config.model?.default
  if (def && process.env.AI0_LLM_API_KEY) keys.push(`model.${def}.apiKey`)
  if (def && process.env.AI0_LLM_API_BASE) keys.push(`model.${def}.apiBase`)
  if (process.env.AI0_IMAGE_API_KEY) keys.push('imageGen.apiKey')
  return keys
}

/** 最近一次配置解析错误（#ai诊断 展示用） */
export function getLastConfigError() {
  return lastParseError
}

export function saveConfig(config) {
  try {
    // 过滤掉环境变量覆盖的键，防止密钥明文落盘
    const envKeys = getEnvOverriddenKeys()
    const cleaned = structuredClone(config)
    for (const dotKey of envKeys) {
      const parts = dotKey.split('.')
      let target = cleaned
      for (let i = 0; i < parts.length - 1; i++) {
        target = target?.[parts[i]]
      }
      if (target && typeof target === 'object') {
        delete target[parts[parts.length - 1]]
      }
    }
    // 深度合并：保留磁盘上存在但前端未传的字段，防止字段丢失
    // 安全：跳过 __proto__/constructor/prototype 等危险键，防止原型污染
    const isDangerKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype'
    for (const k of Object.keys(cleaned)) {
      if (isDangerKey(k)) delete cleaned[k]
    }
    if (fs.existsSync(USER_CONFIG)) {
      try {
        const diskRaw = fs.readFileSync(USER_CONFIG, 'utf-8')
        const diskConfig = YAML.parse(diskRaw) || {}
        for (const k of Object.keys(diskConfig)) {
          if (isDangerKey(k)) continue
          if (!(k in cleaned)) {
            cleaned[k] = diskConfig[k]
          }
        }
      } catch (_) {}
    }
    const content = YAML.stringify(cleaned)
    atomicWriteYaml(USER_CONFIG, content)
    // 缓存时重新应用 env 覆盖键，防止 web 保存后 env 失效直到重启
    const withEnv = structuredClone(cleaned)
    applyEnvOverrides(withEnv)
    cachedConfig = withEnv
    try { lastMtime = fs.statSync(USER_CONFIG).mtimeMs } catch (_) { lastMtime = Date.now() }
    lastParseError = null
    return true
  } catch (err) {
    safeLogger.error(`[ai0-plugin] 保存配置失败: ${err.message}`)
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
