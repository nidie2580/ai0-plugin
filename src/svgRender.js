/**
 * 纯 SVG 图片生成模块（零依赖，直接输出 Buffer）
 * - renderHelp：帮助菜单图片
 * - renderModelList：多 API 平台模型切换列表图片
 *
 * 说明：SVG 使用系统中文字体（PingFang SC / Microsoft YaHei），
 *       若 QQ 端无法显示 SVG（极少数），调用方仍需提供文字版 fallback。
 */

import { Buffer } from 'node:buffer'

// ================ 基础工具 ================
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 渐变定义（在 <defs> 中复用）
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

function footer(ver) {
  return `<text x="450" y="-18" text-anchor="middle" font-size="12" fill="#9CA3AF" font-family='"PingFang SC","Microsoft YaHei",system-ui,sans-serif'>
    AI0-Plugin · ${esc(ver)} · ${new Date().toLocaleString('zh-CN')}
  </text>`
}

/**
 * 构造一个标准的 SVG 容器，调用方把内容塞进 <svg>${header}${body}${footer}</svg> 里。
 * bodyHeight 是内容高度（不含 header/footer padding）
 */
function wrap(width, bodyHeight, bodyContent, subtitle) {
  const HEADER_H = 92
  const PAD = 28
  const FOOTER_H = 40
  const totalHeight = HEADER_H + PAD + bodyHeight + PAD + FOOTER_H
  const ver = 'v1.0'
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}" font-family='"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif'>
  <rect x="0" y="0" width="${width}" height="${totalHeight}" fill="url(#bg)"/>
  ${defs()}
  <!-- Header -->
  <rect x="0" y="0" width="${width}" height="${HEADER_H}" fill="url(#hdr)"/>
  <text x="32" y="42" font-size="26" font-weight="700" fill="#FFFFFF">🤖 AI0-Plugin</text>
  <text x="32" y="70" font-size="15" fill="#E0E7FF">${esc(subtitle || '')}</text>
  <!-- Version tag -->
  <rect x="${width - 120}" y="28" width="90" height="34" rx="17" fill="#ffffff22" stroke="#ffffff44"/>
  <text x="${width - 75}" y="50" text-anchor="middle" font-size="13" font-weight="600" fill="#FFFFFF">${esc(ver)}</text>

  <!-- Body -->
  <g transform="translate(${PAD},${HEADER_H + PAD})">
    ${bodyContent}
  </g>

  <!-- Footer -->
  <g transform="translate(0, ${totalHeight - 12})">
    ${footer(ver)}
  </g>
</svg>`,
    'utf-8'
  )
}

// ================ 帮助菜单渲染 ================
/**
 * sections: [{ title, lines: [ [label, desc] | string ] }]
 * label/desc 两列模式：label 是命令，desc 是说明
 */
function renderSections(sections, width) {
  const COL1 = 220   // 左列（命令）宽度
  const COL2 = width - 56 - COL1  // 右列（说明）宽度
  const LINE_H = 26
  const SEC_GAP = 18
  const SEC_TITLE_H = 34
  let y = 0
  let html = ''
  for (const sec of sections) {
    // 标题
    html += `<rect x="0" y="${y}" width="6" height="${SEC_TITLE_H}" rx="3" fill="#4F46E5"/>`
    html += `<text x="20" y="${y + 22}" font-size="17" font-weight="700" fill="#111827">${esc(sec.title)}</text>`
    y += SEC_TITLE_H
    for (const line of sec.lines) {
      if (typeof line === 'string') {
        // 单行纯文本（如说明行）
        html += `<text x="4" y="${y + 17}" font-size="13.5" fill="#4B5563">${esc(line)}</text>`
        y += LINE_H
      } else {
        const [cmd, desc] = line
        // 命令（等宽风格色块）
        html += `<rect x="0" y="${y}" width="${COL1 + 4}" height="${LINE_H - 4}" rx="6" fill="#F3F4F6" stroke="#E5E7EB"/>`
        html += `<text x="10" y="${y + 17}" font-size="13" fill="#111827" font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(cmd)}</text>`
        html += `<text x="${COL1 + 20}" y="${y + 17}" font-size="13" fill="#4B5563">${esc(desc)}</text>`
        y += LINE_H
      }
    }
    y += SEC_GAP
  }
  return { html, height: y }
}

export function renderHelp() {
  const W = 900
  const sections = [
    {
      title: '💬 对话',
      lines: [
        ['群聊 / 私聊', '群聊艾特我 / 私聊直接发消息即可对话'],
        ['全局AI开启时', '指定群号列表内，无需@机器人也会回复所有消息']
      ]
    },
    {
      title: '🔁 常用命令',
      lines: [
        ['#ai帮助', '查看此帮助菜单'],
        ['#ai新会话', '开启新的对话（清空上下文）'],
        ['#ai模型', '查看当前使用的模型配置'],
        ['#切换模型', '查看所有 API 平台及可用模型'],
        ['#切换模型 1.3', '按 平台号.模型号 切换'],
        ['#切换模型 kimi 1', '指定平台 + 编号 / 模型名切换']
      ]
    },
    {
      title: '👥 群管理（AI 驱动）',
      lines: [
        ['@机器人 禁言一下@某人 10分钟', 'AI 判定合法性后回复并执行'],
        ['@机器人 踢了@某人', '仅群主/管理员/主人可发起'],
        ['@机器人 给我个头衔 大佬', '群内所有人可自助申请头衔']
      ]
    },
    {
      title: '🎨 图片生成（网页端开启）',
      lines: [
        ['@机器人 画一只可爱的猫咪', 'AI 调用生图模型生成并发送图片'],
        ['@机器人 生成一张风景图', '支持自然语言驱动生图']
      ]
    },
    {
      title: '🌍 全局AI模式（仅主人）',
      lines: [
        ['#ai全局ai 开', '开启（当前群自动加入列表）'],
        ['#ai全局ai 关', '关闭'],
        ['#ai全局ai', '查看当前状态']
      ]
    },
    {
      title: '🌐 网页管理后台（仅主人）',
      lines: [
        ['#ai网页管理', '生成免登录一次性直链'],
        ['#ai网页启动 / 关闭', '启动/关闭网页后台'],
        ['#ai验证码', '生成 6 位终端验证码用于网页登录']
      ]
    },
    {
      title: '⚙️ 管理命令（仅主人）',
      lines: [
        ['#切换模型 [...]', '多API平台一键切换'],
        ['#ai设置模型 <名>', '修改默认平台模型ID'],
        ['#ai设置apikey <key>', '修改默认平台 API Key'],
        ['#ai设置api <URL>', '修改默认平台 apiBase'],
        ['#ai添加主人 <QQ>', '添加新主人'],
        ['#ai重载', '重新加载配置文件']
      ]
    },
    {
      title: '🔍 诊断命令',
      lines: [
        ['#ai诊断', '检查权限/主人/配置/后台（任何人可用）'],
        ['#ai测试模型 [key]', '探测 /models + 发起 /chat/completions 调用']
      ]
    },
    {
      title: '💡 小提示',
      lines: [
        '· Kimi/DeepSeek 等 apiBase 推荐写法：https://api.moonshot.cn/v1（不要写 /chat/completions，也不建议裸域名不带 /v1）',
        '· 若主人判定异常，发送 #ai诊断 可查看主人来源三列数据（框架全局 / 插件配置 / 合并后主人）',
        '· 网页管理配置 绑定 0.0.0.0 后，需放行云安全组和系统防火墙 TCP 端口'
      ]
    }
  ]
  const { html, height } = renderSections(sections, W)
  return wrap(W, height, html, '帮助菜单 · 命令速查表')
}

// ================ 切换模型列表渲染 ================
/**
 * providerData: [
 *   {
 *     key: 'kimi',
 *     idx: 1,              // 平台编号（1-based）
 *     isDefault: true,
 *     online: true,
 *     error?: string,
 *     url?: string,
 *     currentModel?: string,
 *     models: ['kimi-k2.6', ...]
 *   }, ...
 * ]
 * summary: { totalPlatforms, totalModels, defaultPlatform, defaultModel }
 */
export function renderModelList(providerData, summary) {
  const W = 960
  const CARD_HDR = 58
  const CARD_PAD = 16
  const LINE_H = 24
  const COLS = 2
  const COL_W = (W - 56 - (COLS - 1) * 16) / COLS
  const CARD_GAP = 16

  const cards = []
  for (const p of providerData) {
    const isOnline = !!p.online
    const models = p.models || []
    const modelCount = models.length
    // 每个卡片高度：头部 + 行
    const rows = Math.max(modelCount, 1)
    const contentH = rows * LINE_H + 8
    const h = CARD_HDR + CARD_PAD + contentH + 6
    cards.push({ p, h })
  }

  // 计算卡片瀑布布局（简单按列分）
  const colHeights = Array(COLS).fill(0)
  const colCards = Array.from({ length: COLS }, () => [])
  for (const c of cards) {
    // 选择当前最短列
    let col = 0
    for (let i = 1; i < COLS; i++) if (colHeights[i] < colHeights[col]) col = i
    colCards[col].push({ ...c, col, y: colHeights[col] })
    colHeights[col] += c.h + CARD_GAP
  }
  const bodyH = Math.max(...colHeights) + 24

  // 统计行
  const statHtml = `
    <rect x="0" y="0" width="${W - 56}" height="72" rx="14" fill="url(#card)" stroke="#E5E7EB" filter="url(#shadow)"/>
    <g transform="translate(24, 0)">
      <circle cx="30" cy="36" r="22" fill="#EEF2FF"/>
      <text x="30" y="42" text-anchor="middle" font-size="20">📊</text>
      <text x="64" y="28" font-size="14" fill="#6B7280">总览</text>
      <text x="64" y="52" font-size="16" font-weight="700" fill="#111827">
        ${summary?.totalPlatforms ?? 0} 个平台 · ${summary?.totalModels ?? 0} 个可用模型
      </text>
    </g>
    <g transform="translate(${W - 56 - 250}, 0)">
      <text x="0" y="28" font-size="14" fill="#6B7280">当前默认</text>
      <text x="0" y="52" font-size="15" font-weight="700" fill="#4F46E5">
        ${esc(summary?.defaultPlatform || '-')} · ${esc(summary?.defaultModel || '(未设置)')}
      </text>
    </g>
  `

  let cardsHtml = ''
  const startY = 72 + 20
  for (let col = 0; col < COLS; col++) {
    for (const c of colCards[col]) {
      const x = col * (COL_W + CARD_GAP)
      const y = startY + c.y
      const p = c.p
      const isDefault = !!p.isDefault
      const online = !!p.online
      // 卡片背景
      cardsHtml += `<rect x="${x}" y="${y}" width="${COL_W}" height="${c.h}" rx="14"
        fill="url(#card)" stroke="${isDefault ? '#A5B4FC' : '#E5E7EB'}" stroke-width="${isDefault ? '2' : '1'}" filter="url(#shadow)"/>`
      // 头部
      const statusColor = online ? '#10B981' : '#EF4444'
      const statusText = online ? '在线' : '离线'
      cardsHtml += `<circle cx="${x + 18}" cy="${y + 20}" r="6" fill="${statusColor}"/>`
      cardsHtml += `<text x="${x + 32}" y="${y + 25}" font-size="13" fill="${statusColor}" font-weight="600">${statusText}</text>`
      cardsHtml += `<text x="${x + 90}" y="${y + 26}" font-size="14" font-weight="700" fill="#111827">
        #${p.idx}. ${esc(p.key)}
      </text>`
      if (isDefault) {
        cardsHtml += `<rect x="${x + COL_W - 72}" y="${y + 12}" width="58" height="22" rx="11" fill="#EEF2FF"/>`
        cardsHtml += `<text x="${x + COL_W - 43}" y="${y + 28}" text-anchor="middle" font-size="11" font-weight="700" fill="#4F46E5">默认</text>`
      }
      // 当前模型
      const curModel = p.currentModel || '(未设置)'
      cardsHtml += `<text x="${x + 16}" y="${y + 50}" font-size="12" fill="#6B7280">当前模型:</text>`
      cardsHtml += `<text x="${x + 16 + 68}" y="${y + 50}" font-size="12.5" fill="#111827" font-weight="600"
        font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(curModel)}</text>`
      // 分隔线
      cardsHtml += `<line x1="${x + 16}" y1="${y + CARD_HDR - 4}" x2="${x + COL_W - 16}" y2="${y + CARD_HDR - 4}" stroke="#F3F4F6" stroke-width="1"/>`

      // 内容区
      const contY = y + CARD_HDR + CARD_PAD
      if (!online) {
        const err = p.error || '探测失败'
        cardsHtml += `<text x="${x + 16}" y="${contY + 18}" font-size="13" fill="#EF4444" font-weight="600">❌ ${esc(err)}</text>`
        if (p.url) {
          cardsHtml += `<text x="${x + 16}" y="${contY + 40}" font-size="11" fill="#9CA3AF">URL: ${esc(p.url.length > 48 ? p.url.slice(0, 45) + '...' : p.url)}</text>`
        }
      } else if (!models.length) {
        cardsHtml += `<text x="${x + 16}" y="${contY + 18}" font-size="13" fill="#F59E0B">⚠ 该账号未返回任何可用模型</text>`
      } else {
        // 最多画 16 个模型，超出提示
        const MAX = 16
        const list = models.slice(0, MAX)
        list.forEach((id, i) => {
          const rowY = contY + 4 + i * LINE_H
          const isCurrent = (id === p.currentModel)
          cardsHtml += `<text x="${x + 16}" y="${rowY + 17}" font-size="11.5" fill="#9CA3AF"
            font-family='ui-monospace,Menlo,Consolas,monospace'>${p.idx}.${i + 1})</text>`
          cardsHtml += `<text x="${x + 46}" y="${rowY + 17}" font-size="12.5"
            fill="${isCurrent ? '#4F46E5' : '#1F2937'}" font-weight="${isCurrent ? '700' : '400'}"
            font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(id)}${isCurrent ? ' ← 当前' : ''}</text>`
        })
        if (models.length > MAX) {
          cardsHtml += `<text x="${x + 16}" y="${contY + 4 + MAX * LINE_H + 17}"
            font-size="11.5" fill="#9CA3AF">...(${models.length - MAX} 个未展示，#切换模型 模型名 可直接切换)</text>`
        }
      }
    }
  }

  // 切换方式提示条
  const tipsY = startY + bodyH - 4
  const tipsText = [
    '切换方式：① #切换模型 1.3  → 平台 1 的第 3 个模型',
    '          ② #切换模型 kimi-k2.6  → 跨平台按名称自动匹配',
    '          ③ #切换模型 kimi 1    → 指定平台 + 编号/模型名',
    '          ④ #切换模型 kimi    → 仅切换默认平台到 kimi'
  ]
  const tipsH = tipsText.length * 22 + 20
  let tipsHtml = `<rect x="0" y="${tipsY}" width="${W - 56}" height="${tipsH}" rx="14" fill="#FFF7ED" stroke="#FDBA74"/>`
  tipsText.forEach((t, i) => {
    tipsHtml += `<text x="20" y="${tipsY + 22 + i * 22}" font-size="13" fill="#92400E"
      font-family='ui-monospace,Menlo,Consolas,monospace'>${esc(t)}</text>`
  })

  const totalBodyH = startY + bodyH + tipsH + tipsText.length * 8
  const bodyContent = statHtml + cardsHtml + tipsHtml
  return wrap(W, totalBodyH, bodyContent, '多平台模型切换助手')
}
