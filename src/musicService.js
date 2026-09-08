/**
 * 点歌服务（AI 对话内点歌 → 在线搜索 → 发送音乐卡片/文本降级）
 *
 * 支持源（全部零 Cookie，不依赖用户私人登录态）：
 *   - qq     QQ 音乐：c.y.qq.com 搜索接口（匿名，部分出口 IP 会被风控返回 500，失败自动回退网易云）
 *   - netease 网易云音乐（默认）：先走 POST /api/v1/search/get 匿名搜索（稳定 code 200），
 *            拿不到封面时再用「移动端歌曲页」og: 元数据爬取兜底。
 *
 * 发送策略：
 *   1) 拿得到可播直链(playUrl) → 构造 OneBot music(custom) 段发卡片；
 *   2) 否则降级为文本（歌名-歌手-来源详情页链接，可点开），绝不让用户空手而归。
 *
 * 纯解析/构造函数与网络隔离，便于注入 httpFn/httpPostFn/httpPageFn 做单元测试。
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
    // 网易云接口匿名可用且更稳，默认音源改为网易云；QQ 在风控下失败会自动回退网易云
    source: m.source === 'qq' ? 'qq' : 'netease',
    maxResults: Number.isFinite(Number(m.maxResults)) ? Math.min(5, Math.max(1, Number(m.maxResults))) : 3,
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

/**
 * 归一化网易云搜索结果 JSON → 歌曲列表。
 * 兼容两种响应形态：
 *   - 旧 /api/search/get（result.songs[*].album 为对象，duration 毫秒）
 *   - v1 /api/v1/search/get（result.songs[*].album 可能为字符串；cover 取 album.picUrl 或歌手头像兜底）
 */
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
    const album = typeof s.album === 'object' && s.album ? s.album : null
    const cover = album?.picUrl || album?.blurPicUrl
      || (Array.isArray(s.artists) && s.artists[0]?.img1v1Url) || ''
    out.push({
      source: 'netease',
      id,
      songmid: id,
      title,
      artist,
      album: String(album ? (album.name || '') : (typeof s.album === 'string' ? s.album : '')),
      cover: String(cover).startsWith('http') ? cover : '',
      pageUrl: `https://music.163.com/#/song?id=${id}`,
      // 网易云 outer/url 需服务端配合，未必可播；仅当后续 vkey 探测失败时给文本降级兜底
      playUrl: `https://music.163.com/song/media/outer/url?id=${id}.mp3`,
      durationSec: Number(s.duration > 0 ? Math.round(s.duration / 1000) : (s.duration || 0)),
    })
  }
  return out
}

/** 单个网易云歌曲 id 的移动端详情页（服务端渲染），用于爬取 og: 元数据做封面/歌名兜底 */
const MUSIC_OG_CONSTANTS = {
  page: (id) => `https://music.163.com/m/song?id=${id}`,
  referer: 'https://music.163.com/',
}

/**
 * 爬取网易云移动端歌曲页，提取 og:title / og:image 作为元数据兜底。
 * 搜索接口无封面或异常时调用，返回 { title, artist, cover } 或 null。绝不抛异常。
 */
export async function neteaseCrawlSongPage(id, opts = {}) {
  try {
    if (!id) return null
    const httpPageFn = opts.httpPageFn || (async (u, h) => {
      const resp = await safeAxiosRequest('get', u, null, {
        headers: { 'User-Agent': MUSIC_UA, Referer: MUSIC_OG_CONSTANTS.referer },
        timeout: HTTP_TIMEOUT_MS,
      }, 5)
      return typeof resp?.data === 'string' ? resp.data : String(resp?.data || '')
    })
    const html = await httpPageFn(MUSIC_OG_CONSTANTS.page(id), MUSIC_OG_CONSTANTS.referer)
    if (!html || typeof html !== 'string') return null
    // og:title 如 "晴天（Sunny Day） - 周杰伦 - 单曲 - 网易云音乐"
    const titleM = html.match(/og:title[^>]*content=["']([^"']+)/i)
    const imgM = html.match(/og:image[^>]*content=["']([^"']+)/i)
    const descM = html.match(/name=["']description["'][^>]*content=["']([^"']+)/i)
    const ogTitle = titleM ? titleM[1].replace(/\s*-\s*网易云音乐\s*$/i, '') : ''
    const raw = ogTitle || (descM ? descM[1] : '')
    // 歌名优先取《》；否则取 - 之前段（去掉别名括号）
    let title = ''
    const bkm = raw.match(/《([^》]+)》/)
    if (bkm) {
      title = bkm[1]
    } else {
      const seg = raw.split(/\s*[-—–]\s*/)[0].trim()
      title = seg.replace(/（[^）]*）/g, '').trim()
    }
    // 歌手：取第一个 - 之后到第二个 - 之前段；去掉别名括号
    let artist = ''
    const parts = raw.split(/\s*[-—–]\s*/).filter(Boolean)
    if (parts.length >= 2) artist = parts[1].replace(/（[^）]*）/g, '').trim()
    const cover = imgM ? imgM[1].replace(/^http:/, 'https:') : ''
    return { title, artist, cover }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 网易云歌曲页爬取失败(id=${id}): ${err?.message || err}`)
    return null
  }
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
 * 网易云搜索：POST /api/v1/search/get（匿名稳定，code 200）。返回歌曲列表（可能含空列表）。
 * 注入 httpPostFn 便于测试；默认用 safeAxiosRequest。
 * @returns {Promise<{ok:boolean, songs:Array, msg?:string}>}
 */
export async function neteaseV1Search({ keyword, limit = 3, httpPostFn } = {}) {
  const body = new URLSearchParams({ s: keyword, type: '1', offset: '0', limit: String(limit) })
  const url = 'https://music.163.com/api/v1/search/get'
  const headers = { Referer: 'https://music.163.com/', 'Content-Type': 'application/x-www-form-urlencoded' }
  let data = null
  if (httpPostFn) {
    data = await httpPostFn(url, body.toString(), headers).catch(() => null)
  } else {
    const resp = await safeAxiosRequest('post', url, body.toString(), {
      headers: { 'User-Agent': MUSIC_UA, ...headers },
      timeout: HTTP_TIMEOUT_MS,
    })
    data = resp?.data
  }
  if (data == null) return { ok: false, songs: [], msg: '网易云搜索接口返回空' }
  if (typeof data.code !== 'undefined' && data.code !== 200) {
    return { ok: false, songs: [], msg: `网易云搜索被风控或失败(code=${data.code})` }
  }
  return { ok: true, songs: parseNeteaseSearchList(data) }
}

/**
 * 按关键词搜索歌曲（零 Cookie）。
 * 若 source=qq 被风控/空结果，自动回退网易云（见 OPTION: 默认网易云）。封面缺失时用歌曲页 og: 元数据爬取兜底。
 * @param {{keyword:string, source?:'qq'|'netease', httpFn?:Function, httpPostFn?:Function, httpPageFn?:Function}} opts
 * @returns {Promise<{ok:boolean, songs:Array, source:string, msg?:string, playable?:boolean}>}
 */
export async function searchSongs({ keyword, source, httpFn, httpPostFn, httpPageFn } = {}) {
  const cfgObj = getMusicConfig()
  const kw = String(keyword || '').trim()
  if (!kw) return { ok: false, songs: [], source: source || cfgObj.source, msg: '搜索关键词为空' }
  if (kw.length > 100) return { ok: false, songs: [], source: source || cfgObj.source, msg: '搜索关键词过长' }
  const want = source === 'qq' ? 'qq' : (source === 'netease' ? 'netease' : cfgObj.source)
  const src = want === 'qq' ? 'qq' : 'netease' // 最终实际用于降级展示的源

  try {
    let songs = []

    if (src === 'qq') {
      // QQ 匿名搜索（可能被风控返回 500 -> httpGetJson 抛错，走 catch 后回退）
      const u = new URL('https://c.y.qq.com/soso/fcgi-bin/client_search_cp')
      u.searchParams.set('format', 'json')
      u.searchParams.set('w', kw)
      u.searchParams.set('n', String(cfgObj.maxResults))
      u.searchParams.set('cr', '1')
      u.searchParams.set('t', '0')
      const headers = { Referer: 'https://y.qq.com/' }
      const json = await httpGetJson(u.toString(), headers, httpFn)
      songs = parseQQSearchList(json)
      if (songs.length) {
        // 只为排第一的候选换直链，决定"卡片 or 文本"降级
        if (cfgObj.tryPlayUrl) {
          const top = songs[0]
          const playUrl = await qqFetchPlayUrl(top, { httpFn, httpPostFn }).catch(() => null)
          if (playUrl) top.playUrl = playUrl
        }
        return { ok: true, songs, source: src }
      }
      // QQ 空结果 → 回退网易云（语义：默认源为网易云，QQ 仅尝试）
      safeLogger.warn('[ai0-plugin] QQ 点歌空结果/风控，回退网易云搜索')
    }

    // 网易云搜索（默认源，稳定匿名）。走到这里即实际用网易云
    const nres = await neteaseV1Search({ keyword: kw, limit: cfgObj.maxResults, httpPostFn })
    if (!nres.ok) return { ok: false, songs: [], source: 'netease', msg: nres.msg || '网易云搜索失败' }
    songs = nres.songs
    if (!songs.length) return { ok: false, songs: [], source: 'netease', msg: `没有找到与「${kw}」相关的歌曲` }

    // 封面补齐：搜索 JSON 常无 album.picUrl，用移动端歌曲页 og:image 兜底（只补缺封面前几条）
    for (const s of songs.slice(0, 3)) {
      if (s.cover) continue
      const og = await neteaseCrawlSongPage(s.id, { httpPageFn })
      if (og) {
        if (og.cover) s.cover = og.cover
        // 若歌名/歌手在搜索里缺失，用 og 补
        if (!s.title && og.title) s.title = og.title
        if (!s.artist && og.artist) s.artist = og.artist
      }
    }
    return { ok: true, songs, source: 'netease' }
  } catch (err) {
    // QQ 源请求抛错（风控/500）→ 回退网易云
    if (src === 'qq') {
      safeLogger.warn(`[ai0-plugin] 点歌搜索失败(${src})，回退网易云: ${err?.message || err}`)
      try {
        const nres = await neteaseV1Search({ keyword: kw, limit: cfgObj.maxResults, httpPostFn })
        if (nres.ok && nres.songs.length) return { ok: true, songs: nres.songs, source: 'netease' }
        return { ok: false, songs: [], source: 'netease', msg: nres.msg || `没有找到与「${kw}」相关的歌曲` }
      } catch (err2) {
        return { ok: false, songs: [], source: 'netease', msg: `音乐搜索失败（QQ 与网易云均不可用）：${err2?.message || err2}` }
      }
    }
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
