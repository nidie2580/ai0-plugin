/**
 * 点歌服务（AI 对话内点歌 → 在线搜索 → 发送音乐卡片/文本降级）
 *
 * 支持源：
 *   - qq     QQ 音乐：c.y.qq.com 公开搜索接口（匿名可用；播放直链需换 vkey，视出口风控而定）
 *   - netease 网易云音乐：music.163.com 搜索接口（风控较严，可在配置填 Cookie 提升可用性）
 *
 * 发送策略：
 *   1) 拿得到可播直链(playUrl) → 构造 OneBot music(custom) 段发卡片；
 *   2) 否则降级为文本（歌名-歌手-来源详情页链接，可点开），绝不让用户空手而归。
 *
 * 纯解析/构造函数与网络隔离，便于注入 httpFn 做单元测试。
 */
import * as cfg from '../config/index.js'
import { safeLogger } from './globals.js'
import { safeAxiosRequest } from './security.js'

const MUSIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const HTTP_TIMEOUT_MS = 8000

/** 读取 chat.music 配置（含缺省补齐） */
export function getMusicConfig() {
  const m = cfg.get('chat.music', {}) || {}
  return {
    enabled: m.enabled === true,
    source: m.source === 'netease' ? 'netease' : 'qq',
    maxResults: Number.isFinite(Number(m.maxResults)) ? Math.min(5, Math.max(1, Number(m.maxResults))) : 3,
    qqCookie: String(m.qq?.cookie || ''),
    neteaseCookie: String(m.netease?.cookie || ''),
    tryPlayUrl: m.tryPlayUrl !== false,
  }
}

export function isMusicEnabled() {
  try { return getMusicConfig().enabled } catch (_) { return false }
}

async function httpGetJson(url, headers = {}, httpFn = null) {
  const doGet = httpFn || (async (u, h) => {
    const resp = await safeAxiosRequest('get', u, null, {
      headers: { 'User-Agent': MUSIC_UA, Accept: 'application/json', ...h },
      timeout: HTTP_TIMEOUT_MS,
    })
    return resp?.data
  })
  const data = await doGet(url, headers)
  if (data == null) throw new Error('音乐接口返回空')
  return data
}

/** 归一化 QQ 音乐搜索结果 JSON → 歌曲列表 */
export function parseQQSearchList(json) {
  const list = json?.data?.song?.list
  if (!Array.isArray(list)) return []
  const out = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const songmid = String(s.songmid || s.media_mid || s.id || '')
    const title = String(s.songname || s.name || '').trim()
    if (!songmid || !title) continue
    const artist = Array.isArray(s.singer)
      ? s.singer.map((x) => String(x?.name || '')).filter(Boolean).join('、')
      : String(s.albumname ? s.artist || '' : (s.artist || s.singer?.name || '') || '')
    out.push({
      source: 'qq',
      id: String(s.songid ?? s.id ?? ''),
      songmid,
      title,
      artist,
      album: String(s.albumname || s.album?.name || ''),
      cover: s.albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${String(s.albummid)}.jpg` : '',
      pageUrl: `https://y.qq.com/n/ryqq/songDetail/${songmid}`,
      playUrl: '',
      durationSec: Number(s.interval) > 0 ? Number(s.interval) : 0,
    })
  }
  return out
}

/** 归一化网易云搜索结果 JSON → 歌曲列表 */
export function parseNeteaseSearchList(json) {
  const list = json?.result?.songs
  if (!Array.isArray(list)) return []
  const out = []
  for (const s of list) {
    if (!s || typeof s !== 'object') continue
    const id = String(s.id ?? '')
    const title = String(s.name || '').trim()
    if (!id || !title) continue
    const artist = Array.isArray(s.artists)
      ? s.artists.map((x) => String(x?.name || '')).filter(Boolean).join('、')
      : String(s.artist || '')
    const cover = s.album?.picUrl || s.picUrl || ''
    out.push({
      source: 'netease',
      id,
      songmid: id,
      title,
      artist,
      album: String(s.album?.name || ''),
      cover: cover.startsWith('http') ? cover : '',
      pageUrl: `https://music.163.com/#/song?id=${id}`,
      // 网易云 outer/url 需服务端配合，未必可播；仅当后续 vkey 探测失败时给文本降级兜底
      playUrl: `https://music.163.com/song/media/outer/url?id=${id}.mp3`,
      durationSec: Number(s.duration > 0 ? Math.round(s.duration / 1000) : (s.duration || 0)),
    })
  }
  return out
}

/**
 * 尝试为 QQ 歌曲换取可播直链（GetVkeyServer）。风控环境下常返回 invalidq → 返 null。
 * 任何异常都不抛出，调用方按"不可播放"降级。
 */
export async function qqFetchPlayUrl(item, opts = {}) {
  try {
    if (!item || !item.songmid) return null
    const httpFn = opts.httpFn || null
    const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
    const body = {
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: { guid: '7' + String(Math.floor(Math.random() * 9e9 + 1e9)), songmid: [item.songmid], songtype: [0], uin: '0', loginflag: 1, platform: '20' },
      },
      comm: { uin: 0, format: 'json', ct: 24, cv: 0 },
    }
    const headers = { Referer: 'https://y.qq.com/', 'Content-Type': 'application/json' }
    let data = null
    if (httpFn) {
      const doPost = opts.httpPostFn || (async (u, b, h) => { throw new Error('no post fn') })
      data = await doPost(url, body, headers)
    } else {
      const resp = await safeAxiosRequest('post', url, body, {
        headers: { 'User-Agent': MUSIC_UA, ...headers },
        timeout: HTTP_TIMEOUT_MS,
      })
      data = resp?.data
    }
    const mid = data?.req_0?.data?.midurlinfo?.[0]
    const sip = data?.req_0?.data?.sip
    const purl = mid && typeof mid.purl === 'string' ? mid.purl : ''
    if (purl && Array.isArray(sip) && sip.length) {
      const base = String(sip[0]).replace(/\/$/, '')
      return base + '/' + purl
    }
    return null
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] QQ 换播放直链失败(降级文本): ${err?.message || err}`)
    return null
  }
}

/**
 * 按关键词搜索歌曲。
 * @param {{keyword:string, source?:'qq'|'netease', httpFn?:Function, httpPostFn?:Function}} opts
 * @returns {Promise<{ok:boolean, songs:Array, source:string, msg?:string, playable?:boolean}>}
 */
export async function searchSongs({ keyword, source, httpFn, httpPostFn } = {}) {
  const cfgObj = getMusicConfig()
  const kw = String(keyword || '').trim()
  if (!kw) return { ok: false, songs: [], source: source || cfgObj.source, msg: '搜索关键词为空' }
  if (kw.length > 100) return { ok: false, songs: [], source: source || cfgObj.source, msg: '搜索关键词过长' }
  const src = source === 'netease' ? 'netease' : (source === 'qq' ? 'qq' : cfgObj.source)

  try {
    let songs = []
    if (src === 'qq') {
      const u = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp')
      u.searchParams.set('format', 'json')
      u.searchParams.set('w', kw)
      u.searchParams.set('n', String(cfgObj.maxResults))
      u.searchParams.set('cr', '1')
      u.searchParams.set('t', '0')
      const headers = { Referer: 'https://y.qq.com/' }
      if (cfgObj.qqCookie) headers.Cookie = cfgObj.qqCookie
      const json = await httpGetJson(u.toString(), headers, httpFn)
      songs = parseQQSearchList(json)
    } else {
      const u = new URL('https://music.163.com/api/search/get')
      u.searchParams.set('s', kw)
      u.searchParams.set('type', '1')
      u.searchParams.set('limit', String(cfgObj.maxResults))
      u.searchParams.set('offset', '0')
      const headers = { Referer: 'https://music.163.com/', Cookie: cfgObj.neteaseCookie || 'os=pc' }
      const json = await httpGetJson(u.toString(), headers, httpFn)
      if (json && typeof json.code !== 'undefined' && json.code !== 200) {
        return { ok: false, songs: [], source: src, msg: `网易云搜索被风控(code=${json.code})，可尝试在 chat.music.netease.cookie 填入登录 Cookie` }
      }
      songs = parseNeteaseSearchList(json)
    }

    if (!songs.length) return { ok: false, songs: [], source: src, msg: `没有找到与「${kw}」相关的歌曲` }
    if (cfgObj.tryPlayUrl && src === 'qq') {
      // 只为排第一的候选换直链，决定"卡片 or 文本"降级
      const top = songs[0]
      const playUrl = await qqFetchPlayUrl(top, { httpFn, httpPostFn }).catch(() => null)
      if (playUrl) top.playUrl = playUrl
    }
    return { ok: true, songs, source: src }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 点歌搜索失败(${src}): ${err?.message || err}`)
    return { ok: false, songs: [], source: src, msg: `音乐搜索接口请求失败：${err?.message || err}` }
  }
}

/** 构造 OneBot 音乐卡片段（custom）。playUrl 为空时返回 null。 */
export function buildMusicCardSegment(item) {
  if (!item || !String(item.playUrl || '').trim()) return null
  try {
    if (typeof segment !== 'undefined' && segment && typeof segment.music === 'function') {
      return segment.music('custom', {
        url: item.pageUrl || '',
        audio: item.playUrl,
        title: item.title || '',
        author: item.artist || '',
        pic: item.cover || '',
      })
    }
  } catch (_) {}
  return {
    type: 'music',
    data: {
      type: 'custom',
      url: item.pageUrl || '',
      audio: item.playUrl,
      title: item.title || '',
      author: item.artist || '',
      pic: item.cover || '',
    },
  }
}

/** 构造 OneBot share 分享段（无播放直链时的卡片降级；适配器不支持时仍退回文本）。 */
export function buildShareSegment(item) {
  try {
    if (typeof segment !== 'undefined' && segment && typeof segment.share === 'function') {
      return segment.share(item.pageUrl, item.title, `${item.title} - ${item.artist}`, item.cover)
    }
  } catch (_) {}
  return {
    type: 'share',
    data: { url: item.pageUrl || '', title: `${item.title} - ${item.artist}`.trim(), content: `${item.artist}`, image: item.cover || '' },
  }
}

/** 把歌曲列表转成纯文本（无卡片可用时逐条展示，附来源链接） */
export function buildSongsText(songs, opts = {}) {
  const srcLabel = opts.source === 'netease' ? '网易云音乐' : 'QQ音乐'
  if (!Array.isArray(songs) || !songs.length) return `没有找到相关歌曲（${srcLabel}）。`
  const lines = [`为你找到以下歌曲（${srcLabel}，点击链接可播放）：`]
  songs.slice(0, 5).forEach((s, i) => {
    const who = s.artist ? ` - ${s.artist}` : ''
    lines.push(`${i + 1}. ${s.title}${who}\n   ${s.pageUrl || ''}`)
  })
  return lines.join('\n')
}

/**
 * 发送点歌结果：优先音乐卡片 → share 卡片 → 纯文本。
 * @returns {Promise<{ok:boolean, sentCard:boolean, text?:string, msg?:string}>}
 */
export async function sendSongsResult(e, songs, opts = {}) {
  const list = Array.isArray(songs) ? songs : []
  if (!list.length) {
    const t = opts.emptyText || '没有找到相关歌曲，换个关键词试试？'
    try { await e.reply(t) } catch (_) {}
    return { ok: false, sentCard: false, text: t, msg: 'empty' }
  }

  // 1) 首条带可播直链 → 音乐卡片
  const playable = list.find((s) => String(s.playUrl || '').trim())
  if (playable) {
    const seg = buildMusicCardSegment(playable)
    if (seg) {
      try {
        await e.reply(seg)
        return { ok: true, sentCard: true }
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] 音乐卡片发送失败，降级文本: ${err?.message || err}`)
      }
    }
  }

  // 2) share 卡片降级
  if (list[0]) {
    const share = buildShareSegment(list[0])
    if (share) {
      try {
        await e.reply(share)
        return { ok: true, sentCard: false, text: '' }
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] share 卡片发送失败，降级纯文本: ${err?.message || err}`)
      }
    }
  }

  // 3) 纯文本降级
  const text = buildSongsText(list, { source: opts.source })
  try { await e.reply(text) } catch (_) {}
  return { ok: true, sentCard: false, text }
}

/**
 * 构建"点歌能力"上下文（注入 system prompt，仿 buildImageContext）。
 * 未开启 chat.music.enabled 时返回 null，AI 完全不知道有点歌能力。
 */
export function buildMusicContext() {
  if (!isMusicEnabled()) return null
  const c = getMusicConfig()
  const srcLabel = c.source === 'netease' ? '网易云音乐' : 'QQ音乐'
  return [
    '【点歌能力】',
    '你可以帮用户在聊天中点歌/放歌/推荐歌曲。当用户表达想听歌、点歌、要某首歌，或让你"来首歌""推荐歌"时，请在回复末尾另起一行输出点歌指令：',
    '  [action:music:歌曲关键词]',
    '示例：用户说"点一首周杰伦的晴天"，你的回复可以是：',
    '  好的，为你点一首《晴天》。',
    '  [action:music:晴天 周杰伦]',
    '',
    '重要规则：',
    '  1) 用户没指定具体歌名（如"推荐一首适合深夜听的歌"）时，先在正文里说明你的推荐理由，再输出你推荐的那首歌的点歌指令。',
    '  2) 关键词尽量带歌名+歌手，精确搜索更容易命中。',
    '  3) 一次输出一条 [action:music:...]（系统会自动点播搜索到的第一首）；想点多首就分多条连续输出。',
    '  4) 点歌指令只供系统解析执行，用户看不到，不要在正文里提到该指令。',
    `  5) 当前搜索源：${srcLabel}。`,
  ].join('\n')
}
