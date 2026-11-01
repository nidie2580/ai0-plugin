/**
 * Agent 工具集（网页搜索 / 网页访问 / 浏览器操作 / 工具帮助）
 *
 * 设计（对应用户需求）：
 *  - 提示词只列「常用工具」；全部工具可经 [action:agent:help 关键词] 搜索用法
 *  - 工具语法沿用 [action:agent:<指令>] 单一格式，不引入 JSON/XML 调用协议：
 *      help <关键词>              查询工具用法（无关键词=列出全部）
 *      search <关键词>            联网搜索（Bing）
 *      fetch <url>                抓取网页正文（去标签，SSRF 防护）
 *      browser <子命令> ...       真实浏览器（puppeteer + 本机 Chrome 148）
 *        open <url> | text | links | click <选择器|x y> | type <选择器> <文本>
 *        scroll <up|down> [px] | longpress <x> <y> [ms] | screenshot | back | close
 *
 * 安全：网页请求走 security.safeFetchWithRedirects（逐跳 SSRF 校验）；
 *       浏览器仅无头模式、无持久化 profile，空闲 5 分钟自动关闭。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cfg from '../config/index.js'
import { safeLogger, sanitizeLog } from './globals.js'
import { safeFetchWithRedirects } from './security.js'

const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = path.join(PLUGIN_ROOT, 'agent', 'workspace')

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const BROWSER_IDLE_MS = 5 * 60 * 1000

/* ------------------------------------------------------------------ */
/*                          工具注册表                                  */
/* ------------------------------------------------------------------ */

export const AGENT_TOOL_DEFS = [
  {
    name: '命令执行',
    cmd: '<常规命令>',
    common: true,
    brief: '在沙箱内执行单条白名单命令（ls/cat/grep/curl 等）',
    usage: '[action:agent:ls -la]',
    keywords: '命令 执行 shell 文件 目录 查看 ls cat grep curl 下载',
    details: ['可直接执行白名单命令；管道/重定向/解释器禁用；路径限工作区内。'],
  },
  {
    name: '网页搜索',
    cmd: 'search',
    common: true,
    brief: '联网搜索关键词，返回标题/链接/摘要',
    usage: '[action:agent:search 关键词]',
    keywords: '搜索 联网 search 查资料 最新 资讯',
    details: ['示例：[action:agent:search 岑参云是什么]', '返回前 5-6 条结果的标题、链接与摘要。'],
  },
  {
    name: '网页访问',
    cmd: 'fetch',
    common: true,
    brief: '抓取一个网页并转成纯文本正文（去标签）',
    usage: '[action:agent:fetch https://example.com]',
    keywords: '访问 抓取 网页 fetch url 文章 读取',
    details: ['示例：[action:agent:fetch https://www.example.com/article]', '自动去 HTML 标签、限 4000 字符；不跟随跳转到非公网地址。'],
  },
  {
    name: '工具查询',
    cmd: 'help',
    common: true,
    brief: '按关键词查询全部工具用法（不确定有什么工具时先问它）',
    usage: '[action:agent:help 关键词]',
    keywords: '帮助 help 工具 用法 查询 有哪些',
    details: ['示例：[action:agent:help 浏览器] 查询浏览器工具全部子命令。', '不带关键词则列出全部工具。'],
  },
  {
    name: '浏览器操作',
    cmd: 'browser',
    common: false,
    brief: '真实浏览器：打开网页/读取正文/点击/输入/滚动/长按/截图',
    usage: '[action:agent:browser open https://example.com]',
    keywords: '浏览器 点击 滑动 滚动 长按 截图 输入 表单 登录 模拟 browser click scroll',
    details: [
      'browser open <url>             打开网页并返回标题+正文节选',
      'browser text                   读取当前页面正文',
      'browser links                  列出当前页前 30 个链接',
      'browser click <选择器>         点击元素（CSS 选择器）',
      'browser click <x> <y>          按坐标点击（如 click 400 300）',
      'browser type <选择器> <文本>   在输入框输入文本',
      'browser scroll <up|down> [px]  滚动页面（默认 600px）',
      'browser longpress <x> <y> [ms] 长按坐标（默认 800ms，触摸事件）',
      'browser screenshot             截图保存到工作区 tool-browser-*.png',
      'browser back                   返回上一页',
      'browser close                  关闭浏览器会话',
      '会话在多次指令间保持（打开后可以连续点击/滚动），空闲 5 分钟自动关闭。',
    ],
  },
]

/** 生成注入系统提示的「常用工具」段落（全部工具经 help 搜索） */
export function buildToolsPromptSection() {
  const lines = ['【可用工具（常用）】']
  for (const t of AGENT_TOOL_DEFS.filter((x) => x.common)) {
    lines.push(`- ${t.name}：${t.usage} —— ${t.brief}`)
  }
  lines.push('- 更多工具（如浏览器点击/滑动/长按/截图等）可用 [action:agent:help 关键词] 查询用法。')
  return lines.join('\n')
}

/** 工具查询：按关键词匹配全部工具，返回用法说明 */
export function searchAgentTools(keyword) {
  const kw = String(keyword || '').trim().toLowerCase()
  const hit = kw
    ? AGENT_TOOL_DEFS.filter((t) =>
        (t.name + ' ' + (t.cmd || '') + ' ' + (t.keywords || '') + ' ' + t.brief).toLowerCase().includes(kw))
    : AGENT_TOOL_DEFS
  if (!hit.length) {
    return `没有匹配「${keyword}」的工具。当前工具：${AGENT_TOOL_DEFS.map((t) => t.name).join('、')}。可用 [action:agent:help] 查看全部。`
  }
  return hit.map((t) => {
    const head = `【${t.name}】${t.brief}\n用法：${t.usage}`
    const det = Array.isArray(t.details) && t.details.length ? '\n' + t.details.map((d) => '  ' + d).join('\n') : ''
    return head + det
  }).join('\n\n')
}

/* ------------------------------------------------------------------ */
/*                          结果封装                                   */
/* ------------------------------------------------------------------ */

const toolOk = (detail, t0) => ({ ok: true, code: 0, costMs: Date.now() - t0, detail: detail || '（无输出）', aborted: false })
const toolErr = (msg, t0) => ({ ok: false, code: -1, costMs: Date.now() - t0, detail: `工具执行失败：${msg}`, error: msg, aborted: false })

/* ------------------------------------------------------------------ */
/*                          指令路由                                   */
/* ------------------------------------------------------------------ */

/**
 * 尝试把一条 agent 指令当作内置工具执行。
 * @returns {null | {ok,code,costMs,detail,error?,aborted}}  null = 不是工具指令（调用方回退沙箱命令）
 */
export async function tryRunAgentTool(instr, opts = {}) {
  const s = String(instr || '').trim()
  if (!s) return null
  let m
  // help / 工具查询
  if ((m = s.match(/^(?:help|帮助|工具)(?:\s+([\s\S]+))?$/i))) {
    const t0 = Date.now()
    return toolOk(searchAgentTools(m[1] || ''), t0)
  }
  // search / 网页搜索
  if ((m = s.match(/^(?:search|搜索|联网搜索|网页搜索)\s+([\s\S]+)$/i))) {
    if (cfg.get('agent.tools.web', true) === false) return toolErr('网页工具未启用（agent.tools.web=false）', Date.now())
    return await webSearchResult(m[1], opts)
  }
  // fetch / 网页访问
  if ((m = s.match(/^(?:fetch|访问|抓取|打开网页|网页访问)\s+(\S+)/i))) {
    if (cfg.get('agent.tools.web', true) === false) return toolErr('网页工具未启用（agent.tools.web=false）', Date.now())
    return await webFetchResult(m[1], opts)
  }
  // browser / 浏览器操作
  if ((m = s.match(/^(?:browser|浏览器)\s+([\s\S]+)$/i))) {
    if (cfg.get('agent.tools.browser', true) === false) return toolErr('浏览器工具未启用（agent.tools.browser=false）', Date.now())
    return await browserCommand(m[1].trim(), opts)
  }
  return null
}

/* ------------------------------------------------------------------ */
/*                          网页搜索（Bing）                            */
/* ------------------------------------------------------------------ */

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)) } catch (_) { return '' } })
}

function htmlToText(html) {
  let s = String(html || '')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim()
  return s
}

function parseBingResults(html) {
  const out = []
  const blocks = String(html || '').match(/<li class="b_algo"[\s\S]*?(?=<li class="b_algo"|<li class="b_ans|<\/ol>)/g) || []
  for (const b of blocks) {
    const a = b.match(/<h2[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!a) continue
    const snippet = b.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    out.push({
      url: decodeEntities(a[1]),
      title: decodeEntities(stripTags(a[2])).replace(/\s+/g, ' ').trim().slice(0, 120),
      snippet: snippet ? decodeEntities(stripTags(snippet[1])).replace(/\s+/g, ' ').trim().slice(0, 300) : '',
    })
  }
  return out
}

/** 解析 Bing RSS（一条 item 一行的场景与整页一行的场景都兼容） */
function parseBingRss(xml) {
  const out = []
  const blocks = String(xml || '').match(/<item>[\s\S]*?<\/item>/g) || []
  for (const b of blocks) {
    const t = b.match(/<title>([\s\S]*?)<\/title>/)
    const l = b.match(/<link>([\s\S]*?)<\/link>/)
    const d = b.match(/<description>([\s\S]*?)<\/description>/)
    if (!l) continue
    out.push({
      title: decodeEntities(stripTags(t ? t[1] : '')).replace(/\s+/g, ' ').trim().slice(0, 120),
      url: decodeEntities(stripTags(l[1])).trim(),
      snippet: decodeEntities(stripTags(d ? d[1] : '')).replace(/\s+/g, ' ').trim().slice(0, 300),
    })
  }
  return out.filter((x) => /^https?:/i.test(x.url))
}

async function webSearchResult(query, opts = {}) {
  const t0 = Date.now()
  try {
    const q = String(query || '').trim().slice(0, 200)
    if (!q) return toolErr('搜索关键词为空', t0)
    const headers = { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }

    // 主通道：Bing RSS（cc=US 避免机房 IP 被按区域判「无结果」；HTML 通道对机房 IP 会软封锁）
    const rssUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&format=rss&count=10&cc=US'
    const rr = await safeFetchWithRedirects(rssUrl, { maxBytes: 1024 * 1024, headers })
    if (rr.ok) {
      const xml = Buffer.isBuffer(rr.response?.data) ? rr.response.data.toString('utf8') : String(rr.response?.data || '')
      const items = parseBingRss(xml).slice(0, 8)
      if (items.length) {
        const detail = items.map((x, i) => `${i + 1}. ${x.title || '(无标题)'}\n   ${x.url}\n   ${x.snippet}`).join('\n')
        return toolOk(`搜索「${q}」结果：\n${detail}`, t0)
      }
    }

    // 兜底：Bing HTML（部分网络环境可用，能拿到结果块）
    const htmlUrl = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&cc=US&count=10'
    const hr = await safeFetchWithRedirects(htmlUrl, { maxBytes: 2 * 1024 * 1024, headers })
    if (hr.ok) {
      const html = Buffer.isBuffer(hr.response?.data) ? hr.response.data.toString('utf8') : String(hr.response?.data || '')
      const items = parseBingResults(html).slice(0, 6)
      if (items.length) {
        const detail = items.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n')
        return toolOk(`搜索「${q}」结果：\n${detail}`, t0)
      }
    }

    // 兜底通道：真实浏览器搜索（Bing 对机房 IP 软封锁，百度/DDG 在浏览器内可用）
    const hasCJK = /[\u4e00-\u9fff]/.test(q)
    const engines = hasCJK ? ['baidu', 'ddg'] : ['ddg', 'baidu']
    for (const eng of engines) {
      try {
        const items = await browserSearch(q, eng)
        if (items.length) {
          const detail = items.slice(0, 8).map((x, i) => `${i + 1}. ${x.title || '(无标题)'}\n   ${x.url}\n   ${x.snippet}`).join('\n')
          return toolOk(`搜索「${q}」结果（${eng === 'baidu' ? '百度' : 'DuckDuckGo'}）：\n${detail}`, t0)
        }
      } catch (err) {
        safeLogger.warn(`[ai0-plugin] 浏览器搜索(${eng})失败: ${sanitizeLog(err?.message || err)}`)
      }
    }

    return toolErr('搜索无结果（结果源暂不可用，可换关键词或稍后重试）', t0)
  } catch (err) {
    return toolErr(`搜索异常：${sanitizeLog(err?.message || err)}`, t0)
  }
}

/** 真实浏览器搜索：复用无头 Chrome（临时新页签，不干扰浏览会话主页面） */
async function browserSearch(query, engine) {
  const b = await ensureBrowser()
  const page = await b.newPage()
  try {
    await page.setViewport({ width: 1280, height: 900 })
    await page.setUserAgent(BROWSER_UA)
    const url = engine === 'baidu'
      ? 'https://www.baidu.com/s?wd=' + encodeURIComponent(query)
      : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    await sleep(1800)
    const title = await page.title().catch(() => '')
    if (/安全验证|验证码|Just a moment|Access denied/i.test(title)) return []
    const items = await page.evaluate((eng) => {
      const out = []
      if (eng === 'ddg') {
        document.querySelectorAll('.result').forEach((el) => {
          const a = el.querySelector('.result__a')
          const sn = el.querySelector('.result__snippet')
          if (a && a.getAttribute('href')) {
            let href = a.href || ''
            const m = href.match(/[?&]uddg=([^&]+)/)
            if (m) { try { href = decodeURIComponent(m[1]) } catch (_) {} }
            out.push({ title: (a.innerText || '').trim(), url: href, snippet: (sn ? sn.innerText : '').trim().slice(0, 300) })
          }
        })
      } else {
        document.querySelectorAll('.result, .c-container').forEach((el) => {
          const a = el.querySelector('h3 a')
          if (a && a.href) {
            out.push({
              title: (a.innerText || '').trim(),
              url: a.href,
              snippet: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
            })
          }
        })
      }
      return out
    }, engine)
    return (Array.isArray(items) ? items : []).filter((x) => x.url && x.title)
  } finally {
    try { await page.close() } catch (_) {}
  }
}

/* ------------------------------------------------------------------ */
/*                          网页访问（正文抓取）                        */
/* ------------------------------------------------------------------ */

async function webFetchResult(url, opts = {}) {
  const t0 = Date.now()
  try {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return toolErr('仅支持 http/https 链接', t0)
    const r = await safeFetchWithRedirects(u, {
      maxBytes: 3 * 1024 * 1024,
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    })
    if (!r.ok) return toolErr(`抓取失败：${sanitizeLog(r.error || String(r.response?.status || 'unknown'))}`, t0)
    const ct = String(r.response?.headers?.['content-type'] || '')
    let body = Buffer.isBuffer(r.response?.data) ? r.response.data.toString('utf8') : String(r.response?.data || '')
    const isHtml = /html/i.test(ct) || /^\s*<(?:!doctype|html)/i.test(body.slice(0, 300))
    if (isHtml) body = htmlToText(body)
    body = body.trim()
    if (!body) return toolOk('（页面无文本内容）', t0)
    return toolOk(`来源：${u}\n\n${body.slice(0, 4000)}`, t0)
  } catch (err) {
    return toolErr(`抓取异常：${sanitizeLog(err?.message || err)}`, t0)
  }
}

/* ------------------------------------------------------------------ */
/*                          浏览器操作（puppeteer）                     */
/* ------------------------------------------------------------------ */

let _browser = null
let _page = null
let _lastUse = 0
let _queue = Promise.resolve()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function closeBrowserSession() {
  try { if (_browser) await _browser.close() } catch (_) {}
  _browser = null
  _page = null
  _lastUse = 0
}

async function ensureBrowser() {
  if (_browser && Date.now() - _lastUse > BROWSER_IDLE_MS) await closeBrowserSession()
  if (!_browser) {
    const mod = await import('puppeteer')
    const puppeteer = mod.default || mod
    _browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--lang=zh-CN'],
    })
    _browser.on('disconnected', () => { _browser = null; _page = null })
    _page = null
    safeLogger.info('[ai0-plugin] Agent 浏览器会话已启动（puppeteer headless）')
  }
  _lastUse = Date.now()
  return _browser
}

async function ensurePage() {
  const b = await ensureBrowser()
  if (!_page || _page.isClosed?.()) {
    _page = await b.newPage()
    await _page.setViewport({ width: 1280, height: 900 })
    await _page.setUserAgent(BROWSER_UA)
  }
  _lastUse = Date.now()
  return _page
}

async function pageSummary(page, cap = 1200) {
  const title = await page.title().catch(() => '')
  const text = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '')
  return `标题：${title}\nURL：${page.url()}\n正文节选：\n${String(text || '').trim().slice(0, cap)}`
}

async function browserCommand(rest, opts = {}) {
  const t0 = Date.now()
  const run = async () => {
    const m = String(rest || '').match(/^(\S+)\s*([\s\S]*)$/)
    const sub = (m ? m[1] : '').toLowerCase()
    const args = (m ? m[2] : '').trim()

    if (sub === 'close') { await closeBrowserSession(); return toolOk('浏览器会话已关闭', t0) }

    const page = await ensurePage()

    if (sub === 'open') {
      const url = args.split(/\s+/)[0]
      if (!/^https?:\/\//i.test(url)) return toolErr('用法：browser open <http(s)://…>', t0)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
      await sleep(800)
      return toolOk(await pageSummary(page), t0)
    }
    if (sub === 'text') {
      const text = await page.evaluate(() => document.body ? document.body.innerText : '')
      return toolOk(String(text || '').trim().slice(0, 2200) || '（无文本）', t0)
    }
    if (sub === 'links') {
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map((a) => {
        let href = a.href
        try { href = a.href } catch (_) {}
        return { t: (a.innerText || '').trim().slice(0, 60), h: href }
      }).filter((x) => x.h && /^https?:/i.test(x.h)))
      if (!links.length) return toolOk('（当前页无链接）', t0)
      return toolOk(links.map((x, i) => `${i + 1}. ${x.t || '(无文字)'} → ${x.h}`).join('\n'), t0)
    }
    if (sub === 'click') {
      const coord = args.match(/^(\d+)\s+(\d+)$/)
      if (coord) {
        await page.mouse.click(Number(coord[1]), Number(coord[2]))
        await sleep(600)
        return toolOk(`已点击坐标 (${coord[1]}, ${coord[2]})\n${await pageSummary(page, 600)}`, t0)
      }
      if (!args) return toolErr('用法：browser click <选择器> 或 browser click <x> <y>', t0)
      await page.click(args, { timeout: 10000 })
      await sleep(600)
      return toolOk(`已点击「${args}」\n${await pageSummary(page, 600)}`, t0)
    }
    if (sub === 'type') {
      const sp = args.indexOf(' ')
      const sel = sp > 0 ? args.slice(0, sp) : args
      const text = sp > 0 ? args.slice(sp + 1) : ''
      if (!sel || !text) return toolErr('用法：browser type <选择器> <文本>', t0)
      await page.click(sel, { timeout: 10000 }).catch(() => {})
      await page.type(sel, text, { delay: 20, timeout: 10000 })
      return toolOk(`已在「${sel}」输入：${text.slice(0, 80)}`, t0)
    }
    if (sub === 'scroll') {
      const dir = (args.split(/\s+/)[0] || 'down').toLowerCase()
      const px = Number(args.split(/\s+/)[1]) || 600
      const dy = dir === 'up' ? -Math.abs(px) : Math.abs(px)
      const pos = await page.evaluate((d) => { window.scrollBy(0, d); return window.scrollY }, dy)
      await sleep(400)
      return toolOk(`已向${dir === 'up' ? '上' : '下'}滚动 ${Math.abs(dy)}px（当前 scrollY=${pos}）`, t0)
    }
    if (sub === 'longpress') {
      const parts = args.split(/\s+/)
      const x = Number(parts[0]); const y = Number(parts[1]); const ms = Number(parts[2]) || 800
      if (!Number.isFinite(x) || !Number.isFinite(y)) return toolErr('用法：browser longpress <x> <y> [毫秒]', t0)
      let done = false
      try {
        if (page.touchscreen) {
          await page.touchscreen.touchStart(x, y)
          await sleep(ms)
          await page.touchscreen.touchEnd()
          done = true
        }
      } catch (_) {}
      if (!done) {
        await page.mouse.move(x, y)
        await page.mouse.down()
        await sleep(ms)
        await page.mouse.up()
      }
      await sleep(400)
      return toolOk(`已在 (${x}, ${y}) 长按 ${ms}ms\n${await pageSummary(page, 500)}`, t0)
    }
    if (sub === 'screenshot') {
      try { fs.mkdirSync(WORKSPACE, { recursive: true }) } catch (_) {}
      const file = path.join(WORKSPACE, `tool-browser-${Date.now()}.png`)
      await page.screenshot({ path: file })
      return toolOk(`截图已保存到工作区：agent/workspace/${path.basename(file)}`, t0)
    }
    if (sub === 'back') {
      await page.goBack({ timeout: 15000 }).catch(() => {})
      await sleep(600)
      return toolOk(await pageSummary(page, 600), t0)
    }
    return toolErr(`未知子命令「${sub}」。可用：open/text/links/click/type/scroll/longpress/screenshot/back/close`, t0)
  }

  // 串行化，避免并发操作同一页面互相踩
  const task = _queue.then(run).catch((err) => toolErr(`浏览器异常：${sanitizeLog(err?.message || err)}`, t0))
  _queue = task.then(() => {}, () => {})
  return task
}
