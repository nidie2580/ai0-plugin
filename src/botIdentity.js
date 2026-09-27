/**
 * 机器人自身身份解析（多适配器 / 多账号）
 *
 * 背景：同一插件实例可能通过多个协议适配器连接多个 QQ 账号（例如 NapCat 的 111、
 * SnowLuma 的 222/333/444）。此时不能再用全局 Bot 判断"我是谁"，否则注入给模型的
 * 身份会指到别的账号。本模块统一按"事件级"解析当前账号身份：
 *   1) 优先取事件 e 上的 adapter/self_id（每轮准确）；
 *   2) 全局 Bot 仅作为兜底；
 *   3) 身份文案由 config 的 bot.accounts / bot.self_name 决定。
 *
 * 注意：本模块只负责"身份"，不负责会话隔离。上下文仍按 (用户, 群) 共用。
 */
import * as cfg from '../config/index.js'

/** 从事件里稳健提取适配器标识（不同适配器字段命名不一，逐级兜底） */
export function normalizeBotAccount(e) {
  let adapter = ''
  try {
    adapter = String(
      e?.adapter ||
      e?.adapter_name ||
      e?.adapterName ||
      e?.bot?.adapter ||
      e?.bot?.adapterName ||
      e?.bot?.name ||
      e?.bot?.config?.adapter ||
      ''
    ).trim()
  } catch (_) { adapter = '' }
  if (!adapter) adapter = 'unknown'

  let selfId = ''
  try {
    selfId = String(
      e?.self_id ??
      e?.bot?.uin ??
      e?.bot?.self_id ??
      e?.bot?.account?.uin ??
      ''
    ).trim()
  } catch (_) { selfId = '' }

  return { adapter, selfId, key: `${adapter}_${selfId}` }
}

function getAccountsMap() {
  const m = cfg.get('bot.accounts', {}) || {}
  return m && typeof m === 'object' ? m : {}
}

/**
 * 解析当前事件所用账号的身份配置。
 * 命中顺序：`accounts[adapter_selfId]` → `accounts[selfId]` → bot.self_name/self_persona → 默认。
 */
export function resolveBotIdentity(e) {
  const { adapter, selfId, key } = normalizeBotAccount(e)
  const accounts = getAccountsMap()
  const byKey = accounts[key] && typeof accounts[key] === 'object' ? accounts[key] : null
  const byId = selfId && accounts[selfId] && typeof accounts[selfId] === 'object' ? accounts[selfId] : null
  const conf = byKey || byId || {}
  const name = String(conf.name || cfg.get('bot.self_name', '') || 'AI助手')
  const persona = String(conf.persona || cfg.get('bot.self_persona', '') || '')
  return { name, persona, adapter, selfId, key, matched: !!(byKey || byId) }
}

/**
 * 列出属于本插件的所有自身账号（self_id）：
 *   - 显式配置 bot.selfIds；
 *   - bot.accounts 的 key（`adapter_selfId` 或纯 `selfId`）；
 *   - bot.accounts 条目里的 selfId/uin 字段。
 * 用于把兄弟账号识别为"机器人(AI)"，而不是普通用户。
 */
export function listSelfIds() {
  const out = new Set()
  const configured = cfg.get('bot.selfIds', [])
  if (Array.isArray(configured)) {
    for (const x of configured) {
      const s = String(x || '').trim()
      if (s) out.add(s)
    }
  }
  for (const [k, v] of Object.entries(getAccountsMap())) {
    const key = String(k || '').trim()
    if (/^\d+$/.test(key)) out.add(key)
    else if (key.includes('_')) {
      const tail = key.split('_').pop().trim()
      if (/^\d+$/.test(tail)) out.add(tail)
    }
    if (v && typeof v === 'object') {
      const id = String(v.selfId ?? v.uin ?? '').trim()
      if (/^\d+$/.test(id)) out.add(id)
    }
  }
  for (const id of discoverSelfIds()) out.add(id)
  return [...out]
}

// 从全局 Bot/adapter 尽力发现"本插件连接的全部账号"（XRK-Yunzai 等适配器形态不一，逐形状兜底）。
// 结果短时缓存，避免每条消息都遍历全局对象。
let _discoverCache = { at: 0, ids: [] }
const DISCOVER_TTL = 10 * 1000

export function discoverSelfIds() {
  const now = Date.now()
  if (now - _discoverCache.at < DISCOVER_TTL && _discoverCache.ids.length) return _discoverCache.ids
  const out = new Set()
  const add = (v) => { const s = String(v ?? '').trim(); if (/^\d{4,}$/.test(s)) out.add(s) }
  try {
    const g = globalThis
    const roots = [g.Bot, g.bot, g.Bots].filter(Boolean)
    for (const root of roots) {
      const bots = Array.isArray(root) ? root : [root]
      for (const b of bots) {
        if (!b || typeof b !== 'object') continue
        add(b.uin); add(b.self_id); add(b.id)
        if (Array.isArray(b.uin)) for (const u of b.uin) add(u)
        if (Array.isArray(b.uinList)) for (const u of b.uinList) add(u)
        if (Array.isArray(b.botList)) for (const u of b.botList) add(u?.uin ?? u)
        if (b.adapter) {
          const arr = Array.isArray(b.adapter) ? b.adapter : [b.adapter]
          for (const a of arr) { add(a?.uin); add(a?.self_id); add(a?.account?.uin) }
        }
        for (const coll of [b.bots, b.botList, b.bot]) {
          if (coll && typeof coll === 'object') for (const k of Object.keys(coll)) add(k)
        }
        for (const k of Object.keys(b)) add(k)
      }
    }
  } catch (_) {}
  _discoverCache = { at: now, ids: [...out] }
  return _discoverCache.ids
}

/** 是否处于多账号场景（未满足时不注入身份块，保持单账号旧行为） */
export function isMultiAccountConfigured() {
  if (cfg.get('bot.injectIdentity', false) === true) return true
  if (Object.keys(getAccountsMap()).length > 0) return true
  return listSelfIds().length > 1
}

/**
 * 多账号应答归属判定：本次事件所属账号是否应当回应。
 * 规则（仅在识别到多个自身账号时生效）：
 *   - 消息 @ 了某些自身账号：仅被 @ 的账号回应；
 *   - 消息未 @ 任何自身账号：仅主账号（primarySid，缺省取 selfIds 第一个）回应；
 *   - 当前账号不在自身账号集合内：不干预（返回 true）。
 * @param {object} e 事件
 * @param {string[]} atTargets 本条消息被 @ 的 QQ 号（由 helper.listAtTargets 提供）
 * @param {{primarySid?: string}} [opts]
 */
export function shouldAccountRespond(e, atTargets = [], { primarySid = '' } = {}) {
  const selfIdSet = listSelfIds().map(String)
  if (selfIdSet.length <= 1) return true
  const me = String(e?.self_id ?? e?.bot?.uin ?? e?.bot?.self_id ?? '')
  if (!me || !selfIdSet.includes(me)) return true
  const mentioned = (Array.isArray(atTargets) ? atTargets : []).map(String).filter(q => selfIdSet.includes(q))
  if (mentioned.length > 0) return mentioned.includes(me)
  const configured = String(primarySid || '').trim()
  const primary = configured && selfIdSet.includes(configured) ? configured : selfIdSet[0]
  return me === primary
}

/**
 * 生成注入 system prompt 的身份说明（多账号才返回，否则 null）。
 * 关键：明确"当前账号"是谁、适配器是什么，并说明兄弟账号同样属于机器人，
 * 避免模型把自己和其他账号、以及把机器人当普通用户搞混。
 *
 * @param {object} e 已解析的消息事件
 * @param {object} [parsed] helper.parseMessageWithContext(e) 的结果（可选，用于补充发送者信息）
 */
export function buildBotIdentityContext(e, parsed = null) {
  if (!isMultiAccountConfigured()) return null
  const id = resolveBotIdentity(e)
  const selfIds = listSelfIds()
  const others = selfIds.filter((x) => String(x) !== String(id.selfId))
  const scene = e?.group_id ? `群聊(${e.group_id})` : '私聊'

  const lines = [
    '【你的身份（每轮以本条为准）】',
    `你是「${id.name}」。${id.persona}`.trim(),
    `本次回复所用账号：QQ=${id.selfId || '未知'}，适配器=${id.adapter}，场景=${scene}。`,
  ]
  if (parsed?.current?.user_id) {
    lines.push(`本条消息发送者：QQ=${parsed.current.user_id}${parsed.current.name ? `（${parsed.current.name}）` : ''}${parsed.current.isBot ? '（机器人/AI）' : ''}。`)
  }
  if (others.length) {
    lines.push(`同一 AI 在本群还有其它账号：${others.join('、')}；这些账号的发言同样属于机器人（AI），不要当成普通用户，也不要与你当前账号的身份混淆。`)
  }
  lines.push('说明：若本条消息发送者本身就是机器人账号，请按"机器人发言"理解；你的身份始终以"本次回复所用账号"为准。')
  return lines.join('\n')
}
