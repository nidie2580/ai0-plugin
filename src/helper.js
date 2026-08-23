import * as cfg from '../config/index.js'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isAllowedOutboundUrl, safeFetchWithRedirects } from './security.js'
import { safeLogger } from './globals.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(PLUGIN_ROOT, 'data')
const WEB_DIR = path.join(PLUGIN_ROOT, 'web')
const TMP_DIR = path.join(DATA_DIR, 'tmp-stickers')
// 允许本地图片路径访问的根目录白名单：
//   DATA_DIR：会话历史/临时文件/加密会话
//   WEB_DIR：  前端静态资源（网页内嵌图片/Logo 之类）
//   TMP_DIR：  临时图片（getImageSegment 写的主路径）
// 其他任何路径（/etc/passwd、~/.ssh/id_rsa 等）都一律拒绝。
const ALLOWED_IMAGE_ROOTS = [DATA_DIR, WEB_DIR, TMP_DIR]
try { if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true, mode: 0o700 }) } catch (_) {}
// 判断绝对路径是否落在任一允许的根目录下，防范路径穿越（`..` / 符号链接跟随用 realpath 二次校验）
function isPathWithinAllowedRoots(filePath) {
  if (!filePath || typeof filePath !== 'string') return false
  try {
    const abs = path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(PLUGIN_ROOT, filePath)
    // realpathSync.native 会跟随符号链接，防止软链接指向 /etc/passwd 这种绕过
    let real
    try { real = fs.realpathSync.native(abs) } catch (_) { real = abs }
    for (const root of ALLOWED_IMAGE_ROOTS) {
      const realRoot = path.resolve(root)
      if (real === realRoot) return true
      const sep = real.endsWith(path.sep) ? '' : path.sep
      if (real.startsWith(realRoot + sep)) return true
    }
    return false
  } catch (_) {
    return false
  }
}

// 临时文件清理：只保留近 1 小时内的，避免长期运行堆积
let _cleanupRan = 0
function cleanupTmpDir() {
  const now = Date.now()
  if (now - _cleanupRan < 10 * 60 * 1000) return  // 每 10 分钟最多跑一次
  _cleanupRan = now
  try {
    const files = fs.readdirSync(TMP_DIR)
    for (const f of files) {
      if (!f.startsWith('stk-')) continue
      const fp = path.join(TMP_DIR, f)
      try {
        const st = fs.statSync(fp)
        if (now - st.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(fp)
      } catch (_) {}
    }
  } catch (_) {}
}

function readFrameworkMasters() {
  const masters = new Set()
  try {
    // 兼容标准 Yunzai (global.Config) 和 XRK-Yunzai (globalThis.Config / global.cfg)
    const g = (typeof globalThis !== 'undefined' && globalThis.Config)
      || (typeof global !== 'undefined' && global.Config)
      || (typeof global !== 'undefined' && global.cfg)
      || null
    if (g) {
      for (const k of ['master', 'masters', 'masterQQ', 'owner']) {
        const v = g[k]
        if (!v) continue
        ;(Array.isArray(v) ? v : [v]).forEach(x => {
          if (x != null && x !== '') masters.add(String(x))
        })
      }
      if (g.matcher) {
        const m = g.matcher
        for (const k of ['master', 'masters', 'masterQQ', 'owner']) {
          const v = m[k]
          if (!v) continue
          ;(Array.isArray(v) ? v : [v]).forEach(x => {
            if (x != null && x !== '') masters.add(String(x))
          })
        }
      }
    }
  } catch (_) { /* ignore */ }
  return [...masters]
}

function readPluginMasters() {
  const v = cfg.get('permissions.masters', []) || []
  return (Array.isArray(v) ? v : [v]).map(x => String(x)).filter(Boolean)
}

export function listMasters() {
  const merged = new Set()
  for (const x of readFrameworkMasters()) merged.add(x)
  for (const x of readPluginMasters()) merged.add(x)
  return [...merged]
}

export function listMasterSources() {
  return {
    framework: readFrameworkMasters(),
    plugin: readPluginMasters()
  }
}

export function isMaster(userId, e = null) {
  if (userId == null) return false
  const uid = String(userId)

  // 1. Yunzai 框架事件对象自带字段
  if (e) {
    const em = e.isMaster ?? e.master
    if (em === true || em === 'true' || em === 1) return true
    if (em === false) {
      // 某些分支的 isMaster 默认 false，但插件里配置主人应允许，这里不提前 return false
    }
  }

  // 2. plugin 自己的配置文件（config.yaml: permissions.masters）
  if (readPluginMasters().includes(uid)) return true

  // 3. Yunzai 框架 Config（全局配置里的 master 列表）
  if (readFrameworkMasters().includes(uid)) return true

  return false
}

export function isUserAllowed(userId, groupId = null, e = null) {
  const mode = cfg.get('permissions.whitelistMode', false)
  const blockedUsers = (cfg.get('permissions.blockedUsers', []) || []).map(String)
  const allowedUsers = (cfg.get('permissions.allowedUsers', []) || []).map(String)
  const blockedGroups = (cfg.get('permissions.blockedGroups', []) || []).map(String)
  const allowedGroups = (cfg.get('permissions.allowedGroups', []) || []).map(String)

  const uid = userId != null ? String(userId) : null
  const gid = groupId != null ? String(groupId) : null

  if (uid && isMaster(uid, e)) return true

  if (uid && blockedUsers.includes(uid)) return false
  if (gid != null && blockedGroups.includes(gid)) return false

  if (mode) {
    // fail-closed: 白名单模式下空列表 = 拒绝所有（而非放行）
    const userOk = !uid ? true : (allowedUsers.length > 0 && allowedUsers.includes(uid))
    const groupOk = gid == null ? true : (allowedGroups.length > 0 && allowedGroups.includes(gid))
    return userOk && groupOk
  }

  return true
}

export function getUserId(e) {
  return e?.user_id ?? e?.sender?.user_id ?? e?.from_user ?? null
}

export function getGroupId(e) {
  return e?.group_id ?? e?.message?.group_id ?? e?.from_group ?? null
}

/**
 * 将 e.message 归一化为段数组（兼容 XRK-Yunzai 部分适配器将 e.message 作为纯字符串的情况）
 */
export function normalizeMessage(e) {
  if (Array.isArray(e.message)) return e
  if (typeof e.message === 'string') {
    e.message = [{ type: 'text', text: e.message }]
  }
  return e
}

/**
 * 获取消息文本（兼容数组和字符串两种格式）
 */
export function getMessageText(e) {
  if (!e.message) return ''
  if (typeof e.message === 'string') return e.message.trim()
  let text = ''
  for (const seg of e.message) {
    if (seg.type === 'text') text += (seg.text || '')
  }
  return text.trim()
}

export function isAtBot(e) {
  if (!e.message || !e.self_id) return false
  const selfId = String(e.self_id)
  if (typeof e.message === 'string') return false
  for (const seg of e.message) {
    if (seg.type !== 'at') continue
    const qq = String(seg.qq ?? seg.data?.qq ?? seg.user_id ?? seg.data?.user_id ?? '')
    if (qq && qq === selfId) return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/*                  消息解构 + 引用/合并转发消息的上下文提取                  */
/* -------------------------------------------------------------------------- */

function isSelfId(e, uin) {
  if (uin == null) return false
  if (e?.self_id != null && String(uin) === String(e.self_id)) return true
  try {
    const b = e?.bot ?? Bot
    if (b?.uin != null && String(uin) === String(b.uin)) return true
    if (b?.self_id != null && String(uin) === String(b.self_id)) return true
    if (b?.bot?.uin != null && String(uin) === String(b.bot.uin)) return true
  } catch (_) {}
  return false
}

function safeName(raw) {
  if (raw == null) return ''
  let s = typeof raw === 'string' ? raw : String(raw)
  s = s.replace(/[\r\n\t]+/g, ' ').trim()
  if (s.length > 24) s = s.slice(0, 24)
  return s
}

/**
 * 从单个消息段/消息数组中抽取纯文本：兼容 YZ Message / segment 数组 / 字符串 / node.content
 */
function extractTextFromMessage(msg) {
  if (msg == null) return ''
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) {
    let text = ''
    for (const seg of msg) {
      if (!seg || typeof seg !== 'object') continue
      const type = seg.type ?? seg.msg_type ?? seg.post_type
      if (type === 'text') {
        text += (seg.text ?? seg.data?.text ?? seg.content ?? '')
      } else if (type === 'face') {
        const id = seg.id ?? seg.face ?? seg.data?.id ?? ''
        text += id ? `[表情:${id}]` : '[表情]'
      } else if (type === 'image') {
        const url = seg.url ?? seg.file ?? seg.data?.url ?? seg.data?.file ?? ''
        text += url ? `[图片:${url}]` : '[图片]'
      } else if (type === 'record' || type === 'voice') {
        text += '[语音]'
      } else if (type === 'video') {
        text += '[视频]'
      } else if (type === 'file') {
        text += '[文件]'
      } else if (type === 'reply' || type === 'quote' || type === 'reference' || type === 'source') {
        // 引用段本身只在"提取引用消息"阶段解析，正文不直接追加
        continue
      } else if (type === 'forward' || type === 'node' || type === 'longmsg') {
        text += '[合并转发聊天记录]'
      } else if (type === 'at') {
        const qq = seg.qq ?? seg.data?.qq ?? ''
        text += qq ? `[@${qq}]` : `[@某人]`
      } else if (seg.text && typeof seg.text === 'string') {
        text += seg.text
      } else if (seg.content && typeof seg.content === 'string') {
        text += seg.content
      }
    }
    return text.trim()
  }
  if (typeof msg === 'object') {
    if (typeof msg.content === 'string') return msg.content.trim()
    if (Array.isArray(msg.content)) return extractTextFromMessage(msg.content)
    if (Array.isArray(msg.message)) return extractTextFromMessage(msg.message)
  }
  try {
    return String(msg).trim()
  } catch (_) {
    return ''
  }
}

/**
 * 从一个"消息节点"(node / forward 消息数组里的每条 / 引用原消息对象)里抽取发件人+文本
 */
function normalizeOneNode(node, selfIdTester) {
  if (!node || typeof node !== 'object') return null
  // 常见字段：
  // YZ 引用源 e.source.message / forward 节点: { user_id, nickname, card, message }
  // OneBot reply 段：{ type:'reply', id:'...', data:{...}, ... } 此时真正的 sender/user_id 要取顶层 user_id/nickname（如果有的话）
  // 或 OneBot: { uin, name, content }
  // 或 MCQQ/ICQQ: { sender: {user_id,nickname,card}, message }
  // 兼容：node.user_id 没取到但 node.data 里有 user_id/nickname 也能拿到（reply/quote 段常把原信息塞到 data）
  const data = node.data && typeof node.data === 'object' ? node.data : null
  const uin =
    node.user_id ??
    node.uin ??
    data?.user_id ??
    data?.uin ??
    data?.sender_id ??
    data?.from_uin ??
    node.senderId ??
    node.from_uin ??
    node.from_user ??
    node.sender?.user_id ??
    node.author?.user_id ??
    null
  const name = safeName(
    node.nickname ??
      node.card ??
      node.name ??
      data?.nickname ??
      data?.card ??
      data?.name ??
      node.sender?.nickname ??
      node.sender?.card ??
      data?.sender?.nickname ??
      data?.sender?.card ??
      node.author?.nickname ??
      node.senderName ??
      (uin != null ? `QQ${uin}` : '')
  )
  // rawMsg 取法：message / content / data.message / data.content，兼容 {type:'reply', message: [...]} 与 {type:'reply', data:{message:[...]}}
  let rawMsg =
    node.message ??
    node.content ??
    data?.content ??
    data?.message ??
    null
  if (typeof node.message === 'function') {
    try { rawMsg = node.message() ?? rawMsg } catch (_) {}
  }
  if (rawMsg == null && data && typeof data.content === 'function') {
    try { rawMsg = data.content() } catch (_) {}
  }
  const text = extractTextFromMessage(rawMsg)
  if (!text) return null
  const isBot = selfIdTester(uin)
  return {
    user_id: uin != null ? String(uin) : null,
    name: name || (uin != null ? `QQ${uin}` : ''),
    text,
    isBot: !!isBot
  }
}

/**
 * 递归把"合并转发聊天记录"节点数组拆成平铺的对话序列
 */
function flattenForwardNodes(forwardPayload, selfIdTester, depth = 0) {
  const out = []
  if (depth > 3) return out
  if (!forwardPayload) return out
  let nodes = null
  if (Array.isArray(forwardPayload)) nodes = forwardPayload
  else if (typeof forwardPayload === 'object') {
    nodes =
      forwardPayload.nodes ??
      forwardPayload.messages ??
      forwardPayload.message ??
      forwardPayload.content ??
      null
    if (!Array.isArray(nodes) && Array.isArray(forwardPayload.data)) nodes = forwardPayload.data
    if (!Array.isArray(nodes) && Array.isArray(forwardPayload.node)) nodes = forwardPayload.node
  }
  if (!Array.isArray(nodes)) return out
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    // 节点本身可能再包一层 forward / longmsg
    const nestedFwd =
      n.forward ??
      n.content?.forward ??
      (Array.isArray(n.content) && n.content.find(s => s?.type === 'forward'))?.data ??
      n.data?.nodes ??
      null
    if (nestedFwd) {
      out.push(...flattenForwardNodes(nestedFwd, selfIdTester, depth + 1))
    }
    const one = normalizeOneNode(n, selfIdTester)
    if (one) out.push(one)
  }
  return out
}

/**
 * 从事件 e 里提取：
 *  1) 当前发送者的文本消息（剥离 reply/quote/at 等对大模型干扰的段）
 *  2) 被引用消息（reply/quote/reference/source），展开成一条 {name,isBot,text}
 *  3) 当前消息内或引用消息内如果包含 "合并转发聊天记录" 节点，递归平铺成对话序列
 *
 * 返回结构：
 * {
 *   current: { user_id, name, text, isBot },
 *   quote:   null | { user_id, name, text, isBot },
 *   forwardFromQuote: [{user_id,name,text,isBot}],   // 来自被引用消息里的合并转发
 *   forwardFromCurrent: [{user_id,name,text,isBot}], // 来自当前消息里的合并转发
 * }
 */
export function parseMessageWithContext(e) {
  const current = {
    user_id: null,
    name: '',
    text: '',
    isBot: false
  }

  const selfIdTester = uin => isSelfId(e, uin)

  // 当前消息发送者
  const uid = e?.user_id ?? e?.sender?.user_id ?? e?.from_user ?? null
  current.user_id = uid != null ? String(uid) : null
  current.name = safeName(
    e?.sender?.nickname ??
      e?.sender?.card ??
      e?.nickname ??
      e?.card ??
      e?.fromNickname ??
      (current.user_id ? `QQ${current.user_id}` : '')
  )
  current.isBot = selfIdTester(uid)

  let quote = null
  let forwardFromQuote = []
  let forwardFromCurrent = []

  const msgArr = Array.isArray(e?.message) ? e.message : []

  // 先抓 reply / quote / reference / source 段（OneBot/Yunzai 通用）
  let quoteSeg = null
  for (const seg of msgArr) {
    if (!seg || typeof seg !== 'object') continue
    const t = seg.type ?? seg.msg_type ?? seg.post_type
    if (t === 'reply' || t === 'quote' || t === 'reference') {
      quoteSeg = seg
      break
    }
    if (t === 'source' && (seg.data || seg.message || seg.content)) {
      quoteSeg = seg
      break
    }
  }

  // 部分适配器把引用源写到事件顶层：e.quote / e.reply_message / e.reference / e.source
  const topQuote =
    e?.quote ??
    e?.replyMessage ??
    e?.reply_message ??
    e?.reference ??
    e?.source ??
    e?.quoted ??
    e?.raw_message_ref ??
    null

  // 解析引用消息 + 引用消息里可能存在的合并转发
  const quoteCandidates = []
  if (quoteSeg) quoteCandidates.push(quoteSeg)
  if (topQuote && (!quoteSeg || topQuote !== quoteSeg)) quoteCandidates.push(topQuote)

  const seenQuoteSignatures = new Set()
  for (const q of quoteCandidates) {
    const mergedQuote = normalizeOneNode(q, selfIdTester)
    if (mergedQuote) {
      const sig = `${mergedQuote.user_id}|${mergedQuote.text.slice(0, 120)}`
      if (!seenQuoteSignatures.has(sig)) {
        seenQuoteSignatures.add(sig)
        if (!quote) quote = mergedQuote
      }
    }
    // 引用消息对象自身的 message/content 里可能是 forward 段数组（QQ 的"引用某条转发记录"）
    const rawMsg = q?.message ?? q?.content ?? q?.data?.message ?? q?.data?.content
    const forwardPayload =
      q?.forward ??
      q?.nodes ??
      (rawMsg && typeof rawMsg === 'object' && !Array.isArray(rawMsg)
        ? rawMsg.forward ?? rawMsg.nodes ?? null
        : null) ??
      (Array.isArray(rawMsg) ? rawMsg.find(s => s?.type === 'forward')?.data ?? null : null) ??
      null
    if (forwardPayload) {
      forwardFromQuote.push(...flattenForwardNodes(forwardPayload, selfIdTester))
    }
    if (Array.isArray(rawMsg) && rawMsg.some(s => s?.type === 'forward' || s?.type === 'node')) {
      const inlineNodes = rawMsg.filter(s => s?.type === 'forward' || s?.type === 'node')
      for (const n of inlineNodes) {
        const pl = n?.data?.nodes ?? n?.data?.content ?? n?.nodes ?? n?.content ?? n
        forwardFromQuote.push(...flattenForwardNodes(pl, selfIdTester))
      }
    }
  }

  // 当前消息正文中的合并转发：如果当前消息里有 [forward/longmsg/node] 段，递归平铺
  for (const seg of msgArr) {
    if (!seg || typeof seg !== 'object') continue
    const t = seg.type ?? seg.msg_type ?? seg.post_type
    if (t === 'forward' || t === 'longmsg') {
      const pl = seg?.data?.nodes ?? seg?.nodes ?? seg?.data?.content ?? seg?.content ?? seg?.data
      forwardFromCurrent.push(...flattenForwardNodes(pl, selfIdTester))
    } else if (t === 'node' && Array.isArray(seg?.data?.nodes)) {
      forwardFromCurrent.push(...flattenForwardNodes(seg.data, selfIdTester))
    }
  }

  // 当前消息纯文本（去除 @bot / 回复段 等干扰，保留表情/图片占位）
  const currentText = extractTextFromMessage(msgArr)
  current.text = currentText

  return {
    current,
    quote,
    forwardFromQuote,
    forwardFromCurrent
  }
}

/**
 * 给"发件人+文本"打标，生成适合喂给 LLM 的字符串（可配置开关 includeSenderTag）
 */
export function formatTurnForPrompt({ name, text, isBot, tagBotAs = 'AI', tagUserAs = '用户' }) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const who =
    (name ? name : (isBot ? tagBotAs : tagUserAs)) +
    (isBot ? `（${tagBotAs}）` : '')
  return `【${who}】：\n${t}`
}

export async function replyForward(e, text) {
  if (!e.group_id) return e.reply(text)
  try {
    const bot = e.bot ?? Bot
    const msg = typeof text === 'string'
      ? [{ type: 'text', text }]
      : text
    if (typeof e.bot?.makeForwardMsg === 'function') {
      const nodes = [
        {
          user_id: e.self_id || 0,
          nickname: 'AI',
          message: msg
        }
      ]
      const forwardMsg = await bot.makeForwardMsg(nodes)
      return e.reply(forwardMsg)
    }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 转发消息失败，降级为普通回复: ${err.message}`)
  }
  return e.reply(text)
}

/**
 * Unicode 安全分段：
 *  - 不会截断 UTF-16 surrogate pair（避免单个 emoji 被切成两半，进而发送失败/乱码）
 *  - 优先在换行、句号、感叹号、问号、逗号、分号、反引号闭合位置切，不硬截断单词中间
 *  - Markdown 边界：尽量不在代码块 ```、表格 |、链接 []()、**粗体**、*斜体*、~~删除线~~ 的中间切
 *    （只做轻量启发式：若当前分段内存在未闭合的 ```/`，就尽量往后多找点，直到闭合或达到上限）
 */
export function splitUnicodeSafe(text, targetChunk = 3000, options = {}) {
  if (!text) return []
  const maxChunk = options.maxChunk || Math.max(targetChunk * 2, 6000)
  const out = []
  let i = 0
  const len = text.length

  // 取一个不切断 UTF-16 surrogate 的边界索引
  function safeEnd(limit) {
    if (limit >= len) return len
    // 如果当前字符是 low surrogate（位于 U+DC00..U+DFFF），就往前退一格（把前面的 high 也包含进来）
    const code = text.charCodeAt(limit)
    if (code >= 0xDC00 && code <= 0xDFFF && limit > 0) {
      return limit - 1
    }
    // 如果下一个字符是 low surrogate，我们这里是 high surrogate → 退回到这一对之前
    const nextCode = limit + 1 < len ? text.charCodeAt(limit + 1) : 0
    if (nextCode >= 0xDC00 && nextCode <= 0xDFFF && limit > 0) return limit - 1
    return limit
  }

  while (i < len) {
    let end = Math.min(i + targetChunk, len)
    end = safeEnd(end)

    // 启发式：如果当前块内的 ``` 计数为奇数（代码块未闭合） → 尽量延后到下一个 ```
    if (end < len) {
      let chunk = text.slice(i, end)
      const countCodeFence = (chunk.match(/```/g) || []).length
      if (countCodeFence % 2 === 1) {
        const nextFence = text.indexOf('```', end)
        if (nextFence !== -1 && nextFence < i + maxChunk) {
          end = safeEnd(Math.min(nextFence + 3, i + maxChunk))
          chunk = text.slice(i, end)
        }
      }
      // 反引号 ` 未闭合 → 延后到下一个 `
      const countBacktick = (chunk.match(/`/g) || []).length
      if (countBacktick % 2 === 1) {
        const nextBack = text.indexOf('`', end)
        if (nextBack !== -1 && nextBack < i + maxChunk) {
          end = safeEnd(Math.min(nextBack + 1, i + maxChunk))
          chunk = text.slice(i, end)
        }
      }
      // Markdown 粗体 / 斜体 ** / * 的配对（只做浅层）
      const unbalanced = (s) => {
        let a = 0, b = 0
        for (let p = 0; p < s.length - 1; p++) {
          if (s[p] === '*' && s[p + 1] === '*') { a++; p++ }
          else if (s[p] === '*') b++
        }
        return (a % 2 === 1) || (b % 2 === 1)
      }
      if (unbalanced(chunk)) {
        // 尝试找下一个换行，通常那里会闭合
        const nextNl = text.indexOf('\n', end)
        if (nextNl !== -1 && nextNl < i + maxChunk) {
          end = safeEnd(Math.min(nextNl + 1, i + maxChunk))
        }
      }
    }

    // 如果没有明显的 Markdown 边界问题 → 在 end 之前找最近的「自然断点」
    if (end < len) {
      const searchFrom = Math.max(i, end - Math.min(400, Math.floor(targetChunk / 3)))
      const snippet = text.slice(searchFrom, end)
      // 优先级：段落换行 > 换行 > 句末标点 > 逗号 > 空格
      const patterns = [
        /\n\n+(?!\s*$)/g,     // 段落换行
        /\n(?!\s*$)/g,         // 普通换行
        /([。！？!?.;；])/g,    // 句末标点（中英通用）
        /([，,、:：—…])/g,     // 短语边界
        /([\s　])/g            // 空格（含全角）
      ]
      let bestCut = -1
      for (const pat of patterns) {
        let m
        let last = -1
        pat.lastIndex = 0
        while ((m = pat.exec(snippet)) !== null) {
          last = m.index + m[0].length
        }
        if (last >= 0) {
          bestCut = searchFrom + last
          break
        }
      }
      if (bestCut > i && bestCut <= end) {
        end = safeEnd(bestCut)
      }
    }

    // 硬上限兜底：自然断点再想找也不能超过 maxChunk
    if (end > i + maxChunk) end = safeEnd(i + maxChunk)
    if (end <= i) {
      // 极端情况至少前进 1 个码点，防止死循环；若落到低代理则补齐一对，保证不切开代理对
      end = i + 1
      if (end < len) {
        const c = text.charCodeAt(end)
        if (c >= 0xDC00 && c <= 0xDFFF) end++
      }
      if (end > len) end = len
    }

    out.push(text.slice(i, end))
    i = end
  }
  return out
}

export async function replyText(e, text, options = {}) {
  const threshold = cfg.get('response.forwardThreshold', 500)
  const useForward = cfg.get('response.useForwardMsg', true)

  // 字符串超长时走分段 + 合并转发（单条 QQ 消息有字数/字节上限，不分段会被服务器直接丢弃或乱码）
  if (typeof text === 'string' && text.length > threshold) {
    const chunks = splitUnicodeSafe(text, /* targetChunk */ 3000, { maxChunk: 5200 })
    if (chunks.length <= 1) {
      if (useForward) return replyForward(e, chunks[0])
      return e.reply(chunks[0], false, options)
    }
    // 分段后：优先把所有段用同一个合并转发发出去（减少消息数）
    if (useForward && e.group_id && typeof (e.bot ?? Bot)?.makeForwardMsg === 'function') {
      try {
        const nodes = chunks.map((chunk, idx) => ({
          user_id: e.self_id || 0,
          nickname: idx === 0 ? 'AI（续）' : 'AI（续' + (idx + 1) + '/' + chunks.length + '）',
          message: [{ type: 'text', text: chunk }]
        }))
        const fwd = await (e.bot ?? Bot).makeForwardMsg(nodes)
        return e.reply(fwd)
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] 长文本合并转发失败，降级逐条回复: ${err.message}`)
      }
    }
    // 合并转发不可用 → 逐条分段发（每段仍做 Unicode 安全）
    for (let i = 0; i < chunks.length; i++) {
      try {
        if (i === chunks.length - 1) {
          await e.reply(chunks[i], false, options)
        } else {
          await e.reply(chunks[i])
          // 多条之间稍作停顿，避免某些适配器因为消息太近丢消息
          await new Promise(r => setTimeout(r, 220))
        }
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] 分段发送第 ${i + 1}/${chunks.length} 段失败: ${err.message}`)
      }
    }
    return true
  }
  return e.reply(text, false, options)
}

/**
 * 检查「发送者 userId 是否是机器人好友 / 是否可以主动发私信」。
 *  注意：QQ/NT 协议体系里，"是不是好友" 和 "能不能主动发临时会话" 是两回事。
 *  我们这里取最实用的语义：只要能成功调用 sendMsg/sendPrivateMsg 就当「ok」，
 *  真正的「好友关系」再用 pickFriend/isFriend/getFriendMap 兜底判断。
 */
export async function isBotFriend(userId) {
  if (!userId) return { ok: false, reason: '未提供 userId' }
  const uid = String(userId)
  const bot = global.Bot || global.bot
  if (!bot) return { ok: false, reason: 'Bot 对象未就绪' }

  // 1. 显式的好友检查 API（如果有）
  try {
    if (typeof bot.isFriend === 'function') {
      const v = await bot.isFriend(uid).catch(() => null)
      if (v === true) return { ok: true, kind: 'friend', api: 'bot.isFriend' }
      if (v === false) return { ok: false, reason: '该用户不是机器人好友', api: 'bot.isFriend' }
    }
    if (typeof bot.pickFriend === 'function') {
      const friend = bot.pickFriend(uid)
      if (friend && typeof friend.getInfo === 'function') {
        try {
          const info = await friend.getInfo()
          if (info && (info.user_id || info.uin || info.qq)) return { ok: true, kind: 'friend', api: 'bot.pickFriend.getInfo' }
        } catch (_) {}
      }
    }
    if (typeof bot.getFriendMap === 'function') {
      try {
        const map = await Promise.resolve(bot.getFriendMap()).catch(() => null)
        if (map) {
          let found = false
          if (map.get instanceof Function) {
            found = !!(map.get(uid) || map.get(Number(uid)) || map.get(BigInt(uid).toString()))
          } else if (typeof map === 'object') {
            found = !!map[uid] || !!map[Number(uid)]
          }
          // 再兜底遍历值，防止 uin/user_id 类型不匹配
          if (!found && typeof map.values === 'function') {
            for (const v of map.values()) {
              const u = String(v?.uin ?? v?.user_id ?? v?.qq ?? v?.userId ?? '')
              if (u && u === uid) { found = true; break }
            }
          }
          if (found) return { ok: true, kind: 'friend', api: 'bot.getFriendMap' }
        }
      } catch (_) {}
    }
    if (typeof bot.getFriendList === 'function') {
      try {
        const list = await bot.getFriendList().catch(() => null)
        if (Array.isArray(list)) {
          const found = list.some(v => String(v?.uin ?? v?.user_id ?? v?.qq ?? v?.userId ?? '') === uid)
          if (found) return { ok: true, kind: 'friend', api: 'bot.getFriendList' }
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 2. 能主动发私信 → 也视为「ok」（有的实现好友/临时会话都能发）
  try {
    if (typeof bot.pickUser === 'function') {
      const user = bot.pickUser(uid)
      if (user && (typeof user.sendMsg === 'function' || typeof user.sendPrivateMsg === 'function' || typeof user.sendMessage === 'function')) {
        return { ok: true, kind: 'dm-capable', api: 'bot.pickUser' }
      }
    }
    if (typeof bot.sendPrivateMsg === 'function') {
      return { ok: true, kind: 'dm-capable', api: 'bot.sendPrivateMsg' }
    }
  } catch (_) {}

  return {
    ok: false,
    reason: '未查询到好友关系，且主动私信接口也不可用（请先添加机器人为好友或启用临时会话）',
  }
}

/**
 * 主动给用户发私信（不依赖当前事件对象）。
 *  兼容 bot.sendPrivateMsg / bot.pickUser().sendMsg / bot.pickFriend().sendMsg
 */
export async function sendPrivate(userId, content) {
  if (!userId) return { ok: false, reason: '未提供 userId' }
  const uid = String(userId)
  const bot = global.Bot || global.bot
  if (!bot) return { ok: false, reason: 'Bot 对象未就绪' }

  const asMsg = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c)

  const attempts = [
    // 1) bot.sendPrivateMsg（ICQQ/ NapCat / Lagrange 通用）
    async () => {
      if (typeof bot.sendPrivateMsg !== 'function') return null
      const r = await bot.sendPrivateMsg(uid, asMsg(content)).catch(err => ({ error: err }))
      if (r && !r.error) return { ok: true, via: 'bot.sendPrivateMsg', result: r }
      if (r && r.error) throw r.error
      return r == null ? null : { ok: true, via: 'bot.sendPrivateMsg', result: r }
    },
    // 2) bot.pickUser(uid).sendMsg / sendPrivateMsg
    async () => {
      if (typeof bot.pickUser !== 'function') return null
      const u = bot.pickUser(uid)
      if (!u) return null
      for (const m of ['sendMsg', 'sendPrivateMsg', 'sendMessage']) {
        if (typeof u[m] !== 'function') continue
        const r = await u[m](asMsg(content)).catch(err => ({ error: err }))
        if (r && !r.error) return { ok: true, via: `pickUser.${m}`, result: r }
        if (r && r.error) throw r.error
      }
      return null
    },
    // 3) bot.pickFriend(uid).sendMsg
    async () => {
      if (typeof bot.pickFriend !== 'function') return null
      const u = bot.pickFriend(uid)
      if (!u) return null
      for (const m of ['sendMsg', 'sendPrivateMsg', 'sendMessage']) {
        if (typeof u[m] !== 'function') continue
        const r = await u[m](asMsg(content)).catch(err => ({ error: err }))
        if (r && !r.error) return { ok: true, via: `pickFriend.${m}`, result: r }
        if (r && r.error) throw r.error
      }
      return null
    },
  ]

  let lastErr = null
  for (const fn of attempts) {
    try {
      const r = await fn()
      if (r && r.ok) return r
    } catch (err) { lastErr = err }
  }
  return { ok: false, reason: lastErr ? lastErr.message : '所有主动私信接口均调用失败' }
}

/* -------------------------------------------------------------------------- */
/*                              仅艾特默认回复相关                            */
/* -------------------------------------------------------------------------- */

/**
 * 把一个「图片来源」（本地路径 / http(s) URL / Buffer / base64 dataURL）
 * 转成 Yunzai/NapCat 能稳定发送的 segment.image（统一通过"本地临时文件路径"发送，
 * 避免直接发 Buffer/URL 导致的 rich media transfer failed）。
 *
 * @param {string|Buffer} src - 图片来源
 * @returns {Promise<segment|null>} 失败返回 null（caller 应静默降级）
 */
export async function getImageSegment(src) {
  if (src == null) return null
  cleanupTmpDir()

  try {
    // 1) Buffer → 写临时文件
    if (Buffer.isBuffer(src)) {
      const ext = guessExtFromBuffer(src) || '.img'
      const tmp = path.join(TMP_DIR, `stk-${Date.now()}-${rand6()}${ext}`)
      fs.writeFileSync(tmp, src)
      return safeSegmentImage(tmp)
    }

    if (typeof src !== 'string') return null
    const s = src.trim()
    if (!s) return null

    // 2) data:URL (base64)
    if (/^data:image\//i.test(s)) {
      const m = s.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/i)
      if (!m) return null
      const ext = m[1] ? '.' + (m[1].split('+')[0].replace('jpeg', 'jpg')) : '.img'
      const buf = Buffer.from(m[2], 'base64')
      if (buf.length > 20 * 1024 * 1024) {
        safeLogger.warn(`[ai0-plugin] data:URL 图片过大(${Math.round(buf.length / 1024 / 1024)}MB)，已拒绝`)
        return null
      }
      const tmp = path.join(TMP_DIR, `stk-${Date.now()}-${rand6()}${ext}`)
      fs.writeFileSync(tmp, buf)
      return safeSegmentImage(tmp)
    }

    // 3) http(s) URL → 下载 → 写临时文件
    if (/^https?:\/\//i.test(s)) {
      const dl = await downloadImageViaFetch(s)
      if (!dl.ok) {
        safeLogger.warn(`[ai0-plugin] 默认回复图片下载失败(${s.slice(0,80)}): ${dl.error}`)
        return null
      }
      const urlPath = safeUrlPathname(s) || ''
      const extFromUrl = urlPath ? path.extname(urlPath) : ''
      const ext = extFromUrl || guessExtFromBuffer(dl.buffer) || '.img'
      const tmp = path.join(TMP_DIR, `stk-${Date.now()}-${rand6()}${ext}`)
      fs.writeFileSync(tmp, dl.buffer)
      return safeSegmentImage(tmp)
    }

    // 4) 本地文件路径 → 仅允许落在 DATA_DIR / WEB_DIR / TMP_DIR 内（P3-6）
    //    realpath 跟随符号链接后再比对根目录，防止把指向 /etc/passwd 的 symlink 当成"允许的"图片读回来
    try {
      if (!isPathWithinAllowedRoots(s)) {
        safeLogger.warn(`[ai0-plugin] 本地图片路径超出允许根目录，已跳过: ${s.slice(0, 120)}`)
        return null
      }
      if (fs.existsSync(s) && fs.statSync(s).isFile()) {
        return safeSegmentImage(s)
      }
    } catch (_) {}

    safeLogger.warn(`[ai0-plugin] 无法识别的图片来源，已跳过: ${s.slice(0, 80)}`)
    return null
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] getImageSegment 异常: ${err.message}`)
    return null
  }
}

export function safeSegmentImage(filePath) {
  // segment 是 Yunzai 全局对象；某些适配器也支持 segment.image('file:///abs/path')
  try {
    if (typeof segment !== 'undefined' && segment && typeof segment.image === 'function') {
      return segment.image(filePath)
    }
  } catch (_) {}
  // 兜底：手动组装 segment 数组对象
  return { type: 'image', file: filePath }
}

function rand6() {
  return crypto.randomBytes(3).toString('hex')
}

function safeUrlPathname(u) {
  try { return new URL(u).pathname || '' } catch (_) { return '' }
}

/** 根据 Buffer 的 magic number 判断扩展名（尽量猜，猜不到就 null） */
function guessExtFromBuffer(buf) {
  if (!buf || buf.length < 4) return null
  const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3]
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return '.png'
  if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return '.jpg'
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) return '.gif'
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
    // RIFF → 接下来 4 字节是 size, 再接下来 4 字节应该是 WEBP
    if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp'
  }
  if (b0 === 0x42 && b1 === 0x4D) return '.bmp'
  return null
}

async function downloadImageViaFetch(url, maxBytes = 20 * 1024 * 1024) {
  const result = await safeFetchWithRedirects(url, { signal: AbortSignal.timeout(30000) })
  if (!result.ok) return { ok: false, error: result.error }
  // axios 响应：resp.data 已经是 Buffer/ArrayBuffer
  const resp = result.response
  const buf = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data)
  if (buf.length > maxBytes) return { ok: false, error: `图片过大(>${Math.round(maxBytes / 1024 / 1024)}MB)已拒绝` }
  return { ok: true, buffer: buf }
}

/** 流式读取响应体并限制总大小（兼容 fetch Response 和 axios Response）
 *  提取为公共函数：imageGen.js 与 helper.js 共用，避免重复实现。
 *  @param {{data?: *, headers: object|Headers, body?: {getReader?:Function}, arrayBuffer?:Function}} resp - fetch 或 axios 风格的响应对象
 *  @param {number} maxBytes - 允许的最大字节数
 *  @param {string} [errorPrefix='下载图片失败: '] - 错误消息前缀（便于不同调用场景定制）
 */
export async function readBody(resp, maxBytes, errorPrefix = '下载图片失败: ') {
  // axios Response: headers 是普通对象，data 已是 Buffer/ArrayBuffer
  if (resp.data !== undefined) {
    const buf = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data)
    if (buf.length > maxBytes) return { ok: false, error: `${errorPrefix}图片过大(>${Math.round(maxBytes / 1024 / 1024)}MB)已拒绝` }
    return { ok: true, buffer: buf }
  }
  // fetch Response: headers.get() + body.getReader()
  const declared = Number(resp.headers.get?.('content-length') || resp.headers['content-length'] || 0)
  if (declared > maxBytes) return { ok: false, error: `${errorPrefix}图片过大(${Math.round(declared / 1024 / 1024)}MB)已拒绝` }
  let buf
  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, error: `${errorPrefix}图片过大(>${Math.round(maxBytes / 1024 / 1024)}MB)已拒绝` }
      }
      chunks.push(value)
    }
    buf = Buffer.concat(chunks)
  } else {
    buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > maxBytes) return { ok: false, error: `${errorPrefix}图片过大已拒绝` }
  }
  if (!buf || buf.length < 16) return { ok: false, error: `${errorPrefix}图片为空或过小` }
  return { ok: true, buffer: buf }
}

/**
 * API Base URL 归一化：去 query/hash、裁剪误写的端点路径、自动补 /v1
 * llm.js 和 imageGen.js 共用此函数，避免重复实现
 */
export function normalizeApiBase(rawBase) {
  // 签名统一为单参数：所有调用方（llm.js / imageGen.js / commands.js）均不传 provider，
  // 函数行为不依赖 provider，避免签名不一致误导后续维护者
  if (!rawBase || typeof rawBase !== 'string') return ''
  let base = rawBase.trim()
  if (!base) return ''

  try {
    const u = new URL(base)
    u.search = ''
    u.hash = ''
    base = u.toString()
  } catch (_) {
    base = base.split('?')[0].split('#')[0]
  }

  const re = /(.*?)\/?v(\d+(?:[\.-]\w+)*)?\/?(images\/generations|chat\/completions|models|embeddings)?\/?$/i
  const m = base.match(re)
  if (m && m[3]) {
    const host = m[1]
    const ver = m[2] ? `/v${m[2]}` : ''
    base = host + ver
  }

  base = base.replace(/\/+$/, '')

  try {
    const pu = new URL(base)
    const pathPart = pu.pathname || '/'
    const hasVersionOrCustom = /\/v\d/i.test(pathPart) || pathPart.replace(/\/+$/, '').length > 1
    if (!hasVersionOrCustom) {
      base = base + '/v1'
    }
  } catch (_) {}

  return base
}
