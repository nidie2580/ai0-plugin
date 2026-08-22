/**
 * SVG 图片生成 + 落盘发送模块
 * - 生成 SVG → 写入 data/tmp/*.svg（本地文件路径）
 * - 调用方通过 segment.image(本地绝对路径) 发送
 * - 支持模型列表分页（每页 MODELS_PER_PAGE 个模型，图片底部显示页码+翻页命令）
 *
 * 关于 "rich media transfer failed" 的规避：
 *   NapCat/LLOneBot 对直接塞 Buffer/base64 的 SVG 经常会因富媒体转换失败。
 *   因此我们强制走「本地文件路径 + 绝对路径」的链路，并避免 text+image 混发在同一条 segment 数组里。
 *   若个别端仍不支持 SVG，则自动退回纯文字版。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLUGIN_ROOT = path.join(__dirname, '..')
const TMP_DIR = path.join(PLUGIN_ROOT, 'data', 'tmp')
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true })

// ===== 分页参数 =====
const MODELS_PER_PAGE = 14          // 每个平台每页展示多少条（含省略提示）
const MAX_PLATFORMS_PER_IMAGE = 8   // 单张图最多展示几个平台（超出则继续分页）

export { MODELS_PER_PAGE, MAX_PLATFORMS_PER_IMAGE, esc }

// ======== 基础工具 ========
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function defs() {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#EEF2FF"/>
        <stop offset="100%" stop-color="#E0F2FE"/>
      </linearGradient>
      <linearGradient id="hdr" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#4F46E5"/>
        <stop offset="100%" stop-color="#06B6D4"/>
      </linearGradient>
      <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#FFFFFF"/>
        <stop offset="100%" stop-color="#F9FAFB"/>
      </linearGradient>
      <filter id="shadow" x="-2%" y="-3%" width="104%" height="108%">
        <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#111827" flood-opacity="0.08"/>
      </filter>
    </defs>`
}

function wrap(width, bodyHeight, bodyContent, subtitle, pageInfo) {
  const HEADER_H = 92
  const PAD = 28
  const FOOTER_H = 46
  const totalHeight = HEADER_H + PAD + bodyHeight + PAD + FOOTER_H
  const ver = 'v1.0'
  const pi = pageInfo || ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" font-family='"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif'>
  <rect x="0" y="0" width="${width}" height="${totalHeight}" fill="url(#bg)"/>
  ${defs()}
  <!-- Header -->
  <rect x="0" y="0" width="${width}" height="${HEADER_H}" fill="url(#hdr)"/>
  <text x="32" y="42" font-size="26" font-weight="700" fill="#FFFFFF">🤖 AI0-Plugin</text>
  <text x="32" y="70" font-size="15" fill="#E0E7FF">${esc(subtitle || '')}</text>
  <rect x="${width - 120}" y="28" width="90" height="34" rx="17" fill="#ffffff22" stroke="#ffffff44"/>
  <text x="${width - 75}" y="50" text-anchor="middle" font-size="13" font-weight="600" fill="#FFFFFF">${esc(ver)}</text>

  <!-- Body -->
  <g transform="translate(${PAD},${HEADER_H + PAD})">
    ${bodyContent}
  </g>

  <!-- Footer -->
  <g transform="translate(0, ${totalHeight - 20})">
    <text x="32" y="0" font-size="12" fill="#9CA3AF">AI0-Plugin · ${esc(ver)} · ${new Date().toLocaleString('zh-CN')}</text>
    <text x="${width - 32}" y="0" text-anchor="end" font-size="12" fill="#6B7280" font-weight="600">${esc(pi)}</text>
  </g>
</svg>`
}

// ======== 工具：落盘到本地并返回绝对路径 ========
let tmpCounter = 0
function writeSvg(svgText, prefix) {
  const ts = Date.now().toString(36)
  const id = `${prefix}-${ts}-${(++tmpCounter).toString(36)}.svg`
  const filePath = path.join(TMP_DIR, id)
  fs.writeFileSync(filePath, svgText, 'utf-8')
  // 异步清理：5 分钟后删除临时文件（确保发送链路已完成）
  setTimeout(() => {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath) } catch (_) {}
  }, 5 * 60 * 1000).unref?.()
  return filePath
}

// ======== 清理过旧临时文件（启动时调用一次） ========
export function cleanupOldTmp(maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(TMP_DIR)) {
      const fp = path.join(TMP_DIR, f)
      const st = fs.statSync(fp)
      if (now - st.mtimeMs > maxAgeMs) {
        try { fs.unlinkSync(fp) } catch (_) {}
      }
    }
  } catch (_) {}
}

// ============================================================
//   帮助菜单
// ============================================================
function renderSections(sections, width) {
  const COL1 = 240
  const LINE_H = 26
  const SEC_GAP = 18
  const SEC_TITLE_H = 34
  let y = 0
  let html = ''
  for (const sec of sections) {
    html += `<rect x="0" y="${y}" width="6" height="${SEC_TITLE_H}" rx="3" fill="#4F46E5"/>`
    html += `<text x="20" y="${y + 22}" font-size="17" font-weight="700" fill="#111827">${esc(sec.title)}</text>`
    y += SEC_TITLE_H
    for (const line of sec.lines) {
      if (typeof line === 'string') {
        html += `<text x="4" y="${y + 17}" font-size="13.5" fill="#4B5563">${esc(line)}</text>`
        y += LINE_H
      } else {
        const [cmd, desc] = line
        html += `<rect x="0" y="${y}" width="${COL1}" height="${LINE_H - 4}" rx="6" fill="#F3F4F6" stroke="#E5E7EB"/>`
        html += `<text x="10" y="${y + 17}" font-size="13" fill="#111827" font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(cmd)}</text>`
        html += `<text x="${COL1 + 16}" y="${y + 17}" font-size="13" fill="#4B5563">${esc(desc)}</text>`
        y += LINE_H
      }
    }
    y += SEC_GAP
  }
  return { html, height: y }
}

/**
 * 返回本地 SVG 绝对路径（调用方 segment.image(filePath) 发送）
 */
export function renderHelp() {
  const W = 900
  const sections = [
    { title: '💬 对话', lines: [
      ['群聊 / 私聊', '群聊艾特我 / 私聊直接发消息即可对话'],
      ['全局AI开启时', '指定群号列表内，无需@机器人也会回复所有消息']
    ] },
    { title: '🔁 常用命令', lines: [
      ['#ai帮助', '查看此帮助菜单'],
      ['#ai新会话', '开启新的对话（清空上下文）'],
      ['#ai模型', '查看当前使用的模型配置'],
      ['#切换模型', '查看所有 API 平台及可用模型'],
      ['#切换模型 1.3', '按 平台号.模型号 切换'],
      ['#切换模型 kimi 1', '指定平台 + 编号 / 模型名切换'],
      ['#切换模型 下一页', '模型过多时翻页查看']
    ] },
    { title: '👥 群管理（AI 驱动）', lines: [
      ['@机器人 禁言@某人 10分钟', 'AI 判定合法性后回复并执行'],
      ['@机器人 踢了@某人', '仅群主/管理员/主人可发起'],
      ['@机器人 给我个头衔 大佬', '群内所有人可自助申请头衔']
    ] },
    { title: '🎨 图片生成', lines: [
      ['@机器人 画一只可爱的猫咪', 'AI 调用生图模型生成并发送图片'],
      ['@机器人 生成一张风景图', '需在网页端开启生图模型']
    ] },
    { title: '🌍 全局AI模式（仅主人）', lines: [
      ['#ai全局ai 开', '开启（当前群自动加入列表）'],
      ['#ai全局ai 关', '关闭'],
      ['#ai全局ai', '查看当前状态']
    ] },
    { title: '🌐 网页管理后台（仅主人）', lines: [
      ['#ai网页管理', '生成免登录一次性直链'],
      ['#ai网页启动 / 关闭', '启动/关闭网页后台'],
      ['#ai验证码', '生成终端验证码(ID+Code)用于网页登录']
    ] },
    { title: '⚙️ 管理命令（仅主人）', lines: [
      ['#切换模型 [...]', '多API平台一键切换'],
      ['#ai设置模型 <名>', '修改默认平台模型ID'],
      ['#ai设置apikey <key>', '修改默认平台 API Key'],
      ['#ai设置api <URL>', '修改默认平台 apiBase'],
      ['#ai添加主人 <QQ>', '添加新主人'],
      ['#ai重载', '重新加载配置文件']
    ] },
    { title: '🔍 诊断命令', lines: [
      ['#ai诊断', '检查权限/主人/配置/后台（仅主人可用）'],
      ['#ai测试模型 [key]', '探测 /models + 发起 /chat/completions 调用']
    ] },
    { title: '💡 小提示', lines: [
      '· Kimi/DeepSeek apiBase 推荐写法：https://api.moonshot.cn/v1（不要写 /chat/completions）',
      '· 若主人判定异常，发送 #ai诊断 可查看主人三列来源',
      '· 网页绑定 0.0.0.0 后，需放行安全组和系统防火墙 TCP 端口'
    ] }
  ]
  const { html, height } = renderSections(sections, W)
  const svg = wrap(W, height, html, '帮助菜单 · 命令速查表')
  return writeSvg(svg, 'help')
}

// ============================================================
//   多 API 平台模型切换列表（支持分页）
// ============================================================
/**
 * 按分页参数切片模型列表，返回「一页」的 providerData
 * 输入：
 *   providerData: [{ key, idx, isDefault, online, error, url, currentModel, models:[] }, ...]
 *   page: 目标页码（1-based；默认 1）
 * 返回：
 *   {
 *     pages: [ { pageNum, svgPath, hasPrev, hasNext } ],
 *     totalPages,
 *     summary
 *   }
 * 每页：
 *   - 最多 MAX_PLATFORMS_PER_IMAGE 个平台
 *   - 每个平台最多 MODELS_PER_PAGE 个模型
 *   - 超出的平台 / 超出的模型 放到后续页
 *   - 图片底部显示「P x/y · #切换模型 上一页 / 下一页」
 */
export function renderModelListPages(providerData, page = 1) {
  const W = 960
  const CARD_HDR = 58
  const CARD_PAD = 16
  const LINE_H = 24
  const COLS = 2
  const COL_W = (W - 56 - (COLS - 1) * 16) / COLS
  const CARD_GAP = 16
  const STAT_H = 90
  const START_Y = STAT_H + 20

  // ---- 步骤1：把所有平台拆成「分页所需的 (platformIdx, modelStartIdx)」
  // 规则：
  //   如果某平台 models.length > MODELS_PER_PAGE，需要分成多段（同一平台出现多次）
  //   否则该平台占一段（如果剩余空间不够就挪到下一页）
  const segments = []
  for (let i = 0; i < providerData.length; i++) {
    const p = providerData[i]
    const totalModels = p.models?.length || 0
    if (totalModels === 0 || !p.online) {
      segments.push({ platformIdx: i, modelStart: 0, modelCount: 0 })
      continue
    }
    for (let s = 0; s < totalModels; s += MODELS_PER_PAGE) {
      const count = Math.min(MODELS_PER_PAGE, totalModels - s)
      segments.push({ platformIdx: i, modelStart: s, modelCount: count, totalModels })
    }
  }

  // ---- 步骤2：把 segments 分配到每页（每段占一个卡片槽）
  const pagesSegments = []
  let current = []
  for (const seg of segments) {
    if (current.length >= MAX_PLATFORMS_PER_IMAGE) {
      pagesSegments.push(current)
      current = []
    }
    current.push(seg)
  }
  if (current.length) pagesSegments.push(current)
  if (pagesSegments.length === 0) pagesSegments.push([])

  const totalPages = pagesSegments.length
  const safePage = Math.max(1, Math.min(page, totalPages))
  const currentSegs = pagesSegments[safePage - 1] || []

  // 汇总：当前页卡片高度
  const cards = []
  for (const seg of currentSegs) {
    const p = providerData[seg.platformIdx]
    const rows = Math.max(seg.modelCount, 1) + 2  // +2: header info + 分隔线 + 省略行（若有）
    const contentH = rows * LINE_H + 12
    const h = CARD_HDR + CARD_PAD + contentH + 8
    cards.push({ seg, p, h })
  }

  const colHeights = Array(COLS).fill(0)
  const colCards = Array.from({ length: COLS }, () => [])
  for (const c of cards) {
    let col = 0
    for (let i = 1; i < COLS; i++) if (colHeights[i] < colHeights[col]) col = i
    colCards[col].push({ ...c, col, y: colHeights[col] })
    colHeights[col] += c.h + CARD_GAP
  }
  const cardsBodyH = Math.max(...colHeights)

  // 提示条
  const tipsText = [
    '切换方式：① #切换模型 1.3        → 平台 1 的第 3 个模型',
    '          ② #切换模型 kimi-k2.6  → 跨平台按名称自动匹配',
    '          ③ #切换模型 kimi 1    → 指定平台 + 编号/模型名',
    '          ④ #切换模型 kimi      → 仅切换默认平台到 kimi',
    '翻页命令：#切换模型 上一页 / #切换模型 下一页'
  ]
  const tipsH = tipsText.length * 22 + 22

  const totalBodyH = START_Y + cardsBodyH + 22 + tipsH + 20
  const pi = `P ${safePage}/${totalPages} · 共 ${providerData.length} 平台`

  // 统计（取全量）
  let totalAvail = 0
  for (const p of providerData) if (p.online) totalAvail += (p.models?.length || 0)
  const defaultP = providerData.find(p => p.isDefault)

  const statHtml = `
    <rect x="0" y="0" width="${W - 56}" height="${STAT_H}" rx="14" fill="url(#card)" stroke="#E5E7EB" filter="url(#shadow)"/>
    <g transform="translate(24, 0)">
      <circle cx="30" cy="30" r="20" fill="#EEF2FF"/>
      <text x="30" y="36" text-anchor="middle" font-size="18">📊</text>
      <text x="64" y="22" font-size="13" fill="#6B7280">总览</text>
      <text x="64" y="44" font-size="15" font-weight="700" fill="#111827">
        ${providerData.length} 个平台 · ${totalAvail} 个可用模型
      </text>
      <text x="64" y="66" font-size="12" fill="#6B7280">
        当前默认平台：<tspan font-weight="700" fill="#4F46E5">${esc(defaultP?.key || '-')}</tspan>
        · 当前默认模型：<tspan font-weight="700" fill="#111827">${esc(defaultP?.currentModel || '(未设置)')}</tspan>
      </text>
    </g>
  `

  let cardsHtml = ''
  for (let col = 0; col < COLS; col++) {
    for (const c of colCards[col]) {
      const x = col * (COL_W + CARD_GAP)
      const y = START_Y + c.y
      const p = c.p
      const seg = c.seg
      const isDefault = !!p.isDefault
      const online = !!p.online
      // 如果该平台被分段，显示分段后缀 (1/3, 2/3...)
      const segCount = segments.filter(s => s.platformIdx === c.seg.platformIdx).length
      const partLabel = segCount > 1
        ? ` <tspan fill="#6B7280" font-size="12">(${Math.floor(seg.modelStart / MODELS_PER_PAGE) + 1}/${segCount})</tspan>`
        : ''

      cardsHtml += `<rect x="${x}" y="${y}" width="${COL_W}" height="${c.h}" rx="14"
        fill="url(#card)" stroke="${isDefault ? '#A5B4FC' : '#E5E7EB'}" stroke-width="${isDefault ? '2' : '1'}" filter="url(#shadow)"/>`

      const statusColor = online ? '#10B981' : '#EF4444'
      const statusText = online ? '在线' : '离线'
      cardsHtml += `<circle cx="${x + 18}" cy="${y + 20}" r="6" fill="${statusColor}"/>`
      cardsHtml += `<text x="${x + 32}" y="${y + 25}" font-size="13" fill="${statusColor}" font-weight="600">${statusText}</text>`
      cardsHtml += `<text x="${x + 90}" y="${y + 26}" font-size="14" font-weight="700" fill="#111827">
        #${p.idx}. ${esc(p.key)}${partLabel}
      </text>`
      if (isDefault) {
        cardsHtml += `<rect x="${x + COL_W - 72}" y="${y + 12}" width="58" height="22" rx="11" fill="#EEF2FF"/>`
        cardsHtml += `<text x="${x + COL_W - 43}" y="${y + 28}" text-anchor="middle" font-size="11" font-weight="700" fill="#4F46E5">默认</text>`
      }
      const curModel = p.currentModel || '(未设置)'
      cardsHtml += `<text x="${x + 16}" y="${y + 50}" font-size="12" fill="#6B7280">当前模型:</text>`
      cardsHtml += `<text x="${x + 16 + 68}" y="${y + 50}" font-size="12.5" fill="#111827" font-weight="600"
        font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(curModel)}</text>`
      cardsHtml += `<line x1="${x + 16}" y1="${y + CARD_HDR - 4}" x2="${x + COL_W - 16}" y2="${y + CARD_HDR - 4}" stroke="#F3F4F6" stroke-width="1"/>`

      const contY = y + CARD_HDR + CARD_PAD
      if (!online) {
        const err = p.error || '探测失败'
        cardsHtml += `<text x="${x + 16}" y="${contY + 18}" font-size="13" fill="#EF4444" font-weight="600">❌ ${esc(err)}</text>`
        if (p.url) {
          cardsHtml += `<text x="${x + 16}" y="${contY + 40}" font-size="11" fill="#9CA3AF">URL: ${esc(p.url.length > 48 ? p.url.slice(0, 45) + '...' : p.url)}</text>`
        }
      } else if ((p.models?.length || 0) === 0) {
        cardsHtml += `<text x="${x + 16}" y="${contY + 18}" font-size="13" fill="#F59E0B">⚠ 该账号未返回任何可用模型</text>`
      } else {
        const list = p.models.slice(seg.modelStart, seg.modelStart + seg.modelCount)
        list.forEach((id, i) => {
          const realIdx = seg.modelStart + i
          const rowY = contY + 4 + i * LINE_H
          const isCurrent = (id === p.currentModel)
          cardsHtml += `<text x="${x + 16}" y="${rowY + 17}" font-size="11.5" fill="#9CA3AF"
            font-family='ui-monospace,Menlo,Consolas,monospace'>${p.idx}.${realIdx + 1})</text>`
          cardsHtml += `<text x="${x + 46}" y="${rowY + 17}" font-size="12.5"
            fill="${isCurrent ? '#4F46E5' : '#1F2937'}" font-weight="${isCurrent ? '700' : '400'}"
            font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(id)}${isCurrent ? ' ← 当前' : ''}</text>`
        })
        // 如果该平台还有下一页（本页显示的不是最后一段），提示一下
        const segIdx = Math.floor(seg.modelStart / MODELS_PER_PAGE)
        if (segIdx + 1 < segCount) {
          const remain = seg.totalModels - (seg.modelStart + list.length)
          const rowY = contY + 4 + list.length * LINE_H
          cardsHtml += `<text x="${x + 16}" y="${rowY + 17}" font-size="11.5" fill="#6B7280">
            ...${remain} 个未展示 · 发送 "#切换模型 下一页" 继续
          </text>`
        }
      }
    }
  }

  // 切换方式提示
  const tipsY = START_Y + cardsBodyH + 22
  let tipsHtml = `<rect x="0" y="${tipsY}" width="${W - 56}" height="${tipsH}" rx="14" fill="#FFF7ED" stroke="#FDBA74"/>`
  tipsText.forEach((t, i) => {
    tipsHtml += `<text x="20" y="${tipsY + 22 + i * 22}" font-size="13" fill="#92400E"
      font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(t)}</text>`
  })

  const bodyContent = statHtml + cardsHtml + tipsHtml
  const subtitle = `多平台模型切换助手${totalPages > 1 ? '（分页查看）' : ''}`
  const svg = wrap(W, totalBodyH, bodyContent, subtitle, pi)
  const svgPath = writeSvg(svg, `models-p${safePage}`)

  return {
    svgPath,
    pageNum: safePage,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages
  }
}

/**
 * 计算某平台的总段数（用于 #切换模型 2-3 精准跳到某页）
 */
export function countPages(providerData) {
  let segCount = 0
  for (const p of providerData) {
    const n = p.models?.length || 0
    if (!p.online || n === 0) {
      segCount += 1
    } else {
      segCount += Math.ceil(n / MODELS_PER_PAGE)
    }
  }
  return Math.max(1, Math.ceil(segCount / MAX_PLATFORMS_PER_IMAGE))
}
