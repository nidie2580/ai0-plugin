import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as cfg from '../config/index.js'
import * as llm from './llm.js'
import { safeLogger, sanitizeLog } from './globals.js'

/**
 * AI0-Plugin Agent 能力模块
 * 让 AI 在受控沙箱工作区中执行命令完成任务（仅主人会话）。
 * 安全边界：
 *   - 命令白名单：仅允许 ls/git/curl/node/python 等常规开发命令
 *   - 危险黑名单：sudo / rm -rf / shutdown / ssh / chmod(非+x) / 命令替换 等一律拒绝
 *   - 工作目录锁定在 agent/workspace 内，命令输出有长度上限
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.join(__dirname, '..')
const AGENT_ROOT = path.join(PLUGIN_ROOT, 'agent')
const WORKSPACE = path.join(AGENT_ROOT, 'workspace')

const DEFAULT_COMMAND_TIMEOUT = 30_000
const MAX_CMD_LEN = 2000
const MAX_OUTPUT_CHARS = 3000
// 单次任务最大 LLM 调用轮数默认值：5（比旧值 8 更保守，适配 RPM≤3 的低配额账号如 Kimi）
// 网页后台可配置 agent.maxRounds（范围 1~20），此处仅作为"未配置时的兜底默认值"
const DEFAULT_MAX_ROUNDS = 5
// 轮数硬上限：防止配置误填超大值导致长时间占用/资源耗尽
const MAX_ROUNDS_HARD_CAP = 20

// 两次 LLM 调用之间的最小间隔（毫秒）：多轮循环连续调用时若间隔过短会触发上游速率限制
const DEFAULT_CALL_INTERVAL_MS = 1000
// —— 429 速率限制固定退避策略 ——
// 低配额账号（如 Kimi RPM=3，即每分钟最多 3 次）在 1s 后重试会立刻再次撞上限额，
// 因此不依赖解析 retry-after（各 provider 格式不一），统一固定等待 60 秒后再重试。
// 等待/次数可通过 setRateLimitRetryConfig 覆盖（测试用），默认 60s / 最多重试 3 次（共 4 次尝试）。
let RATE_LIMIT_RETRY_WAIT_MS = 60_000
let RATE_LIMIT_MAX_RETRIES = 3
/** 覆盖 429 退避参数（测试用）：waitMs=固定等待毫秒，maxRetries=最多重试次数 */
export function setRateLimitRetryConfig(waitMs, maxRetries) {
  if (Number.isFinite(waitMs) && waitMs >= 0) RATE_LIMIT_RETRY_WAIT_MS = waitMs
  if (Number.isFinite(maxRetries) && maxRetries >= 0) RATE_LIMIT_MAX_RETRIES = maxRetries
}
// 模块级：记录上一次 LLM 调用的完成时间，用于轮间间隔控制
let lastLlmCallTime = 0

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, Number(ms) || 0)))
}

/** 判断某次 LLM 调用错误是否为 429 速率限制 */
function isRateLimit(err) {
  if (!err) return false
  if (err.status === 429) return true
  return /HTTP 429|too many requests|rate.?limit|请求过于频繁|速率限制/i.test(String(err?.message || ''))
}

/**
 * 带速率限制与重试的 LLM 调用：
 *   1) 调用前保证与上一次调用的间隔 ≥ agent.callIntervalMs（防限流）
 *   2) 429 速率限制：固定等待 RATE_LIMIT_RETRY_WAIT_MS（默认 60s）后重试，
 *      最多重试 RATE_LIMIT_MAX_RETRIES（默认 3）次；仍失败返回错误
 *   3) 非 429 错误：直接返回错误，不做重试（避免掩盖真实故障）
 * @param {object} opts 透传给 llm.chatCompletions 的选项（modelKey/signal 等）
 * @param {Function} [callFn] 可注入的调用函数（测试用），默认走 llm.chatCompletions
 * @returns {{ ok: true, res } | { ok: false, error: Error, aborted?: boolean }}
*/
export async function callLlmWithRetry({ messages, opts = {}, callFn = null } = {}) {
  const conf = cfg.get('agent', {}) || {}
  const callInterval = Number(conf.callIntervalMs) || DEFAULT_CALL_INTERVAL_MS
  // —— 轮间间隔控制：距上次调用不足 callIntervalMs 则先等待 ——
  const wait = callInterval - (Date.now() - lastLlmCallTime)
  if (wait > 0) await sleep(wait)
  lastLlmCallTime = Date.now()

  const chat = callFn || ((msgs, o) => llm.chatCompletions(msgs, o))
  let lastErr = null
  const maxAttempts = 1 + RATE_LIMIT_MAX_RETRIES
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await chat(messages, opts)
      return { ok: true, res }
    } catch (err) {
      lastErr = err
      if (opts.signal?.aborted) return { ok: false, error: err, aborted: true }
      if (!isRateLimit(err)) {
        // 非 429 错误：直接返回，不重试
        return { ok: false, error: err, aborted: false }
      }
      if (attempt >= maxAttempts) break
      safeLogger.warn(`[ai0-plugin] Agent LLM 调用触发速率限制(第${attempt}次)，固定等待 ${RATE_LIMIT_RETRY_WAIT_MS / 1000}s 后重试: ${sanitizeLog(err?.message || err)}`)
      await sleep(RATE_LIMIT_RETRY_WAIT_MS)
    }
  }
  return { ok: false, error: lastErr }
}

// —— 命令白名单：AI 可执行的命令（首命令必须命中，含 cd 内建） ——
const DEFAULT_ALLOWED = new Set([
  // 基本文件/目录/文本
  'ls', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'whoami', 'date',
  'grep', 'find', 'which', 'tree', 'stat', 'file', 'du', 'df', 'sort', 'uniq',
  'cut', 'tr', 'sed', 'awk', 'basename', 'dirname', 'realpath', 'readlink',
  'diff', 'cmp',
  // 文件操作（rm 受黑名单限制：禁止 -r/-f）
  'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'chmod',
  // 网络/网页访问
  'curl', 'wget',
  // 开发工具（注意：node/python/npm/npx 等解释器可执行任意代码、读写任意文件、
  // 发起任意网络请求，会完全绕过下方白名单/黑名单/路径黑名单，故默认不开放。
  // 如确有需要，管理员用 agent.extraAllowedCommands 显式开启并自担风险）
  'git', 'rg', 'fd', 'jq',
  // 只读系统信息
  'ps', 'free', 'uname', 'hostname', 'uptime', 'lsblk'
])

// —— 危险模式黑名单：命中即拒绝 ——
const DEFAULT_DENY = [
  // 提权 / 系统管理
  /\bsudo\b/, /\bsu\b/, /\buseradd\b/, /\buserdel\b/, /\busermod\b/, /\bpasswd\b/, /\bgroupadd\b/,
  /\bshutdown\b/, /\breboot\b/, /\bpoweroff\b/, /\bhalt\b/, /\binit\s*[06]/,
  // 磁盘 / 分区 / 挂载
  /\bmkfs\b/, /\bfdisk\b/, /\bparted\b/, /\bmount\b/, /\bumount\b/, /\bdd\b/,
  // 网络管理 / 防火墙
  /\biptables\b/, /\bip6tables\b/, /\bfirewall-cmd\b/, /\bufw\b/,
  // 服务 / 计划任务 / 内核
  /\bsystemctl\b/, /\bservice\b/, /\bcrontab\b/, /\bsysctl\b/, /\bmodprobe\b/,
  // 权限 / 属性修改（仅 chmod +x 白名单特例放行）
  /\bchown\b/, /\bchattr\b/, /\bchmod\b(?!\s+\+x\b)/,
  // 进程杀伤
  /\bkill\b/, /\bpkill\b/, /\bkillall\b/,
  // 远程连接 / 隧道（防滥用）
  /\bnc\b/, /\bncat\b/, /\bnetcat\b/, /\btelnet\b/, /\bssh\b/, /\bscp\b/, /\bsftp\b/, /\bsocat\b/,
  // 下载后直接执行（curl/wget 管道到 shell 或解释器）
  /(?:curl|wget)\b.*\|\s*(?:ba|z|f|da)?sh\b/,
  /(?:curl|wget)\b.*\|\s*(?:python|python3|perl|ruby|node)\b/,
  // 编码解码头（用于隐藏恶意脚本）
  /base64\s+-d\b/,
  // 写入系统关键目录
  />(?:\s*)(?:\/etc\/|\/usr\/|\/boot\/|\/root\/|\/var\/|\/sbin\/|\/bin\/)/,
  // 交互式编辑器（无法在沙箱中可靠工作）
  /\bnano\b/, /\bvim\b/, /\bvi\b/, /\bless\b/, /\bmore\b/,
  // 命令替换 / 反引号 / 变量展开（绕过白名单的常见手法）
  /\$\(/, /\$\{/, /`/,
  // TLS/证书工具（openssl 常用于窃取/私钥操作，禁止）
  /\bopenssl\b/,
  // —— 绕过白名单的"子进程派生/破坏性"原语：允许命令会再拉起重定向到非白名单程序，或批量删除 ——
  /(?:^|[\s;|&])find\b[^|]*\s+-(?:exec|execdir|delete|ok|okdir)\b/,  // find -exec/-delete/-ok 执行任意程序或批量删除
  /(?:^|[\s;|&])tar\b[^|]*\s+--to-command\b/,                         // tar --to-command 执行任意程序
  // —— 越界读取/写入系统目录（工作区 confined，显式绝对系统路径一律拒绝；避免误伤 URL 中的 /lib/ 等路径） ——
  /(?:^|\s)\/(?:etc|root|usr|home|bin|sbin|lib|boot|var|tmp)\//,
  // —— 敏感凭据文件（防读取系统/用户私钥与密钥） ——
  /(?:\.ssh\/|\.aws\/|\.kube\/|\.m2\/settings\.xml|\/\.npmrc|\.git-credentials|id_rsa|id_ed25519|\.bash_history)/,
]

/**
 * rm 危险参数检查：token 化（跳过引号内容），仅在出现 rm 命令时检查其后的 flag。
 * 避免把 git log --grep='rm -r' 这类引号文本误伤，同时拦截 rm file -r 的后置参数形式。
 */
export function hasDangerousRm(cmd) {
  const tokens = []
  let cur = ''
  let quote = null
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (quote) {
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue }
    if (ch === '\\' && i + 1 < cmd.length) { i += 2; continue }
    if (/\s/.test(ch)) { if (cur) { tokens.push(cur); cur = '' } i++; continue }
    cur += ch
    i++
  }
  if (cur) tokens.push(cur)
  for (let t = 0; t < tokens.length; t++) {
    if (tokens[t] !== 'rm') continue
    for (let j = t + 1; j < tokens.length; j++) {
      const tok = tokens[j]
      if (tok === ';' || tok === '|' || tok === '&&') break
      if (!tok.startsWith('-')) continue
      const flags = tok.replace(/^-+/, '').toLowerCase()
      if (flags.includes('r') || flags.includes('f')) return true
      if (/(recursive|force|no-preserve-root)/.test(flags)) return true
    }
  }
  return false
}

// —— 引号感知的 shell 段拆分：正确处理 "a;b" 引号内容，避免误拆 ——
// 作为段边界的操作符：| ; && 单 &（后台/顺序执行）以及换行 \n \r（shell 同样把换行当语句分隔）。
// 解释器（node/python/npm 等）不在白名单中，若漏拆上面任一操作符，攻击者可用
// `ls & python3 -c ...` 或 `ls\npython3 -c ...` 让非白名单首命令绕过校验执行任意代码。
// 例外：& 前一个字符是 > 或 < 时为"复制文件描述符"重定向（2>&1、>&file、<&3），不是分隔符，需保留。
export function splitSegments(c) {
  const segs = []
  let cur = ''
  let quote = null
  let i = 0
  while (i < c.length) {
    const ch = c[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; i++; continue }
    if (ch === '\\' && i + 1 < c.length) { cur += ch + c[i + 1]; i += 2; continue }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n' || ch === '\r') {
      if (ch === '&') {
        const prevCh = cur.trimEnd().slice(-1)
        // 重定向复制描述符形式（>&、<&）不是后台分隔符，原样保留
        if (prevCh === '>' || prevCh === '<') { cur += ch; i++; continue }
        // && 连写：额外消费第二个 &
        if (c[i + 1] === '&') i++
      }
      if (cur.trim()) segs.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) segs.push(cur.trim())
  return segs
}

function firstCommand(seg) {
  const m = seg.match(/^\S+/)
  return m ? m[0] : ''
}

/**
 * 校验一条命令是否允许执行。
 * @returns {{ ok: boolean, reason?: string, cmd?: string }}
 */
export function checkCommand(rawCmd, opts = {}) {
  const cmd = String(rawCmd || '').trim()
  if (!cmd) return { ok: false, reason: '命令为空' }
  if (cmd.length > MAX_CMD_LEN) return { ok: false, reason: `命令过长（上限 ${MAX_CMD_LEN} 字符）` }

  const conf = cfg.get('agent', {}) || {}
  const extraAllowed = Array.isArray(conf.extraAllowedCommands) ? conf.extraAllowedCommands : []
  const extraDenied = Array.isArray(conf.extraDeniedPatterns) ? conf.extraDeniedPatterns : []
  const allowed = new Set([...DEFAULT_ALLOWED, ...extraAllowed])

  // 1) 危险模式黑名单（含用户扩展）
  for (const re of [...DEFAULT_DENY, ...extraDenied.map(d => safeRegex(d)).filter(Boolean)]) {
    if (re.test(cmd)) return { ok: false, reason: `命中危险模式: ${re.source}` }
  }

  // 2) rm 危险参数检查（token 化，引号内文本不误伤）
  if (hasDangerousRm(cmd)) return { ok: false, reason: '禁止递归/强制删除：rm -r / -f / --recursive / --force' }

  // 3) 引号感知拆分，逐段校验首命令白名单
  const segs = splitSegments(cmd)
  if (!segs.length) return { ok: false, reason: '无法解析命令' }
  for (const seg of segs) {
    const c0 = firstCommand(seg)
    if (!c0) return { ok: false, reason: '空命令段' }
    if (c0.includes('/')) return { ok: false, reason: `不允许路径形式命令: ${c0}` }
    if (!allowed.has(c0)) return { ok: false, reason: `命令不在白名单: ${c0}` }
  }

  return { ok: true, cmd }
}

function safeRegex(src) {
  try { return new RegExp(String(src)) } catch { return null }
}

// —— 工作区初始化 ——
const WORKSPACE_FILES = {
  'AGENTS.md': `# AI0-Plugin Agent 工作规范

你正在 ai0-plugin 提供的受控沙箱工作区中执行任务。

## 工作目录
- 当前目录：workspace/（你的所有文件操作都发生在这里）
- 预置文件：AGENTS.md（本规范）、MEMORY.md（跨会话记忆）、README.md（工作区说明）

## 可用命令
- 文件与目录：ls cat head tail wc grep find sed awk sort uniq cut mkdir touch cp mv rm tar unzip zip diff file stat du
- 开发工具：git jq（node/python/npm 等解释器默认禁用，如确需由管理员在 extraAllowedCommands 开启）
- 网络：curl wget（禁止管道到 shell 执行）
- 其他：echo printf pwd whoami date which ps free tree rg fd

## 禁止命令
- 提权/系统管理：sudo su useradd passwd shutdown reboot mkfs mount umount fdisk dd
- 危险删除：rm -rf / rm -r / rm -f / rm --recursive
- 远程连接：ssh scp telnet nc ncat socat
- 权限修改：chown chattr（chmod 仅允许 chmod +x）
- 其他：kill pkill systemctl crontab iptables base64 -d 命令替换 $(...) 和反引号 写入 /etc/ 等系统目录 交互编辑器

## 工作方式
1. 分析用户任务，规划步骤
2. 需要执行命令时，输出 [action:agent:命令]（可先写说明再跟命令标签）
3. 观察命令执行结果，继续下一步
4. 全部完成后输出最终成果总结（纯文本，不带命令标签）
`,
  'MEMORY.md': `# Agent 记忆文件

此文件记录跨会话需要长期保留的重要信息（用户偏好、关键决策、项目知识）。
工作中获得值得长期记住的信息时，追加写入本文件。

## 记录规则
- 只记录"如何做"的行为模式和项目知识，不记录"做了什么"的一次性任务细节
- 每条格式：[日期] 类别 - 内容
- 已有内容可在新会话中被引用

## 已有记录
（暂无）
`,
  'README.md': `# AI0-Plugin Agent 工作区

本目录是 AI0-Plugin 的 Agent 沙箱工作区。

- workspace/：AI 可读写的文件工作区
- AGENTS.md：AI 工作规范（命令白名单/黑名单、工作方式）
- MEMORY.md：跨会话记忆文件

## 安全边界
- 命令经白名单 + 黑名单双重校验后执行
- 工作目录锁定在本目录内
- 禁止 sudo / rm -rf / 远程连接 / 系统管理类危险命令
- 命令输出长度受限，避免污染上下文
`
}

export function initWorkspaceFiles() {
  for (const d of [AGENT_ROOT, WORKSPACE]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
  }
  for (const [name, content] of Object.entries(WORKSPACE_FILES)) {
    const p = path.join(WORKSPACE, name)
    if (!fs.existsSync(p)) {
      try {
        fs.writeFileSync(p, content, { encoding: 'utf-8', mode: 0o600 })
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] 初始化 agent 工作区文件失败: ${sanitizeLog(err?.message || err)}`)
      }
    }
  }
}

/** 获取 agent 工作区信息（供诊断/上下文展示） */
export function getAgentInfo() {
  return { root: AGENT_ROOT, workspace: WORKSPACE }
}

/** 注入给 AI 的 Agent 能力上下文（仅主人会话且 agent.enabled 时） */
export function buildAgentContext() {
  initWorkspaceFiles()
  const conf = cfg.get('agent', {}) || {}
  const maxRounds = Number(conf.maxRounds) || DEFAULT_MAX_ROUNDS
  return [
    '【Agent 能力】你可以在受控沙箱工作区中执行命令来完成任务。',
    `工作目录：${WORKSPACE}（已预置 AGENTS.md / MEMORY.md / README.md）`,
    '需要执行命令时，在回复中输出：[action:agent:命令]。',
    '命令执行结果会作为后续上下文返回，你可以根据结果继续操作，直到任务完成。',
    `单次任务最多执行 ${maxRounds} 轮命令，完成后输出最终成果总结。`,
    '支持 git / curl / wget / ls / cat / grep / find / sed / awk / mkdir / touch / cp / mv / rm（禁止 rm -rf）等常规命令（node/python 等解释器默认禁用）。',
    '禁止 sudo / shutdown / reboot / mkfs / mount / chown / ssh / scp / nc / chmod（除+x）/ 命令替换 / 写入系统目录等危险操作。'
  ].join('\n')
}

/** 执行单条命令（带超时、输出上限、固定工作目录）；内部强制安全校验（纵深防御） */
export function runCommand(cmd, opts = {}) {
  return new Promise((resolve) => {
    // 即使调用方忘记先 checkCommand，这里也会拦截危险命令
    const check = checkCommand(cmd)
    if (!check.ok) {
      return resolve({ ok: false, code: -1, costMs: 0, error: `命令被安全策略拒绝：${check.reason}`, detail: `命令被安全策略拒绝：${check.reason}` })
    }
    const conf = cfg.get('agent', {}) || {}
    const timeout = Number(conf.commandTimeout) || DEFAULT_COMMAND_TIMEOUT
    const cwd = opts.cwd || WORKSPACE
    const start = Date.now()
    exec(cmd, {
      cwd,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf-8'
    }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      const errOut = String(stderr || '').trim()
      const errMsg = err ? String(err?.message || err) : ''
      const costMs = Date.now() - start
      const detail = [out, errOut, errMsg].filter(Boolean).join('\n')
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        timedOut: !!err?.killed || /timed out/i.test(errMsg),
        costMs,
        stdout: out.slice(0, MAX_OUTPUT_CHARS),
        stderr: errOut.slice(0, MAX_OUTPUT_CHARS),
        error: errMsg.slice(0, 500),
        detail: sanitizeLog(detail).slice(0, MAX_OUTPUT_CHARS)
      })
    })
  })
}

function formatResult(r) {
  const head = `退出码=${r.code} 耗时=${r.costMs}ms`
  if (!r.detail) return `${head}\n（无输出）`
  return `${head}\n${r.detail}`
}

/**
 * 多轮 Agent 自动循环：任务 → AI 出命令 → 执行 → 结果回传 → 继续，直到完成或达轮数上限。
 * @returns {{ done: boolean, finalText: string, rounds: number, logs: Array }}
 */
export async function runAgentLoop({ task, maxRounds, modelKey = null } = {}) {
  initWorkspaceFiles()
  const conf = cfg.get('agent', {}) || {}
  const rounds = Math.max(1, Math.min(Number(maxRounds) || Number(conf.maxRounds) || DEFAULT_MAX_ROUNDS, MAX_ROUNDS_HARD_CAP))

  const sys = [
    buildAgentContext(),
    '',
    '你的任务：',
    String(task || '').slice(0, 4000),
    '',
    '执行规则：',
    '1. 需要执行命令时，输出一行 [action:agent:命令]；可先输出一句说明。',
    '2. 观察命令结果后继续；重复上一步已成功的命令没有意义。',
    '3. 遇报错请分析原因并修正参数/路径，不要反复重试同一失败命令。',
    '4. 不需要更多命令时，直接输出最终成果总结（纯文本）。'
  ].join('\n')

  const messages = [{ role: 'system', content: sys }]
  const logs = []
  let finalText = ''

  for (let i = 0; i < rounds; i++) {
    const call = await callLlmWithRetry({ messages, opts: { modelKey } })
    if (!call.ok) {
      const reason = call.aborted ? '（请求已被取消/超时）'
        : isRateLimit(call.error) ? 'Agent 因 API 速率限制暂时无法继续，请稍后重试或降低 maxRounds 配置'
        : sanitizeLog(call.error?.message || call.error)
      finalText = `Agent 执行中断：模型调用失败 ${reason}`
      safeLogger.error(`[ai0-plugin] agent 循环模型调用失败: ${reason}`)
      return { done: false, finalText, rounds: i, logs }
    }
    const res = call.res
    const text = String(res?.text || '').trim()
    if (!text) { finalText = '模型未产生输出，任务提前结束。'; return { done: false, finalText, rounds: i, logs } }

    const match = text.match(/\[action:agent:([^\]]+)\]/)
    if (!match) {
      // 无命令 → 任务完成
      finalText = text
      return { done: true, finalText, rounds: i + 1, logs }
    }

    const cmd = match[1].trim()
    const check = checkCommand(cmd)
    if (!check.ok) {
      logs.push({ cmd, ok: false, reason: check.reason })
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'system', content: `命令被安全策略拒绝：${check.reason}\n请改用允许的命令继续。` })
      continue
    }

    const r = await runCommand(cmd)
    logs.push({ cmd, ok: r.ok, code: r.code, timedOut: r.timedOut, costMs: r.costMs, output: r.detail })
    messages.push({ role: 'assistant', content: text })
    // 命令输出来自不可信的外部环境（可能反射文件内容），以 user 身份 + untrusted 边界注入，防止其内容以 system 权重劫持后续指令
    messages.push({ role: 'user', content: `<command_output>\n${formatResult(r)}\n</command_output>` })
  }

  finalText = `已达最大执行轮数（${rounds}），任务未完全完成。已执行的命令与结果见上。`
  return { done: false, finalText, rounds, logs }
}

/**
 * 被动单次执行：AI 普通回复中若含 [action:agent:命令]，执行一次并回传结果。
 * @returns {null | { cleanText, ok, cmd, result }}
 */
export async function parseAndExecuteAgentAction(replyText) {
  const re = /\[action:agent:([^\]]+)\]/i
  const m = replyText.match(re)
  if (!m) return null
  const cmd = m[1].trim()
  const cleanText = replyText.replace(m[0], '').trim()
  const check = checkCommand(cmd)
  if (!check.ok) {
    return { cleanText, ok: false, cmd, result: `命令被安全策略拒绝：${check.reason}` }
  }
  const r = await runCommand(cmd)
  return { cleanText, ok: r.ok, cmd, result: formatResult(r) }
}

/**
 * 在已有对话 history 上继续 Agent 多轮循环（供 chatService 普通对话集成）。
 * AI 首次输出含 [action:agent:...] 后，循环：执行命令 → 结果回传 LLM → 继续，
 * 直到 AI 不再输出 agent 指令或达轮数上限。
 * @returns {{ done, finalText, rounds, logs }}
 */
export async function continueAgentInHistory({ history, assistantText, modelKey = null, signal = null, maxRounds = null } = {}) {
  initWorkspaceFiles()
  const conf = cfg.get('agent', {}) || {}
  const cap = Math.max(1, Math.min(Number(maxRounds) || Number(conf.maxRounds) || DEFAULT_MAX_ROUNDS, MAX_ROUNDS_HARD_CAP))
  const messages = (history || []).map(m => ({ role: m.role === 'system' ? 'system' : m.role, content: String(m.content || '') }))
  messages.push({ role: 'assistant', content: String(assistantText || '') })
  const logs = []
  let text = String(assistantText || '')
  let executed = 0

  const roundTrip = async () => {
    const call = await callLlmWithRetry({ messages, opts: { modelKey, signal } })
    if (!call.ok) {
      if (call.aborted || signal?.aborted) return { aborted: true, error: '' }
      return { rateLimit: isRateLimit(call.error), aborted: false, error: sanitizeLog(call.error?.message || call.error) }
    }
    return String(call.res?.text || '').trim()
  }

  while (executed < cap) {
    const match = text.match(/\[action:agent:([^\]]+)\]/)
    if (!match) break
    const cmd = match[1].trim()
    const check = checkCommand(cmd)
    if (!check.ok) {
      logs.push({ cmd, ok: false, reason: check.reason })
      messages.push({ role: 'system', content: `命令被安全策略拒绝：${check.reason}\n请改用允许的命令继续。` })
    } else {
      const r = await runCommand(cmd)
      logs.push({ cmd, ok: r.ok, code: r.code, costMs: r.costMs, output: r.detail })
      // 同上：命令输出为不可信内容，以 user 身份 + untrusted 边界注入，避免其内容以 system 权重劫持后续指令
      messages.push({ role: 'user', content: `<command_output>\n${formatResult(r)}\n</command_output>` })
    }
    executed++
    const next = await roundTrip()
    if (typeof next !== 'string') {
      const reason = next.aborted ? '（请求已被取消/超时）'
        : next.rateLimit ? 'Agent 因 API 速率限制暂时无法继续，请稍后重试或降低 maxRounds 配置'
        : next.error || '（未知错误）'
      return { done: false, finalText: `Agent 执行中断：模型调用失败 ${reason}`, rounds: executed, logs }
    }
    text = next
    if (!text) return { done: false, finalText: '模型未产生输出，Agent 提前结束。', rounds: executed, logs }
  }

  const stillAction = /\[action:agent:/.test(text)
  const finalText = text.replace(/\[action:agent:[^\]]*\]/g, '').trim()
  if (stillAction) {
    return {
      done: false,
      finalText: `已达最大执行轮数（${cap}），Agent 停止继续执行命令。\n${finalText}`,
      rounds: executed,
      logs
    }
  }
  return { done: true, finalText, rounds: executed, logs }
}
