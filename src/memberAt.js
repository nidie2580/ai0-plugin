/**
 * 群成员艾特解析：把 AI 回复里的 @昵称 / @QQ号 转成真实的 at 消息段。
 *
 * 匹配规则（从严到宽）：
 *  1) @QQ号         —— 精确命中群成员 QQ
 *  2) @昵称/群名片  —— 忽略大小写精确命中
 *  3) @昵称+后缀文字 —— 名称前缀匹配（取最长），后缀原样保留为文本
 * 无法命中的 @ 原样保留为文本（不做任何改动）；@自己（机器人）不转换。
 *
 * 纯函数，无副作用；返回 null 表示没有任何可转换的艾特。
 */
export function parseMemberMentions(text, members, { selfId = '', max = 5 } = {}) {
  const src = String(text || '')
  if (!src.includes('@') || !Array.isArray(members) || !members.length) return null

  const byName = new Map()
  const byQq = new Set()
  for (const m of members) {
    const qq = String(m?.qq ?? m?.user_id ?? '').trim()
    const name = String(m?.name ?? m?.card ?? m?.nickname ?? '').trim()
    if (!qq) continue
    byQq.add(qq)
    if (name) byName.set(name.toLowerCase(), qq)
  }
  if (!byQq.size) return null

  const limit = Math.max(1, Math.min(20, Number(max) || 5))
  const re = /@([^\s@，。！？、；：,.!?;:()（）\[\]【】"'“”‘’…~～]+)/g
  const segments = []
  let cursor = 0
  let count = 0
  let mch

  while ((mch = re.exec(src)) && count < limit) {
    const token = mch[1]
    let qq = byQq.has(token) ? token : null
    let rest = ''
    if (!qq) {
      const lower = token.toLowerCase()
      qq = byName.get(lower) || null
      if (!qq) {
        // 名称前缀匹配：@张三丰你好 → 成员「张三丰」+ 剩余「你好」
        let best = null
        for (const [name, id] of byName) {
          if (lower.startsWith(name) && (!best || name.length > best.name.length)) best = { name, id }
        }
        if (best) { qq = best.id; rest = token.slice(best.name.length) }
      }
    }
    if (!qq) continue
    if (selfId && String(qq) === String(selfId)) continue

    const before = src.slice(cursor, mch.index)
    if (before) segments.push({ type: 'text', text: before })
    segments.push({ type: 'at', qq: String(qq) })
    segments.push({ type: 'text', text: ' ' + rest })
    cursor = mch.index + mch[0].length
    count++
  }

  if (!count) return null
  const tail = src.slice(cursor)
  if (tail) segments.push({ type: 'text', text: tail })
  // 合并相邻文本段，减少段数
  const merged = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (seg.type === 'text' && last?.type === 'text') last.text += seg.text
    else merged.push({ ...seg })
  }
  return merged
}
