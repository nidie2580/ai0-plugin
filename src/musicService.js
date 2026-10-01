/**
 * 点歌服务（移植自 zhenxun_plugin_music v1.5 的搜索/语音链路，适配 Yunzai/ESM）
 *
 * 双音源：
 *   - ncm  网易云音乐：/api/search/get + /api/v3/song/detail + commentInfo（X-Real-IP 免限制），
 *          播放直链走 /api/song/enhance/player/url（320kbps 高音质）
 *   - qq   QQ 音乐：第三方聚合 API https://a.aa.cab/qq.music（返回可播直链+封面）
 *
 * 发送策略（sendSongsResultRich）：
 *   ① 语音：直链下载 → ffmpeg 转 192kbps MP3（失败回退原文件）→ record 发送
 *   ② 点歌信息卡片图（SVG，仅歌曲信息，无署名标题）→ 降级原生 music 卡 → 纯文本
 *   ③ 卡片发送成功时补一条可点链接
 *
 * 保留历史导出（chatService / AI 指令 / 单测依赖）。
 */
import * as cfg from '../config/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { safeLogger } from './globals.js'
import { safeAxiosRequest } from './security.js'
import { safeSegmentImageWithFallback, imageSegmentFromFile, unlinkStaleFilesInDir } from './helper.js'
import { renderSongCard } from './svgRender.js'

const MUSIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const HTTP_TIMEOUT_MS = 8000

// 语音临时目录放 os.tmpdir()（跨用户可进入），文件 0o644 落盘，避免适配器
// 以独立用户运行时 stat 插件 data/ 下文件报 EACCES（同 helper.getImageSegment）
const LEGACY_AUDIO_TMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tmp')
const AUDIO_TMP_DIR = path.join(os.tmpdir(), 'ai0-plugin-audio')
const AUDIO_MAX_BYTES = 20 * 1024 * 1024
const AUDIO_MAX_REDIRECTS = 5

// 网易云接口（移植自 model_ncm.py）
const NCM_DOMAIN = 'https://music.163.com'
const NCM_REAL_IP = '58.100.87.193'
const NCM_COOKIE = 'os=pc; appver=2.10.10.201911;'
// QQ 音乐第三方聚合 API（移植自 model_qq.py）
const QQ_API_URL = 'https://a.aa.cab/qq.music'

/** 读取 chat.music 配置（含缺省补齐） */
export function getMusicConfig() {
  const m = cfg.get('chat.music', {}) || {}
  return {
    enabled: m.enabled === true,
    // 默认双源自动（ncm 优先）；显式 source=qq 时优先 QQ
    source: m.source === 'qq' ? 'qq' : 'ncm',
    maxResults: Number.isFinite(Number(m.maxResults)) ? Math.min(5, Math.max(1, Number(m.maxResults))) : 3,
    tryPlayUrl: m.tryPlayUrl !== false,
    // 音源开关（对齐 zhenxun：ENABLE_NCM / ENABLE_QQ）
    enableNcm: m.enableNcm !== false,
    enableQq: m.enableQq !== false,
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

/** 网易云 form POST（对齐 model_ncm.request：X-Real-IP 绕限）；httpPostFn 供单测注入 */
async function ncmFormPost(uri, params, httpPostFn = null) {
  const body = new URLSearchParams(params).toString()
  if (typeof httpPostFn === 'function') return httpPostFn(NCM_DOMAIN + uri, body)
  const resp = await safeAxiosRequest('post', NCM_DOMAIN + uri, body, {
    headers: {
      'User-Agent': MUSIC_UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Real-IP': NCM_REAL_IP,
      'X-Forwarded-For': NCM_REAL_IP,
      Referer: NCM_DOMAIN,
    },
    timeout: HTTP_TIMEOUT_MS * 2,
  })
  if (resp.status !== 200) throw new Error(`网易云接口失败(HTTP ${resp.status})`)
  return typeof resp.data === 'object' ? resp.data : JSON.parse(resp.data || '{}')
}

/** 网易云搜索（默认取第一条） */
export async function ncmSearch(keywords, limit = 1, httpPostFn = null) {
  return ncmFormPost('/api/search/get/', { s: keywords, limit, type: 1, offset: 0 }, httpPostFn)
}

/** 网易云歌曲详情 */
export async function ncmSongDetail(id, httpPostFn = null) {
  return ncmFormPost('/api/v3/song/detail', { c: JSON.stringify([{ id }]) }, httpPostFn)
}

/** 网易云评论/分享数 */
export async function ncmCommentInfo(id, httpPostFn = null) {
  return ncmFormPost('/api/resource/commentInfo/list', {
    fixliked: true,
    needupgradedinfo: true,
    resourceIds: JSON.stringify([id]),
    resourceType: 4,
  }, httpPostFn)
}

function joinArtistNames(artists) {
  if (!Array.isArray(artists)) return ''
  const names = artists.map((x) => String(x?.name || '').trim()).filter(Boolean)
  return names.join(' / ')
}

/** 网易云元数据（对齐 model_ncm.MusicHelper163.meta_data） */
export async function ncmMeta(keywords, httpPostFn = null) {
  const ret0 = await ncmSearch(keywords, 1, httpPostFn)
  const songs = Array.isArray(ret0?.result?.songs) ? ret0.result.songs : []
  if (!songs.length) return null
  const songId = String(songs[0]?.id ?? '').trim()
  if (!songId) return null

  const ret1 = await ncmSongDetail(songId, httpPostFn)
  const detail = Array.isArray(ret1?.songs) ? ret1.songs[0] : null
  if (!detail) return null

  let comment = {}
  try {
    const ret2 = await ncmCommentInfo(songId, httpPostFn)
    const list = Array.isArray(ret2?.data) ? ret2.data : []
    if (list.length) comment = list[0] || {}
  } catch (_) {}

  const alias = [...(detail.tns || []), ...(detail.alia || [])].filter(Boolean)
  return {
    source: 'ncm',
    id: songId,
    title: String(detail.name || ''),
    alias: [...new Set(alias)].join(' / '),
    artist: joinArtistNames(detail.ar),
    album: String(detail.al?.name || ''),
    cover: String(detail.al?.picUrl || '').replace(/^http:/, 'https:'),
    durationSec: Number(detail.dt) > 0 ? Math.round(Number(detail.dt) / 1000) : 0,
    commentCount: Number(comment.commentCount || 0),
    shareCount: Number(comment.shareCount || 0),
    pageUrl: `${NCM_DOMAIN}/#/song?id=${songId}`,
    playUrl: '',
  }
}

/** 网易云 320kbps 播放直链（对齐 MusicVoiceService.get_play_url_ncm） */
export async function ncmPlayUrl(songId, httpFn = null) {
  try {
    const u = new URL(`${NCM_DOMAIN}/api/song/enhance/player/url`)
    u.searchParams.set('ids', `[${songId}]`)
    u.searchParams.set('br', '320000')
    const headers = {
      'User-Agent': MUSIC_UA,
      Referer: NCM_DOMAIN,
      Cookie: NCM_COOKIE,
    }
    const resp = typeof httpFn === 'function'
      ? await httpFn(u.toString(), { headers })
      : await safeAxiosRequest('get', u.toString(), null, { headers, timeout: HTTP_TIMEOUT_MS * 2 })
    if (resp.status === 200) {
      const urls = Array.isArray(resp.data?.data) ? resp.data.data : []
      const url = String(urls[0]?.url || '')
      if (url && /^https?:\/\//.test(url)) return url
    }
    return ''
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 网易云直链获取失败(id=${songId}): ${err?.message || err}`)
    return ''
  }
}

/** QQ 音乐元数据（对齐 model_qq.MusicHelperQQ.meta_data，第三方聚合 API） */
export async function qqMeta(keywords, httpFn = null) {
  const u = new URL(QQ_API_URL)
  u.searchParams.set('msg', keywords)
  u.searchParams.set('num', '1')
  u.searchParams.set('n', '1')
  u.searchParams.set('type', '4')
  const headers = { 'User-Agent': MUSIC_UA, Referer: 'https://y.qq.com/' }
  const resp = typeof httpFn === 'function'
    ? await httpFn(u.toString(), { headers })
    : await safeAxiosRequest('get', u.toString(), null, { headers, timeout: HTTP_TIMEOUT_MS * 2 })
  if (resp.status !== 200) throw new Error(`QQ音乐接口失败(HTTP ${resp.status})`)
  const data = typeof resp.data === 'object' ? resp.data : JSON.parse(resp.data || '{}')
  if (data?.code !== 0) throw new Error(String(data?.msg || 'QQ音乐返回错误'))
  const sd = data?.data
  if (!sd) return null
  const musicUrl = String(sd.music || '')
  if (!musicUrl) return null
  return {
    source: 'qq',
    id: String(sd.id ?? ''),
    title: String(sd.song || '未知'),
    alias: '',
    artist: String(sd.singer || '未知'),
    album: String(sd.album || ''),
    cover: String(sd.cover || ''),
    durationSec: Number(sd.time) > 0 ? Number(sd.time) : 0,
    commentCount: 0,
    shareCount: 0,
    pageUrl: String(sd.id ? `https://y.qq.com/n/ryqq/songDetail/${sd.id}` : musicUrl),
    playUrl: musicUrl,
  }
}

/** 归一化 QQ 音乐搜索结果 JSON → 歌曲列表（保留导出供单测） */
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
      : String((s.singer && typeof s.singer === 'object' ? s.singer.name : '') || s.artist || s.singer || '')
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

/** 归一化网易云搜索结果 JSON → 歌曲列表（保留导出供单测） */
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
      playUrl: `https://music.163.com/song/media/outer/url?id=${id}.mp3`,
      durationSec: Number(s.duration > 0 ? Math.round(s.duration / 1000) : (s.duration || 0)),
    })
  }
  return out
}

/** 网易云移动端歌曲页 og 元数据兜底（保留导出供单测） */
const MUSIC_OG_CONSTANTS = {
  page: (id) => `https://music.163.com/m/song?id=${id}`,
  referer: 'https://music.163.com/',
}

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
    const titleM = html.match(/og:title[^>]*content=["']([^"']+)/i)
    const imgM = html.match(/og:image[^>]*content=["']([^"']+)/i)
    const descM = html.match(/name=["']description["'][^>]*content=["']([^"']+)/i)
    const ogTitle = titleM ? titleM[1].replace(/\s*-\s*网易云音乐\s*$/i, '') : ''
    const raw = ogTitle || (descM ? descM[1] : '')
    let title = ''
    const bkm = raw.match(/《([^》]+)》/)
    if (bkm) {
      title = bkm[1]
    } else {
      const seg = raw.split(/\s*[-—–]\s*/)[0].trim()
      title = seg.replace(/（[^）]*）/g, '').trim()
    }
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

/** QQ vkey 直链（保留导出供单测/降级，主链路改用聚合 API） */
export async function qqFetchPlayUrl(item, opts = {}) {
  try {
    if (!item || !item.songmid) return null
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
    const resp = await safeAxiosRequest('post', url, body, {
      headers: { 'User-Agent': MUSIC_UA, ...headers },
      timeout: HTTP_TIMEOUT_MS,
    })
    const data = resp?.data
    const mid = data?.req_0?.data?.midurlinfo?.[0]
    const sip = data?.req_0?.data?.sip
    const purl = mid && typeof mid.purl === 'string' ? mid.purl : ''
    if (purl && Array.isArray(sip) && sip.length) {
      return `${sip[0]}${purl}`
    }
    return null
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] QQ vkey 换取失败: ${err?.message || err}`)
    return null
  }
}

/**
 * 双源搜索（对齐 zhenxun search_music 的回退语义）：
 *   source='ncm' → 只搜网易云；source='qq' → 只搜 QQ；否则自动。
 *   自动模式：网易云**必须拿到可播直链**才算命中；直链拿不到（版权/接口失败）→
 *   自动回退 QQ 音乐；QQ 也失败才报"没有找到这首歌"。
 * @returns {Promise<{ok:boolean, songs:Array, source:string, msg?:string}>}
 */
export async function searchSongs({ keyword, source, httpFn, httpPostFn, httpPageFn } = {}) {
  const cfgObj = getMusicConfig()
  const kw = String(keyword || '').trim()
  if (!kw) return { ok: false, songs: [], source: source || cfgObj.source, msg: '搜索关键词为空' }
  if (kw.length > 100) return { ok: false, songs: [], source: source || cfgObj.source, msg: '搜索关键词过长' }

  // 归一化来源参数：'netease' 兼容旧值映射为 'ncm'
  const want = source === 'qq' ? 'qq' : (source === 'netease' || source === 'ncm' ? 'ncm' : '')

  const tryNcm = async (requirePlayUrl) => {
    if (!cfgObj.enableNcm) return null
    const meta = await ncmMeta(kw, httpPostFn)
    if (!meta || !meta.id) return null
    const url320 = cfgObj.tryPlayUrl ? await ncmPlayUrl(meta.id, httpFn) : ''
    if (url320) {
      meta.playUrl = url320
      return meta
    }
    // 直链拿不到：outer/url 兜底（版权歌可能 404，语音环节会校验拦截）
    meta.playUrl = `${NCM_DOMAIN}/song/media/outer/url?id=${meta.id}.mp3`
    // 自动模式下直链拿不到不算命中（返回 null 让调用方回退 QQ）；强制源时仍返回 meta 保卡片
    return requirePlayUrl ? null : meta
  }

  const tryQQ = async (requirePlayUrl) => {
    if (!cfgObj.enableQq) return null
    const meta = await qqMeta(kw, httpFn)
    if (!meta) return null
    if (!meta.playUrl && requirePlayUrl) return null
    return meta
  }

  try {
    if (want === 'ncm') {
      // 强制网易云：直链拿不到仍返回 meta（卡片/链接可用，语音走 outer/url 校验）
      const meta = await tryNcm(false)
      if (meta) return { ok: true, songs: [meta], source: 'ncm' }
      return { ok: false, songs: [], source: 'ncm', msg: '网易云没找到这首歌！' }
    }
    if (want === 'qq') {
      const meta = await tryQQ(false)
      if (meta) return { ok: true, songs: [meta], source: 'qq' }
      return { ok: false, songs: [], source: 'qq', msg: 'QQ音乐没找到这首歌！' }
    }

    // 自动：网易云优先，**必须拿到可播直链**；否则回退 QQ（对齐 zhenxun search_music）
    let meta = null
    try { meta = await tryNcm(true) } catch (err) {
      safeLogger.warn(`[ai0-plugin] 网易云搜索异常: ${err?.message || err}`)
    }
    if (meta) return { ok: true, songs: [meta], source: 'ncm' }
    safeLogger.info('[ai0-plugin] 网易云无可用直链，回退 QQ 音源')

    try { meta = await tryQQ(true) } catch (err) {
      safeLogger.warn(`[ai0-plugin] QQ音乐搜索异常: ${err?.message || err}`)
    }
    if (meta) return { ok: true, songs: [meta], source: 'qq' }

    return { ok: false, songs: [], source: 'ncm', msg: '没有找到这首歌！' }
  } catch (err) {
    return { ok: false, songs: [], source: want || 'ncm', msg: `搜索失败：${err?.message || err}` }
  }
}

/** 原生 music 自定义卡（自带可播音频） */
export function buildMusicCardSegment(item) {
  const type = String(item?.source || '') === 'qq' ? 'qq' : '163'
  const id = Number(item?.id)
  if (!Number.isFinite(id) || id <= 0) return null
  try {
    if (typeof segment !== 'undefined' && segment && typeof segment.music === 'function') {
      return segment.music({ type, id })
    }
  } catch (_) {}
  return { type: 'music', data: { type, id } }
}

/** share 卡 */
export function buildShareSegment(item) {
  const url = String(item?.pageUrl || item?.playUrl || '').trim()
  const title = String(item?.title || '音乐分享')
  if (!url) return null
  try {
    if (typeof segment !== 'undefined' && segment && typeof segment.share === 'function') {
      return segment.share({ title, url, content: title })
    }
  } catch (_) {}
  return null
}

/** 纯文本降级 */
export function buildSongsText(songs, opts = {}) {
  const list = Array.isArray(songs) ? songs : []
  if (!list.length) return '没有找到相关歌曲，换个关键词试试？'
  const srcLabel = opts.source === 'qq' ? 'QQ音乐' : '网易云音乐'
  const item = list[0]
  const lines = [
    `🎵 ${item.title}${item.artist ? ` - ${item.artist}` : ''}`,
    item.album ? `专辑：${item.album}` : '',
    `来源：${srcLabel}`,
    item.pageUrl ? item.pageUrl : '',
  ].filter(Boolean)
  return lines.join('\n')
}

/**
 * 网易云 v1 搜索（兼容保留导出，旧单测/调用方依赖）。
 * 返回归一化歌曲列表（多结果，maxResults 条）。
 */
export async function neteaseV1Search({ keyword, limit = 3, httpPostFn } = {}) {
  try {
    const ret = await ncmFormPost('/api/search/get/', { s: String(keyword || '').trim(), limit, type: 1, offset: 0 }, httpPostFn)
    const songs = parseNeteaseSearchList(ret)
    if (!songs.length) return { ok: false, songs: [], msg: `没有找到与「${keyword}」相关的歌曲` }
    return { ok: true, songs }
  } catch (err) {
    return { ok: false, songs: [], msg: `网易云搜索失败：${err?.message || err}` }
  }
}

/** AI 点歌指令上下文（保留原实现，供 AI 识别点歌意图） */
export function buildMusicContext() {
  if (!isMusicEnabled()) return null
  const c = getMusicConfig()
  const srcLabel = c.source === 'qq' ? 'QQ音乐' : '网易云音乐'
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

// ============================================================
//   直连点歌命令 + 待歌名状态 + 富格式发送（语音 + 点歌卡片 + 链接）
// ============================================================

/** 匹配点歌命令："点歌"、"点歌 歌名"、"网易点歌 歌名"、"QQ点歌 歌名"（可带 # 前缀）。非命令返回 null。 */
export function matchSongCommand(text) {
  const t = String(text || '').trim()
  if (!t) return null
  // 强制音源命令优先匹配（避免被"点歌"规则吞掉）
  const mSrc = /^#?\s*(网易点歌|QQ点歌)(?:\s+([^\n]{1,100}))?\s*$/i.exec(t)
  if (mSrc) {
    return { keyword: (mSrc[2] || '').trim(), source: /网易/i.test(mSrc[1]) ? 'ncm' : 'qq' }
  }
  const m = /^#?\s*点歌(?:\s+([^\n]{1,100}))?\s*$/.exec(t)
  if (!m) return null
  return { keyword: (m[1] || '').trim(), source: '' }
}

// 待歌名状态：群/私聊分 key，TTL 内该用户下一条纯文本消息即为歌名（无需再 @/前缀）
const PENDING_TTL_MS = 2 * 60 * 1000
const PENDING_MAX = 500
const pendingSongReq = new Map()

function pendingKey(groupId, userId) {
  return `${groupId ? 'g' + groupId : 'p'}:${userId}`
}

export function setPendingSongRequest(groupId, userId) {
  if (!userId) return
  if (pendingSongReq.size >= PENDING_MAX) {
    const oldest = pendingSongReq.keys().next().value
    if (oldest) pendingSongReq.delete(oldest)
  }
  pendingSongReq.set(pendingKey(groupId, userId), Date.now() + PENDING_TTL_MS)
}

export function peekPendingSongRequest(groupId, userId) {
  const k = pendingKey(groupId, userId)
  const exp = pendingSongReq.get(k)
  if (!exp) return false
  if (Date.now() > exp) {
    pendingSongReq.delete(k)
    return false
  }
  return true
}

export function clearPendingSongRequest(groupId, userId) {
  pendingSongReq.delete(pendingKey(groupId, userId))
}

/** 语音段（record）：适配器不支持/无 ffmpeg 时发送会抛错，由调用方忽略继续发卡片 */
export function buildRecordSegment(item) {
  const url = String(item?.playUrl || '').trim()
  if (!url) return null
  try {
    if (typeof segment !== 'undefined' && segment && typeof segment.record === 'function') {
      return segment.record(url)
    }
  } catch (_) {}
  return { type: 'record', data: { file: url } }
}

/** 音频魔数嗅探：ID3/MP3帧同步/Ogg/MP4/M4A/WAV/FLAC 任一命中即视为音频 */
function looksLikeAudioBuffer(buf) {
  if (!buf || buf.length < 12) return false
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true                    // "ID3" (mp3)
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return true                               // MPEG 帧同步 (mp3)
  if (buf.slice(0, 4).toString('latin1') === 'OggS') return true                             // ogg
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return true                             // mp4/m4a
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return true // wav
  if (buf.slice(0, 4).toString('latin1') === 'fLaC') return true                             // flac
  return false
}

/** 查找 ffmpeg 可执行文件（对齐 zhenxun _find_ffmpeg） */
function findFfmpeg() {
  try {
    const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const candidates = [
      path.join(pluginRoot, 'ffmpeg.exe'),
      path.join(pluginRoot, 'ffmpeg'),
      'ffmpeg',
    ]
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p
      } catch (_) {}
    }
  } catch (_) {}
  return 'ffmpeg'
}

/** ffmpeg 转 192kbps MP3（对齐 zhenxun convert_to_mp3）。失败返回 null（调用方回退原文件）。 */
export async function convertToMp3(inputPath) {
  try {
    if (!inputPath || !fs.existsSync(inputPath)) return null
    const output = inputPath.replace(/\.(m4a|aac|wav|flac|ogg)$/i, '.mp3')
    if (output === inputPath) return inputPath
    await new Promise((resolve) => {
      try {
        const proc = spawn(findFfmpeg(), [
          '-i', inputPath,
          '-acodec', 'libmp3lame',
          '-ab', '192k',
          '-ar', '44100',
          '-ac', '2',
          '-y',
          output,
        ], { windowsHide: true })
        let settled = false
        const done = () => { if (!settled) { settled = true; resolve() } }
        proc.on('close', done)
        proc.on('error', done)
        // 60s 兜底：ffmpeg 卡死不阻塞点歌链路
        setTimeout(done, 60 * 1000).unref?.()
      } catch (_) {
        resolve()
      }
    })
    if (fs.existsSync(output)) {
      const size = fs.statSync(output).size
      safeLogger.info(`[ai0-plugin] 点歌语音 MP3 转换成功: ${size} bytes`)
      return output
    }
    return null
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] MP3 转换失败: ${err?.message || err}`)
    return null
  }
}

/**
 * 下载音频为本地文件（跟随重定向 + 魔数校验）→ ffmpeg 转 192kbps MP3。
 * 网易云版权歌 302→404 在此被拦下；转码失败回退原始文件。
 * @returns {Promise<{ok:boolean, filePath?:string, reason?:string, copyright?:boolean}>}
 */
export async function downloadAudioForVoice(item) {
  const url = String(item?.playUrl || '').trim()
  if (!url) return { ok: false, reason: '无可播直链' }
  let raw = null
  try {
    const resp = await safeAxiosRequest('get', url, null, {
      headers: {
        'User-Agent': MUSIC_UA,
        Referer: /qq\.com/i.test(url) ? 'https://y.qq.com/' : `${NCM_DOMAIN}/`,
        Cookie: /qq\.com/i.test(url) ? '' : NCM_COOKIE,
      },
      timeout: HTTP_TIMEOUT_MS * 4,
      responseType: 'arraybuffer',
      maxContentLength: AUDIO_MAX_BYTES,
      maxBodyLength: AUDIO_MAX_BYTES,
    }, AUDIO_MAX_REDIRECTS)
    if (resp.status !== 200) {
      const copyright = resp.status === 403 || resp.status === 404
      return { ok: false, reason: `音频下载失败(HTTP ${resp.status})`, copyright }
    }
    const ct = String(resp.headers?.['content-type'] || '')
    const buf = Buffer.from(resp.data || Buffer.alloc(0))
    if (/text\/html/i.test(ct) || /^\s*</.test(buf.slice(0, 64).toString('utf8'))) {
      return { ok: false, reason: `响应为 HTML 占位页(content-type=${ct || 'unknown'})`, copyright: true }
    }
    const looksAudio = /^(audio|video)\//i.test(ct) || looksLikeAudioBuffer(buf)
    if (!looksAudio) {
      return { ok: false, reason: `响应非音频格式(${ct || 'content-type 缺失'}, ${buf.length}B)`, copyright: true }
    }
    if (!fs.existsSync(AUDIO_TMP_DIR)) fs.mkdirSync(AUDIO_TMP_DIR, { recursive: true, mode: 0o755 })
    // 陈旧音频清理（发送失败时 setTimeout 兜底删不掉），10 分钟节流
    try {
      if (!downloadAudioForVoice._lastSweep || Date.now() - downloadAudioForVoice._lastSweep > 10 * 60 * 1000) {
        downloadAudioForVoice._lastSweep = Date.now()
        unlinkStaleFilesInDir(AUDIO_TMP_DIR, Date.now(), 60 * 60 * 1000)
        unlinkStaleFilesInDir(LEGACY_AUDIO_TMP_DIR, Date.now(), 60 * 60 * 1000)
      }
    } catch (_) {}
    const isMp3 = (buf.length > 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)
    const filePath = path.join(AUDIO_TMP_DIR, `song-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}.${isMp3 ? 'mp3' : 'm4a'}`)
    fs.writeFileSync(filePath, buf, { mode: 0o644 })
    raw = filePath
  } catch (err) {
    return { ok: false, reason: `音频下载异常：${err?.message || err}` }
  }

  // 高音质转换：192kbps MP3（QQ 语音兼容 + 体积可控）；失败回退原始文件
  try {
    const mp3 = await convertToMp3(raw)
    if (mp3 && mp3 !== raw) {
      try { fs.unlinkSync(raw) } catch (_) {}
      raw = mp3
    }
  } catch (_) {}

  // 5 分钟后清理（语音已按 base64 内联发送，本地文件无保留价值）
  const finalPath = raw
  setTimeout(() => {
    try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath) } catch (_) {}
  }, 5 * 60 * 1000).unref?.()
  // 读出转 base64:// 内联返回（适配器容器可能看不到本机路径）；读取失败退回本地路径
  let fileRef = finalPath
  try { fileRef = 'base64://' + fs.readFileSync(finalPath).toString('base64') } catch (_) {}
  return { ok: true, filePath: fileRef }
}

function getBotName(e) {
  let n = ''
  try {
    n = String(e?.bot?.nickname || (typeof Bot !== 'undefined' ? Bot?.nickname : '') || 'AI')
  } catch (_) {}
  return (n.trim() || 'AI').slice(0, 20)
}

/**
 * 富格式发送（移植 zhenxun handle_music_request 流程）：
 *   ① 语音（直链下载+MP3 转码；发送失败忽略）
 *   ② 点歌信息卡片图（SVG 渲染，仅歌曲信息）→ 降级原生 music 卡 → 纯文本
 *   ③ 卡片发送成功时补一条可点链接
 * @returns {Promise<{ok:boolean, sentCard:boolean, voiceSent:boolean, text?:string, msg?:string}>}
 */
export async function sendSongsResultRich(e, songs, opts = {}) {
  const list = Array.isArray(songs) ? songs : []
  if (!list.length) {
    const t = opts.emptyText || '没有找到相关歌曲，换个关键词试试？'
    try { await e.reply(t) } catch (_) {}
    return { ok: false, sentCard: false, voiceSent: false, text: t, msg: 'empty' }
  }
  const item = list.find((s) => String(s.playUrl || '').trim()) || list[0]
  let voiceSent = false
  let voiceSkippedReason = ''

  // ① 语音：直链真实下载（版权歌 302→404 在此被拦下）→ MP3 转码 → record 发送
  const download = opts.downloadAudioFn || downloadAudioForVoice
  const dl = await download(item).catch((err) => ({ ok: false, reason: `下载钩子异常：${err?.message || err}` }))
  if (dl?.ok && dl.filePath) {
    const rec = buildRecordSegment({ playUrl: dl.filePath })
    if (rec) {
      try {
        await e.reply(rec)
        voiceSent = true
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] 点歌语音发送失败(适配器不支持/缺ffmpeg？忽略，继续发卡片): ${err?.message || err}`)
        voiceSkippedReason = '语音发送失败'
      }
    }
  } else {
    voiceSkippedReason = dl?.reason || '未知'
    safeLogger.info(`[ai0-plugin] 点歌语音跳过：${voiceSkippedReason}${dl?.copyright ? '（版权受限，无试听）' : ''}`)
  }

  // ② 点歌信息卡片图 + ③ 可点链接（版权受限时附说明）
  try {
    const svgPath = await renderSongCard(item, getBotName(e))
    // base64 内联发送；转换失败（非白名单/文件缺失）退回本地路径 segment
    const cardSeg = imageSegmentFromFile(svgPath) || safeSegmentImageWithFallback(svgPath)
    await e.reply(cardSeg)
    if (item.pageUrl) {
      const linkText = voiceSent || !dl?.copyright
        ? String(item.pageUrl)
        : `${item.pageUrl}\n(该歌曲版权受限，没有语音试听，点链接可去 App 播放)`
      try { await e.reply(linkText) } catch (_) {}
    }
    return { ok: true, sentCard: true, voiceSent }
  } catch (err) {
    safeLogger.warn(`[ai0-plugin] 点歌卡片图发送失败，降级原生卡片: ${err?.message || err}`)
  }

  // 降级：原生 music 自定义卡（自带可播音频）→ share 卡 → 纯文本
  const native = buildMusicCardSegment(item)
  if (native) {
    try {
      await e.reply(native)
      return { ok: true, sentCard: true, voiceSent }
    } catch (err) {
      safeLogger.warn(`[ai0-plugin] 原生音乐卡片发送失败，降级 share: ${err?.message || err}`)
    }
  }
  const share = buildShareSegment(item)
  if (share) {
    try {
      await e.reply(share)
      return { ok: true, sentCard: false, voiceSent }
    } catch (err) {
      safeLogger.warn(`[ai0-plugin] share 卡片发送失败，降级纯文本: ${err?.message || err}`)
    }
  }
  const text = buildSongsText(list, { source: opts.source })
  try { await e.reply(text) } catch (_) {}
  return { ok: true, sentCard: false, voiceSent, text }
}

/** 搜索 + 富格式发送（点歌命令与 AI 点歌指令共用）。 */
export async function searchAndSendSongs(e, keyword, opts = {}) {
  const res = await searchSongs({ keyword, source: opts.source })
  if (!res.ok) {
    const t = res.msg || '没有找到相关歌曲，换个关键词试试？'
    try { await e.reply(t) } catch (_) {}
    return { ok: false, sentCard: false, voiceSent: false, text: t, msg: res.msg }
  }
  return sendSongsResultRich(e, res.songs, { source: res.source })
}

/**
 * 处理直连点歌命令（"点歌"/"点歌 歌名"/"网易点歌 xxx"/"QQ点歌 xxx"/"#点歌 xxx"）。
 * 未命中返回 false。需遵守触发规则（群内 @/前缀），由调用方在 matched 判定之后调用。
 * 只发命令词不带歌名的：登记待歌名状态并提示回复歌名。
 */
export async function handleSongCommand(e, pureText, ctx = {}) {
  if (!isMusicEnabled()) return false
  const hit = matchSongCommand(pureText)
  if (!hit) return false
  if (hit.keyword) {
    await searchAndSendSongs(e, hit.keyword, { source: hit.source })
    return true
  }
  setPendingSongRequest(ctx.groupId, ctx.userId)
  try { await e.reply('🎵 歌名是？直接回复歌名即可（2分钟内有效），发送「取消」退出点歌。') } catch (_) {}
  return true
}

/** 待歌名状态下如何解释下一条消息：keep=不当作歌名 / cancel / empty / search */
export function resolvePendingSongInput(text) {
  const kw = String(text || '').trim()
  const songCmd = matchSongCommand(kw)
  if (songCmd) {
    if (!songCmd.keyword) return { kind: 'keep' }
    return { kind: 'search', keyword: songCmd.keyword }
  }
  if (/^[#／/]/.test(kw)) return { kind: 'keep' }
  if (!kw) return { kind: 'empty' }
  if (/^取消$/.test(kw)) return { kind: 'cancel' }
  return { kind: 'search', keyword: kw.slice(0, 100) }
}

/**
 * 消费待歌名状态：命中时把这条消息当歌名执行点歌（"取消"退出）。未命中返回 false。
 * 在触发规则之前调用（问完歌名后直接回歌名，不需要再 @/前缀）。
 */
export async function consumePendingSongReply(e, { groupId, userId, text } = {}) {
  if (!isMusicEnabled()) return false
  if (!peekPendingSongRequest(groupId, userId)) return false
  const parsed = resolvePendingSongInput(text)
  if (parsed.kind === 'keep') return false
  clearPendingSongRequest(groupId, userId)
  if (parsed.kind === 'empty') {
    try { await e.reply('没有拿到歌名，点歌已取消。') } catch (_) {}
    return true
  }
  if (parsed.kind === 'cancel') {
    try { await e.reply('已取消点歌。') } catch (_) {}
    return true
  }
  await searchAndSendSongs(e, parsed.keyword)
  return true
}

/** 兼容旧导出：sendSongsResult 纯文本降级（多行文本） */
export async function sendSongsResult(e, songs, opts = {}) {
  const list = Array.isArray(songs) ? songs : []
  if (!list.length) {
    const t = opts.emptyText || '没有找到相关歌曲，换个关键词试试？'
    try { await e.reply(t) } catch (_) {}
    return { ok: false, text: t, msg: 'empty' }
  }
  const text = buildSongsText(list, { source: opts.source })
  try { await e.reply(text) } catch (_) {}
  return { ok: true, sentCard: false, voiceSent: false, text }
}