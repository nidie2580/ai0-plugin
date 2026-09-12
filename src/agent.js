import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as cfg from '../config/index.js'
import * as llm from './llm.js'
import * as securityLog from './securityLog.js'
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
// 单次任务最大 LLM 调用轮数默认���：5（比旧值 8 更保守，适配 RPM≤3 的低配额账号如 Kimi）
// 网页后台可配置 agent.maxRounds，代码不再做硬上限截断（彻底放开，受 API 配额与超时自然约束），
// 仅要求 ≥1，此处作为"未配置时的兜底默认值"
const DEFAULT_MAX_ROUNDS = 5

// 两次 LLM 调用之间的最小间隔（毫秒）：多轮循环连续调用时若间隔过短会触发上游速率限制
const DEFAULT_CALL_INTERVAL_MS = 1000
// —— 429 速率限制退避策略（指数退避，可被信号中断） ——
// 低配额账号（如 Kimi RPM=3，即每分钟最多 3 次）在 1s 后重试会立刻再次撞上限额，
// 因此不依赖解析 retry-after（各 provider 格式不一），而是用"指数退避"：
//   第 1 次重试等 base，第 2 次等 base*2，第 3 次等 base*4 … 封顶 RATE_LIMIT_RETRY_CAP_MS。
// 相比固定 60s：既满足低配额账号"须等 60s"的底线，又防止高并发多次重试时请求堆积。
// 参数可通过 setRateLimitRetryConfig 覆盖（测试用），默认 base=30s / cap=180s / 最多重试 3 次。
let RATE_LIMIT_RETRY_BASE_MS = 30_000
let RATE_LIMIT_RETRY_CAP_MS = 180_000
let RATE_LIMIT_MAX_RETRIES = 3
/** 覆盖 429 退避参数（测试用）：baseMs=指数退避基值毫秒，maxRetries=最多重试次数 */
export function setRateLimitRetryConfig(baseMs, maxRetries) {
  if (Number.isFinite(baseMs) && baseMs >= 0) RATE_LIMIT_RETRY_BASE_MS = baseMs
  if (Number.isFinite(maxRetries) && maxRetries >= 0) RATE_LIMIT_MAX_RETRIES = maxRetries
}
/** 第 attempt 次重试前的等待时长（指数退避，封顶） */
function rateLimitWaitMs(attempt) {
  return Math.min(RATE_LIMIT_RETRY_BASE_MS * Math.pow(2, attempt - 1), RATE_LIMIT_RETRY_CAP_MS)
}
// 模块级：记录上一次 LLM 调用的完成时间，用于轮间间隔控制
// 改为 per-identity Map：不同主人/会话互不影响各自的轮间间隔
const lastLlmCallTimes = new Map()
// 全局兜底 key（当调用方未提供身份标识时使用，保持向后兼容）
const GLOBAL_RATE_LIMIT_KEY = '__global__'

function sleep(ms) {
  return new Promise(r => setTimeout(r, Math.max(0, Number(ms) || 0)))
}

/** 可被 signal 中断的等待：abort 后立即 resolve，供退避等待使用，避免硬超时后被长等待卡住 */
function sleepInterruptible(ms, signal = null) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { cleanup(); resolve() }, Math.max(0, Number(ms) || 0))
    const onAbort = () => { cleanup(); resolve() }
    const cleanup = () => {
      clearTimeout(t)
      if (signal) {
        try { signal.removeEventListener('abort', onAbort) } catch (_) {}
      }
    }
    if (signal) {
      if (signal.aborted) { resolve(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
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
 *   2) 429 速率限制：按指数退避等待（base 30s，逐次翻倍，封顶 180s）后重试，
 *      最多重试 RATE_LIMIT_MAX_RETRIES（默认 3）次；仍失败返回错误。
 *      退避等待可被 opts.signal 的 abort 中断（硬超时 / 新请求取代时立即跳出，不空等）
 *   3) 非 429 错误：直接返回错误，不做重试（避免掩盖真实故障）
 * @param {object} opts 透传给 llm.chatCompletions 的选项（modelKey/signal 等）
 * @param {Function} [callFn] 可注入的调用函数（测试用），默认走 llm.chatCompletions
 * @returns {{ ok: true, res } | { ok: false, error: Error, aborted?: boolean }}
*/
export async function callLlmWithRetry({ messages, opts = {}, callFn = null } = {}) {
  const conf = cfg.get('agent', {}) || {}
  const callInterval = Number(conf.callIntervalMs) || DEFAULT_CALL_INTERVAL_MS
  // —— 轮间间隔控制：距上次调用不足 callIntervalMs 则先等待（可被 signal 中断） ——
  // per-identity Map：不同主人/会话的间隔互不影响；未提供 identityKey 时走全局兜底
  const identityKey = opts.identityKey && String(opts.identityKey).trim()
    ? String(opts.identityKey) : GLOBAL_RATE_LIMIT_KEY
  const prevTime = lastLlmCallTimes.get(identityKey) || 0
  const wait = callInterval - (Date.now() - prevTime)
  if (wait > 0) await sleepInterruptible(wait, opts.signal)
  lastLlmCallTimes.set(identityKey, Date.now())
  // 防止 Map 无限增长：超过 512 个 key 时清理最老的一半（极低概率，保守措施）
  if (lastLlmCallTimes.size > 512) {
    const entries = [...lastLlmCallTimes.entries()].sort((a, b) => a[1] - b[1])
    const toRemove = entries.slice(0, Math.floor(entries.length / 2))
    for (const [k] of toRemove) lastLlmCallTimes.delete(k)
  }

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
      // 指数退避：第 attempt 次失败后等 rateLimitWaitMs(attempt)，且可被超时/新请求的 abort 中断
      const backoff = rateLimitWaitMs(attempt)
      safeLogger.warn(`[ai0-plugin] Agent LLM 调用触发速率限制(第${attempt}次)，指数退避等 ${backoff / 1000}s 后重试: ${sanitizeLog(err?.message || err)}`)
      const slept = await sleepInterruptible(backoff, opts.signal)
      if (opts.signal?.aborted) return { ok: false, error: lastErr, aborted: true }
    }
  }
  return { ok: false, error: lastErr }
}

// —— 命令白名单：AI 可执行的命令（首命令必须命中，含 cd 内建） ——
const DEFAULT_ALLOWED = new Set([
  // 基本文件/目录/文本
  'ls', 'cd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'whoami', 'date',
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

// —— 引号感知 token 化，但保留引号内文本（用于解析命令的路径参数） ——
// 与 hasDangerousRm 的分词不同：这里把 'a b' / "a b" 当作一个完整参数值保留。
function tokenizeKeepQuoted(seg) {
  const tokens = []
  let cur = ''
  let i = 0
  const push = (c) => { if (c) tokens.push(c); cur = '' }
  while (i < seg.length) {
    const ch = seg[i]
    if (ch === '"' || ch === "'") {
      const q = ch
      i++
      while (i < seg.length && seg[i] !== q) { cur += seg[i]; i++ }
      i++ // 跳过闭合引号
      push(cur)
      continue
    }
    if (ch === '\\' && i + 1 < seg.length) { cur += seg[i + 1]; i += 2; continue }
    if (/\s/.test(ch)) { push(cur); i++; continue }
    cur += ch
    i++
  }
  push(cur)
  return tokens
}

// —— 文件路径参数 realpath 边界：防止经软链 / /proc 等逃逸出工作区 ——
// 白名单命令本身含 ln，且 cwd 已 realpath 锁定，但命令参数（尤其是 ln -s 的目标、
// cat/head/tail/cp/mv/rm 等的文件参数）若不校验，攻击者可「软链到 /proc/self/environ 再读取」
// 或直接 cat 工作区外的非敏感目录名单内路径（如 /proc）。这里对"文件类命令"的每个非选项参数
// 做 realpath 解析，最终必须落在 workspace 内；文件不存在时回退校验父目录 realpath。
const FILE_PATH_COMMANDS = new Set([
  'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'diff', 'cmp', 'cp', 'mv', 'rm',
  'chmod', 'touch', 'ln', 'gzip', 'gunzip', 'tar', 'unzip', 'zip', 'readlink', 'rg', 'fd',
])

function assertFileArgsInWorkspace(cmd) {
  let realRoot = null
  try { realRoot = fs.realpathSync.native(WORKSPACE) } catch (_) { return { ok: true } } // workspace 缺失不拦
  const segs = splitSegments(cmd)
  for (const seg of segs) {
    const c0 = firstCommand(seg)
    if (!FILE_PATH_COMMANDS.has(c0) && c0 !== 'curl' && c0 !== 'wget') continue
    const tokens = tokenizeKeepQuoted(seg).slice(1) // 去掉命令本身
    let i = 0
    while (i < tokens.length) {
      const tk = tokens[i]
      if (!tk) { i++; continue }
      // curl/wget 的 -o/--output/-O 后跟的路径参数也要校验（属于"非 FILE_PATH_COMMANDS 但写文件到磁盘"）
      if ((c0 === 'curl' || c0 === 'wget') && tk.startsWith('-')) {
        if (tk === '-o' || tk === '--output' || tk === '-O' || tk === '--output-document') {
          const pathTk = tk === '-O' || tk === '--output-document' ? null : tokens[i + 1]
          if (pathTk) {
            const abs = path.isAbsolute(pathTk) ? pathTk : path.resolve(WORKSPACE, pathTk)
            let real = null
            try { real = fs.realpathSync.native(abs) } catch (_) {
              try { real = fs.realpathSync.native(path.dirname(abs)) } catch (_2) { real = null }
            }
            if (real != null && real !== realRoot && !real.startsWith(realRoot + path.sep)) {
              return { ok: false, reason: `${c0} 输出路径超出工作区沙箱：${pathTk}` }
            }
          }
          i += 2; continue
        }
        i++; continue
      }
      if (FILE_PATH_COMMANDS.has(c0)) {
        if (tk.startsWith('-')) { i++; continue }
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tk)) { i++; continue } // URL，非本地路径
        const abs = path.isAbsolute(tk) ? tk : path.resolve(WORKSPACE, tk)
        let real = null
        try { real = fs.realpathSync.native(abs) } catch (_) {
          try { real = fs.realpathSync.native(path.dirname(abs)) } catch (_2) { real = null }
        }
        if (real == null) { i++; continue } // 父目录也不存在，交由上层命令自然失败，不硬拦
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          return { ok: false, reason: `参数路径超出工作区沙箱：${tk}` }
        }
      }
      i++
    }
  }
  return { ok: true }
}

// —— shell 展开逃逸防护：exec 过 shell，会展开 ~ 和裸 $VAR ——
// assertFileArgsInWorkspace 用字面 path.resolve（不展开），攻击者可用：
//   cat ~/somefile / cat $HOME/somefile  → 校验按 workspace 相对路径解析 → realpath 失败 → continue 放行 →
//   执行时 shell 展开到真实 home，读出 workspace 外任意非黑名单文件。
// 这里在 FILE_PATH 校验之前拦截任何以 ~ 或裸 $ 开头的 token（含引号内的字面文本，
// 因为 tokenizeKeepQuoted 会保留引号内容——用户输入就是字面 ~ 和 $）。
function assertNoShellExpandTokens(cmd) {
  const segs = splitSegments(cmd)
  for (const seg of segs) {
    const c0 = firstCommand(seg)
    if (!c0) continue
    const tokens = tokenizeKeepQuoted(seg)
    for (const tk of tokens) {
      if (!tk || tk === c0) continue
      if (tk.startsWith('~/') || tk === '~' || tk.startsWith('~/')) {
        return { ok: false, reason: `禁止 shell 展开的 ~ 路径（会被 exec 展开到真实 home）：${tk}` }
      }
      if (tk.startsWith('$') && !/^\$\{[^}]+\}$/.test(tk) && !/\$\{[^}]+\}/.test(tk)) {
        // 裸 $VAR（不含 ${...} 形式）：如 $HOME、$PATH 会被 shell 展开
        // ${VAR} 形式也一样危险，同样拒绝
        return { ok: false, reason: `禁止 shell 变量展开（会被 exec 展开到宿主环境）：${tk}` }
      }
      if (tk.startsWith('${')) {
        return { ok: false, reason: `禁止 shell 变量展开（会被 exec 展开到宿主环境）：${tk}` }
      }
    }
  }
  return { ok: true }
}

// —— 泛化绝对路径边界制：所有白名单命令的非选项绝对路径参数都必须落在 workspace ——
// 白名单里的 find / grep / git / rg / fd / which 等命令不在 FILE_PATH_COMMANDS，
// 原来的黑名单是名单制（只挡 /etc /root /usr ... 显式列出的系统目录），攻击者可
// 用 find /opt /proc /sys /dev /run ... 列这些没被列出来的系统目录。
// 这里泛化：所有白名单命令的非选项 token，若以 "/" 开头（纯绝对路径，排除 "-" 选项），
// 则 realpath 后必须落在 workspace 内。URL 和数字参数通过 isAbsolute + 首字符 "/" 过滤。
function assertAllAbsolutePathsInWorkspace(cmd) {
  let realRoot = null
  try { realRoot = fs.realpathSync.native(WORKSPACE) } catch (_) { return { ok: true } }
  const segs = splitSegments(cmd)
  for (const seg of segs) {
    const c0 = firstCommand(seg)
    if (!DEFAULT_ALLOWED.has(c0)) continue
    const tokens = tokenizeKeepQuoted(seg).slice(1)
    for (const tk of tokens) {
      if (!tk) continue
      if (tk.startsWith('-')) continue
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(tk)) continue // URL
      if (!path.isAbsolute(tk)) continue                  // 相对路径/标识符，放过
      let real = null
      try { real = fs.realpathSync.native(tk) } catch (_) {
        try { real = fs.realpathSync.native(path.dirname(tk)) } catch (_2) { real = null }
      }
      if (real == null) continue
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
        return { ok: false, reason: `绝对路径超出工作区沙箱（边界制校验）：${tk}` }
      }
    }
  }
  return { ok: true }
}

// —— 解释器纵深防御：即使管理员在 extraAllowedCommands 放开了 node/python/npm 等解释器，
// 也禁止用 -c / -e / -p / --eval / --print 等"内联代码求值"参数（解释器可执行任意代码、
// 读写任意文件、发起任意网络请求，天然绕过白名单/黑名单）。禁止管道把解释器输出喂给 shell。
const INTERPRETER_COMMANDS = new Set([
  'node', 'nodejs', 'python', 'python3', 'python2', 'pythonw', 'ruby', 'perl', 'php', 'lua',
  'deno', 'bun', 'npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'coffee', 'ts-node',
])
const INTERPRETER_INLINE_CODE_RE = /(?:^|[\s])-(?:c|e|p)(?![a-zA-Z])|--eval\b|--print\b|--execute\b/

function assertNoInlineInterpreterCode(cmd) {
  const segs = splitSegments(cmd)
  for (const seg of segs) {
    const c0 = firstCommand(seg)
    if (!INTERPRETER_COMMANDS.has(c0)) continue
    // 解释器出现了 → 无论是否被白名单放开，一律禁止内联代码参数
    if (INTERPRETER_INLINE_CODE_RE.test(seg)) {
      return { ok: false, reason: `解释器禁止内联代码参数（-c/-e/--eval 等）: ${c0}` }
    }
    // 解释器输出管道到 shell 也禁止（防 webshell 链）
    if (/\|\s*(?:ba|z|f|da)?sh\b/.test(seg) || /\|\s*(?:python|python3|perl|ruby|node)\b/.test(seg)) {
      return { ok: false, reason: '解释器禁止作为管道到 shell/解释器执行' }
    }
  }
  return { ok: true }
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

  // 3) 参数级绕过检测（白名单命令本身可能被参数滥用）
  // 3a) awk：阻止 system() 调用（执行任意 shell 命令）和 -f 读取外部文件
  if (/\bawk\b/.test(cmd)) {
    if (/\bsystem\s*\(/.test(cmd)) return { ok: false, reason: 'awk 禁止使用 system() 调用 shell 命令' }
    if (/(?:^|[\s;|&])awk\s+-(?:f|file)\b/.test(cmd)) return { ok: false, reason: 'awk 禁止使用 -f/-file 读取外部文件' }
  }
  // 3b) sed：阻止 /e 标志（执行替换结果为 shell 命令）
  if (/\bsed\b/.test(cmd)) {
    if (/\bsed\b[^|]*\/e\b/.test(cmd)) return { ok: false, reason: 'sed 禁止使用 /e 标志执行 shell 命令' }
  }
  // 3c) 全局：.. 路径穿越（解析后超出 workspace 的工作目录）
  if (/(?:^|\s)\.\.(?:\/|\\|$|\s)/.test(cmd)) return { ok: false, reason: '路径穿越：禁止访问工作区之外的目录（..）' }
  // 3d) 全局：进程替换 <( ) 和 >( ) — 绕过白名单执行任意命令
  if (/[<>]\(/.test(cmd)) return { ok: false, reason: '禁止进程替换 <( 和 >(' }
  // 3e) 解释器纵深防御：禁 -c/-e/--eval 内联代码与管道到 shell（对已进 extraAllowed 的解释器同样生效）
  const interpCheck = assertNoInlineInterpreterCode(cmd)
  if (!interpCheck.ok) return { ok: false, reason: interpCheck.reason }

  // 4) 引号感知拆分，逐段校验首命令白名单
  const segs = splitSegments(cmd)
  if (!segs.length) return { ok: false, reason: '无法解析命令' }
  for (const seg of segs) {
    const c0 = firstCommand(seg)
    if (!c0) return { ok: false, reason: '空命令段' }
    if (c0.includes('/')) return { ok: false, reason: `不允许路径形式命令: ${c0}` }
    if (!allowed.has(c0)) return { ok: false, reason: `命令不在白名单: ${c0}` }
  }

  // 5) 文件路径参数 realpath 边界（防软链 / /proc / .. 逃逸出工作区）
  const pathCheck = assertFileArgsInWorkspace(cmd)
  if (!pathCheck.ok) return { ok: false, reason: pathCheck.reason }

  // 5b) 泛化绝对路径边界：所有白名单命令的非选项绝对路径参数都必须落在 workspace
  // （防 find /opt、git log -- path 在工作区外、rg /proc 等名单制绕过）
  const absCheck = assertAllAbsolutePathsInWorkspace(cmd)
  if (!absCheck.ok) return { ok: false, reason: absCheck.reason }

  // 5c) shell 展开逃逸防护：exec 过 shell，拦截以 ~ 或裸 $ 开头的 token
  const expandCheck = assertNoShellExpandTokens(cmd)
  if (!expandCheck.ok) return { ok: false, reason: expandCheck.reason }

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
    '【重要】当需要执行系统命令时，你必须严格按以下格式输出，否则系统不会执行：',
    '[action:agent:这里写具体的命令]',
    '例如：[action:agent:ls -la]',
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
    // —— realpath 锁定工作目录：防止通过符号链接 / `..` 让命令逃逸出 workspace ——
    let realCwd = WORKSPACE
    try {
      const resolved = path.isAbsolute(cwd) ? cwd : path.resolve(WORKSPACE, cwd)
      realCwd = fs.realpathSync.native(resolved)
      const realRoot = fs.realpathSync.native(WORKSPACE)
      if (!(realCwd === realRoot || realCwd.startsWith(realRoot + path.sep))) {
        return resolve({ ok: false, code: -1, costMs: 0, error: `命令被安全策略拒绝：工作目录超出沙箱（${cwd}）`, detail: `工作目录 ${cwd} 解析后不在 workspace 内，拒绝` })
      }
    } catch (err) {
      return resolve({ ok: false, code: -1, costMs: 0, error: `命令被安全策略拒绝：无法校验工作目录`, detail: sanitizeLog(err?.message || err) })
    }
    const start = Date.now()

    // 使用 exec 返回的 child 以便在外部 signal.abort 时强制 kill
    let abortedBySignal = false
    const child = exec(cmd, {
      cwd: realCwd,
      timeout,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf-8'
    }, (err, stdout, stderr) => {
      // cleanup signal listener
      try { if (opts.signal) opts.signal.removeEventListener && opts.signal.removeEventListener('abort', onAbort) } catch (_) {}

      const out = String(stdout || '').trim()
      const errOut = String(stderr || '').trim()
      const errMsg = err ? String(err?.message || err) : ''
      const costMs = Date.now() - start
      const detail = [out, errOut, errMsg].filter(Boolean).join('\n')
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        timedOut: !!err?.killed || /timed out/i.test(errMsg),
        aborted: abortedBySignal,
        costMs,
        stdout: out.slice(0, MAX_OUTPUT_CHARS),
        stderr: errOut.slice(0, MAX_OUTPUT_CHARS),
        error: errMsg.slice(0, 500),
        detail: sanitizeLog(detail).slice(0, MAX_OUTPUT_CHARS)
      })
    })

    // attach abort listener to kill child process when provided signal aborts
    const onAbort = () => {
      abortedBySignal = true
      try { child.kill && child.kill('SIGKILL') } catch (_) {}
    }
    if (opts.signal) {
      try {
        if (opts.signal.aborted) {
          onAbort()
        } else if (opts.signal.addEventListener) {
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }
      } catch (_) {}
    }
  })
}

function formatResult(r) {
  if (r.aborted) return `(命令被中断)\n退出码=中止 耗时=${r.costMs}ms`
  const head = `退出码=${r.code} 耗时=${r.costMs}ms`
  if (!r.detail) return `${head}\n（无输出）`
  return `${head}\n${r.detail}`
}

/**
 * 多轮 Agent 自动循环：任务 → AI 出命令 → 执行 → 结果回传 → 继续，直到完成或达轮数上限。
 * @param {Function} [onThinking] 每轮模型返回深度思考内容时回调 (reasoning: string) => Promise|void
 * @param {Function} [callFn] 可注入的 LLM 调用函数（测试用），默认走 llm.chatCompletions
 * @param {object} [audit] 安全审计上下文 { userId?, sessionId?, groupId? }
 * @returns {{ done: boolean, finalText: string, rounds: number, logs: Array }}
 */
export async function runAgentLoop({ task, maxRounds, modelKey = null, signal = null, onThinking = null, callFn = null, audit = null } = {}) {
  initWorkspaceFiles()
  const conf = cfg.get('agent', {}) || {}
  // 严格读取配置（网页端/config.yaml 可写任意 ≥1 的值），无硬上限截断，受 API 配额与超时自然约束
  const rounds = Math.max(1, Number(maxRounds) || Number(conf.maxRounds) || DEFAULT_MAX_ROUNDS)

  // 硬超时（整次 Agent 任务最长期限），10 分钟兜底
  const AGENT_HARD_TIMEOUT_MS = Number(conf.hardTimeoutMs) || 600_000
  const ac = new AbortController()
  let timedOutByHardTimer = false
  // 若外部 signal 提前 aborted，则同步到内部 ac
  if (signal) {
    try {
      if (signal.aborted) ac.abort()
      else if (signal.addEventListener) signal.addEventListener('abort', () => { try { ac.abort() } catch (_) {} }, { once: true })
    } catch (_) {}
  }
  let hardTimer = null
  function resetHardTimer() {
    try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {}
    hardTimer = setTimeout(() => {
      timedOutByHardTimer = true
      safeLogger.warn('[ai0-plugin] Agent 硬超时触发，abort')
      try { ac.abort() } catch (_) {}
    }, AGENT_HARD_TIMEOUT_MS)
  }
  resetHardTimer()

  // 安全审计发射器：携带审计上下文，记录命令执行/拒绝/异常事件
  const emitAudit = (kind, extra = {}) => securityLog.recordSecurityEvent({ kind, ...(audit || {}), ...extra })

  const sys = [
    buildAgentContext(),
    '',
    '你的任务：',
    String(task || '').slice(0, 4000),
    '',
    '执行规则：',
    '1. 需要执行命令时，必须严格按 [action:agent:命令] 的格式输出（如 [action:agent:ls -la]），可先输出一句说明；格式不符系统不会执行。',
    '2. 观察命令结果后继续；重复上一步已成功的命令没有意义。',
    '3. 遇报错请分析原因并修正参数/路径，不要反复重试同一失败命令。',
    '4. 不需要更多命令时，直接输出最终成果总结（纯文本）。'
  ].join('\n')

  const messages = [{ role: 'system', content: sys }]
  const logs = []
  let finalText = ''

  for (let i = 0; i < rounds; i++) {
    // 硬超时只在入口登记一次，不在循环内重置
    // 整次任务的总时限由 AGENT_HARD_TIMEOUT_MS 控制

    const call = await callLlmWithRetry({ messages, opts: { modelKey, signal: ac.signal, identityKey: (audit && audit.userId) || GLOBAL_RATE_LIMIT_KEY }, callFn })
    if (!call.ok) {
      const reason = call.aborted ? '（请求已被取消/超时）'
        : isRateLimit(call.error) ? 'Agent 因 API 速率限制暂时无法继续，请稍后重试或降低 maxRounds 配置'
        : sanitizeLog(call.error?.message || call.error)
      emitAudit(call.aborted ? (timedOutByHardTimer ? 'agent_timeout' : 'agent_error') : 'agent_error', { action: 'Agent 任务中断', reason })
      finalText = `Agent 执行中断：模型调用失败 ${reason}`
      safeLogger.error(`[ai0-plugin] agent 循环模型调用失败: ${reason}`)
      try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {}
      return { done: false, finalText, rounds: i, logs }
    }
    const res = call.res
    const text = String(res?.text || '').trim()
    // 深度思考内容：回调发送方（如以聊天记录形式发到群/私聊），不阻断循环
    if (res?.reasoning && typeof onThinking === 'function') {
      try { await onThinking(String(res.reasoning).trim()) } catch (_) {}
    }
    if (!text) { finalText = '模型未产生输出，任务提前结束。'; try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {} ; return { done: false, finalText, rounds: i, logs } }

    const match = text.match(/\[action:agent:([^\]]+)\]/)
    if (!match) {
      // 无命令 → 任务完成
      finalText = text
      try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {}
      return { done: true, finalText, rounds: i + 1, logs }
    }

    const cmd = match[1].trim()
    const check = checkCommand(cmd)
    if (!check.ok) {
      logs.push({ cmd, ok: false, reason: check.reason })
      emitAudit('agent_cmd_rejected', { action: cmd, reason: check.reason })
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'system', content: `命令被安全策略拒绝：${check.reason}\n请改用允许的命令继续。` })
      continue
    }

    const r = await runCommand(cmd, { signal: ac.signal })
    logs.push({ cmd, ok: r.ok, code: r.code, timedOut: r.timedOut, aborted: r.aborted, costMs: r.costMs, output: r.detail })
    emitAudit(r.aborted ? (timedOutByHardTimer ? 'agent_timeout' : 'agent_error') : 'agent_cmd', {
      action: cmd,
      ok: r.ok && !r.aborted,
      reason: r.aborted ? (timedOutByHardTimer ? '命令执行超时' : '命令被中断') : (!r.ok ? String(r.error || r.detail || '').slice(0, 200) : undefined)
    })
    messages.push({ role: 'assistant', content: text })
    // 命令输出来自不可信的外部环境（可能反射文件内容），以 user 身份 + untrusted 边界注入，防止其内容以 system 权重劫持后续指令
    messages.push({ role: 'user', content: `<command_output>\n${formatResult(r)}\n</command_output>` })
  }

  try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {}
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
 * @param {Function} [onThinking] 每轮模型返回深度思考内容时回调 (reasoning: string) => Promise|void
 * @param {Function} [callFn] 可注入的 LLM 调用函数（测试用），默认走 llm.chatCompletions
 * @param {object} [audit] 安全审计上下文 { userId?, sessionId?, groupId? }
 * @returns {{ done, finalText, rounds, logs }}
 */
export async function continueAgentInHistory({ history, assistantText, modelKey = null, signal = null, maxRounds = null, onThinking = null, callFn = null, audit = null } = {}) {
  initWorkspaceFiles()
  const conf = cfg.get('agent', {}) || {}
  // 严格读取配置（网页端/config.yaml 可写任意 ≥1 的值），无硬上限截断，受 API 配额与超时自然约束
  const cap = Math.max(1, Number(maxRounds) || Number(conf.maxRounds) || DEFAULT_MAX_ROUNDS)
  const messages = (history || []).map(m => ({ role: m.role === 'system' ? 'system' : m.role, content: String(m.content || '') }))
  messages.push({ role: 'assistant', content: String(assistantText || '') })
  const logs = []
  let text = String(assistantText || '')
  let executed = 0

  // 安全审计发射器：携带审计上下文，记录命令执行/拒绝/异常事件
  const emitAudit = (kind, extra = {}) => securityLog.recordSecurityEvent({ kind, ...(audit || {}), ...extra })

  // 为此继续流程也设立硬超时，并且将外部 signal 与内部 ac 关联
  const AGENT_HARD_TIMEOUT_MS = Number(conf.hardTimeoutMs) || 600_000
  const ac = new AbortController()
  let timedOutByHardTimer = false
  let hardTimer = null
  function resetHardTimer() {
    try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {}
    hardTimer = setTimeout(() => {
      timedOutByHardTimer = true
      safeLogger.warn('[ai0-plugin] continueAgentInHistory 硬超时触发，abort')
      try { ac.abort() } catch (_) {}
    }, AGENT_HARD_TIMEOUT_MS)
  }
  // 若外部 signal 提前 aborted，则同步到内部 ac
  if (signal) {
    try {
      if (signal.aborted) ac.abort()
      else if (signal.addEventListener) signal.addEventListener('abort', () => ac.abort(), { once: true })
    } catch (_) {}
  }
  resetHardTimer()

  const roundTrip = async () => {
    const call = await callLlmWithRetry({ messages, opts: { modelKey, signal: ac.signal, identityKey: (audit && audit.userId) || GLOBAL_RATE_LIMIT_KEY }, callFn })
    if (!call.ok) {
      if (call.aborted || ac.signal?.aborted) return { error: { aborted: true, message: '' } }
      return { error: { rateLimit: isRateLimit(call.error), aborted: false, message: sanitizeLog(call.error?.message || call.error) } }
    }
    // 深度思考内容：回调发送方（如以聊天记录形式发到群/私聊），不阻断循环
    if (call.res?.reasoning && typeof onThinking === 'function') {
      try { await onThinking(String(call.res?.reasoning).trim()) } catch (_) {}
    }
    return { text: String(call.res?.text || '').trim(), reasoning: String(call.res?.reasoning || '').trim() }
  }

  while (executed < cap) {
    const match = text.match(/\[action:agent:([^\]]+)\]/)
    if (!match) break
    const cmd = match[1].trim()
    const check = checkCommand(cmd)
    if (!check.ok) {
      logs.push({ cmd, ok: false, reason: check.reason })
      emitAudit('agent_cmd_rejected', { action: cmd, reason: check.reason })
      messages.push({ role: 'system', content: `命令被安全策略拒绝：${check.reason}\n请改用允许的命令继续。` })
    } else {
      const r = await runCommand(cmd, { signal: ac.signal })
      logs.push({ cmd, ok: r.ok, code: r.code, costMs: r.costMs, output: r.detail, aborted: r.aborted })
      emitAudit(r.aborted ? (timedOutByHardTimer ? 'agent_timeout' : 'agent_error') : 'agent_cmd', {
        action: cmd,
        ok: r.ok && !r.aborted,
        reason: r.aborted ? (timedOutByHardTimer ? '命令执行超时' : '命令被中断') : (!r.ok ? String(r.error || r.detail || '').slice(0, 200) : undefined)
      })
      // 同上：命令输出为不可信内容，以 user 身份 + untrusted 边界注入，避免其内容以 system 权重劫持后续指令
      messages.push({ role: 'user', content: `<command_output>\n${formatResult(r)}\n</command_output>` })
    }
    executed++
    // 硬超时只在入口登记一次，不在循环内重置；整次任务的总时限由 AGENT_HARD_TIMEOUT_MS 控制
    const next = await roundTrip()
    if (next.error) {
      const reason = next.error.aborted ? '（请求已被取消/超时）'
        : next.error.rateLimit ? 'Agent 因 API 速率限制暂时无法继续，请稍后重试或降低 maxRounds 配置'
        : next.error.message || '（未知错误）'
      emitAudit(next.error.aborted ? (timedOutByHardTimer ? 'agent_timeout' : 'agent_error') : 'agent_error', { action: 'Agent 任务中断', reason })
      try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {}
      return { done: false, finalText: `Agent 执行中断：模型调用失败 ${reason}`, rounds: executed, logs }
    }
    text = next.text
    if (!text) return { done: false, finalText: '模型未产生输出，Agent 提前结束。', rounds: executed, logs }
  }

  try { if (hardTimer) clearTimeout(hardTimer) } catch (_) {}
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
