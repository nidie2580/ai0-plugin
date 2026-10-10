import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import * as cfg from '../../config/index.js'

// 图片输入功能回归测试
// 覆盖点：
//  - G1：helper.getImageSegments 从 e.message 提取图片段（file/url/data 三种来源）。
//  - G2：helper.imageSegmentToDataUrl 把本地文件/Base64/dataURL 转成 data:image/...;base64。
//  - G3：enrichHistoryWithImages —— 主模型 vision=true 时把最后一条 user 消息改成
//        多模态数组（text + image_url）；不污染持久化 history。
//  - G4：enrichHistoryWithImages —— 主模型 vision=false + ocrToText 时调用
//        llm.transcribeImage 把图转文字再拼到 user 消息文本。
//  - G5：enrichHistoryWithImages —— imageInput.enabled=false 时不处理，history 原样返回。
//  - G6：llm.transcribeImage 在 imageInput.ocr 未配置时直接返回空串（不抛错）。

const helper = await import('../../src/helper.js')
const chatService = await import('../../src/chatService.js')
const llm = await import('../../src/llm.js')

// —— 临时改写 config.yaml，保证测试独立于用户真实配置 ——
const CONFIG_PATH = fileURLToPath(new URL('../../config/config.yaml', import.meta.url))
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(extra) {
  const base = {
    model: {
      default: 'openai-compatible',
      'openai-compatible': {
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-3.5-turbo',
        temperature: 0.8,
        maxTokens: 2000,
        timeout: 60000,
      },
    },
    chat: { groupAtReply: false, privateReply: true, triggerPrefix: [] },
    imageInput: {
      enabled: true,
      ocrToText: true,
      ocr: { apiBase: 'https://api.openai.com/v1', apiKey: 'ocr-key', model: 'gpt-4o-mini', timeout: 60000 },
    },
    ...extra,
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(base), 'utf-8')
  cfg.setForceLoad(true)
}

function restoreConfig() {
  if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  cfg.setForceLoad(false)
}

// —— 可复用小工具 ——
function pngDataUrlPayload() {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
  return 'data:image/png;base64,' + buf.toString('base64')
}

// 本地临时 PNG，供 imageSegmentToDataUrl 无网络本地解析
// 用系统临时目录动态创建（避免依赖特定环境目录导致测试失败）
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai0-imgtest-'))
const TMP_PNG = path.join(TMP_DIR, 'img-input-shared.png')
function createTempPng() {
  fs.writeFileSync(TMP_PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]))
}
function cleanupTempPng() {
  if (fs.existsSync(TMP_PNG)) fs.unlinkSync(TMP_PNG)
  try { fs.rmdirSync(TMP_DIR) } catch (_) {}
}

before(() => { restoreConfig(); createTempPng() })
after(() => { restoreConfig(); cleanupTempPng() })

describe('图片输入', () => {
  describe('G1: getImageSegments', () => {
    it('提取 text + image 混合消息中的图片段', () => {
      const e = { message: [
        { type: 'text', text: '看看这张图' },
        { type: 'image', file: '/tmp/a.png', url: 'https://x.com/a.png' },
        { type: 'at', qq: '88888' },
      ] }
      const segs = helper.getImageSegments(e)
      assert.equal(segs.length, 1)
      assert.equal(segs[0].file, '/tmp/a.png')
      assert.equal(segs[0].url, 'https://x.com/a.png')
    })

    it('提取嵌套在 data 里的 URL 字段（OneBot 风格）', () => {
      const e = { message: [
        { type: 'image', data: { status: 'ok', url: 'https://x.com/b.png', fileId: 'xyz' } },
      ] }
      const segs = helper.getImageSegments(e)
      assert.equal(segs.length, 1)
      assert.equal(segs[0].url, 'https://x.com/b.png')
    })

    it('无图片段返回空数组', () => {
      const e = { message: [{ type: 'text', text: 'hi' }] }
      assert.equal(helper.getImageSegments(e).length, 0)
    })

    it('结果缓存到 e 上，避免重复解析', () => {
      const e = { message: [{ type: 'image', url: 'https://x.com/c.png' }] }
      const a = helper.getImageSegments(e)
      const b = helper.getImageSegments(e)
      assert.equal(a, b)
    })
  })

  describe('G2: imageSegmentToDataUrl', () => {
    it('已是 data:image URL 时原样返回', async () => {
      const r = await helper.imageSegmentToDataUrl({ data: pngDataUrlPayload() })
      assert.equal(r.ok, true)
      assert.match(r.dataUrl, /^data:image\/png;base64,/)
    })

    it('纯 base64 字符串自动补前缀', async () => {
      const b64 = 'iVBORw0KGgo='
      const r = await helper.imageSegmentToDataUrl({ data: b64 })
      assert.equal(r.ok, true)
      assert.match(r.dataUrl, /^data:image\//)
      assert.match(r.dataUrl, /;base64,iVBORw0KGgo=$/)
    })

    it('本地文件路径读取并转 data URL', async () => {
      const f = path.join(TMP_DIR, 'img-input-test.png')
      fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]))
      try {
        const r = await helper.imageSegmentToDataUrl({ file: f })
        assert.equal(r.ok, true)
        assert.match(r.dataUrl, /^data:image\/png;base64,/)
      } finally {
        if (fs.existsSync(f)) fs.unlinkSync(f)
      }
    })

    it('超限的 data URL 被拒绝', async () => {
      const r = await helper.imageSegmentToDataUrl({ data: pngDataUrlPayload() }, 4)
      assert.equal(r.ok, false)
    })

    it('本地非图片文件被拒绝（防借 OCR 链路读取并外传任意文件）', async () => {
      // 2026-09 安全审查：旧实现用 `guessMimeFromBuffer(buf) || 'image/png'` 兜底，
      // 任意文件（config.yaml / sessions.key / /etc/shadow）都会被当作 PNG 送去视觉接口。
      const secret = path.join(TMP_DIR, 'not-an-image.yaml')
      fs.writeFileSync(secret, 'apiKey: sk-abcdefghijklmnopqrstuvwxyz\n', 'utf-8')
      try {
        const r = await helper.imageSegmentToDataUrl({ file: secret })
        assert.equal(r.ok, false, '非图片文件必须拒绝')
        assert.match(String(r.error), /不是可识别的图片格式/)
        const r2 = await helper.imageSegmentToDataUrl({ url: secret })
        assert.equal(r2.ok, false, '经 url 字段传入的本地非图片路径同样必须拒绝')
      } finally {
        if (fs.existsSync(secret)) fs.unlinkSync(secret)
      }
    })

    it('RIFF 魔数须含 WEBP 细标志（WAV 文件不得被误判为图片外传）', async () => {
      // 2026-10 审查修复：RIFF 容器被 WAV/AVI/WEBP 共用，仅看前 4 字节会把
      // 音频/视频判成 image/webp base64 后发给第三方接口（文件内容外传）。
      const wav = path.join(TMP_DIR, 'not-an-image.wav')
      const wavBuf = Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.from([0x24, 0x08, 0x00, 0x00]),
        Buffer.from('WAVE', 'ascii'),
        Buffer.from('data', 'ascii'),
        Buffer.from([0x10, 0x00, 0x00, 0x00]),
        Buffer.from([0x01, 0x00, 0x02, 0x00]),
      ])
      fs.writeFileSync(wav, wavBuf)
      try {
        const r = await helper.imageSegmentToDataUrl({ file: wav })
        assert.equal(r.ok, false, 'WAV 文件必须拒绝')
        assert.match(String(r.error), /不是可识别的图片格式/)
      } finally {
        if (fs.existsSync(wav)) fs.unlinkSync(wav)
      }
    })
  })

  describe('G3: vision=true 注入 image_url', () => {
    it('把最后一条 user 消息改为 text + image_url 数组', async () => {
      writeConfig({ model: { default: 'openai-compatible', 'openai-compatible': {
        apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o', vision: true } } })
      const e = { message: [
        { type: 'text', text: '看看这张图 [图片:https://x.com/a.png]' },
        { type: 'image', file: TMP_PNG },
      ] }
      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '看看这张图 [图片:https://x.com/a.png]' },
      ]
      const out = await chatService.enrichHistoryWithImages(history, e, { modelKey: 'openai-compatible' })
      assert.equal(out.length, 2)
      const last = out[1]
      assert.ok(Array.isArray(last.content))
      // 多模态数组应包含 text + image_url，且清理掉 [图片:...] 占位
      assert.ok(last.content.some(p => p.type === 'image_url' && p.image_url.url.startsWith('data:image/')))
      assert.ok(last.content.some(p => p.type === 'text' && !p.text.includes('[图片:')))
      // 原 history 不被污染
      assert.equal(typeof history[1].content, 'string')
    })

    it('图片无法解析时不注入图，回退文本链路', async () => {
      writeConfig({ model: { default: 'openai-compatible', 'openai-compatible': {
        apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o', vision: true } } })
      const e = { message: [{ type: 'image' }] } // 无 file/url/data → 解析失败
      const history = [{ role: 'system', content: 'sys' }]
      const out = await chatService.enrichHistoryWithImages(history, e, { modelKey: 'openai-compatible' })
      // 无 user 消息、无图片注入 → 直接返回原 history（角色、长度都不变）
      assert.equal(out, history)
    })
  })

  describe('G4: vision=false + ocrToText 转文字', () => {
    it('无图片段时不调用 OCR，history 原样返回', async () => {
      writeConfig({})
      const e = { message: [{ type: 'text', text: '好' }] }
      const history = [{ role: 'user', content: '好' }]
      const out = await chatService.enrichHistoryWithImages(history, e, { modelKey: 'openai-compatible' })
      assert.equal(out, history)
    })

    it('vision=false 时把 OCR 文字拼到用户消息', async () => {
      writeConfig({
        model: { default: 'openai-compatible', 'openai-compatible': {
          apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini', vision: false } },
        // OCR 配置置空 → transcribeImage 短路返回空串，避免真实网络调用
        imageInput: { enabled: true, ocrToText: true, ocr: { apiBase: '', apiKey: '', model: '' } },
      })
      const e = { message: [
        { type: 'text', text: '这里面写的是什么' },
        { type: 'image', file: TMP_PNG },
      ] }
      const history = [{ role: 'system', content: 'sys' }, { role: 'user', content: '这里面写的是什么 [图片:https://x.com/text.png]' }]
      const out = await chatService.enrichHistoryWithImages(history, e, { modelKey: 'openai-compatible' })
      const last = out[1]
      assert.equal(typeof last.content, 'string')
      // 不包含 [图片:...] 占位（已被清理）
      assert.ok(!last.content.includes('[图片:'))
      // 仅保留原有文字（OCR 结果依赖真实网络，测试不 mock，故这里只断言结构合法）
      assert.ok(last.content.includes('这里面写的是什么'))
    })
  })

  describe('G5: imageInput.enabled=false 不处理', () => {
    it('history 原样返回', async () => {
      writeConfig({ imageInput: { enabled: false, ocrToText: true } })
      const e = { message: [{ type: 'image', url: 'https://x.com/a.png' }] }
      const history = [{ role: 'user', content: '看' }]
      const out = await chatService.enrichHistoryWithImages(history, e, { modelKey: 'openai-compatible' })
      assert.equal(out, history)
    })
  })

  describe('G6: transcribeImage 未配置 OCR 安全返回', () => {
    it('ocr 未配置 apiKey/model 时返回空串', async () => {
      writeConfig({ imageInput: { enabled: true, ocrToText: true, ocr: { apiBase: '', apiKey: '', model: '' } } })
      const t = await llm.transcribeImage(pngDataUrlPayload())
      assert.equal(t, '')
    })

    it('非 data:image 输入直接返回空串', async () => {
      const t = await llm.transcribeImage('https://x.com/a.png')
      assert.equal(t, '')
    })
  })

  describe('G7: 多模型下按各模型 vision 配置注入', () => {
    it('非默认模型的 vision=true 也能拿到 image_url（此前只按默认模型判定）', async () => {
      writeConfig({ model: {
        default: 'openai-compatible',
        'openai-compatible': { apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-3.5-turbo', vision: false },
        'vlm': { apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o', vision: true },
      } })
      const e = { message: [{ type: 'image', file: TMP_PNG }] }
      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '看看这张图 [图片:https://x.com/a.png]' },
      ]
      // modelKeys=[vlm]：vlm 是 vision 模型 → 不触发 OCR，无网络调用
      const assets = await chatService.prepareImageAssets(e, { modelKeys: ['vlm'] })
      assert.ok(assets && assets.dataUrls.length === 1)
      assert.equal(assets.ocrText, '')

      const outDefault = chatService.applyImagesToHistory(history, assets, 'openai-compatible')
      assert.equal(typeof outDefault[1].content, 'string', '非 vision 模型保持文本链路')

      const outVlm = chatService.applyImagesToHistory(history, assets, 'vlm')
      const last = outVlm[1]
      assert.ok(Array.isArray(last.content), 'vision 模型应拿到多模态数组')
      assert.ok(last.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/')))
      assert.ok(last.content.some((p) => p.type === 'text' && p.text === '看看这张图'))
      // 持久化 history 不被污染
      assert.equal(typeof history[1].content, 'string')
    })
  })

  describe('G8: 艾特追问改写支持多模态数组 content', () => {
    it('数组 content 替换 text 部分、保留 image_url（此前整条跳过，追问文本丢失）', () => {
      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [
          { type: 'text', text: '/vlm 原始提问' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ] },
      ]
      const out = chatService.applyAtUserText(history, '去前缀后的追问')
      const last = out[out.length - 1]
      assert.ok(Array.isArray(last.content))
      assert.equal(last.content[0].type, 'text')
      assert.equal(last.content[0].text, '去前缀后的追问')
      assert.equal(last.content[1].type, 'image_url')
      // 原 history 不被污染
      assert.equal(history[1].content[0].text, '/vlm 原始提问')
    })

    it('字符串 content 直接替换（原行为不变）', () => {
      const history = [{ role: 'user', content: '/vlm 原始提问' }]
      const out = chatService.applyAtUserText(history, '追问')
      assert.equal(out[0].content, '追问')
    })
  })

  // —— 空图片段防线：QQ 图床下载到空响应体时，旧实现会拼出 data:image/png;base64,
  //    （前缀在、载荷为空）注入请求，上游 GLM 按 1214 "file 必须传入 file_id/file_url/file_data" 整轮 400。
  //    详见 2026-09-30 现场排查技术档。
  describe('G9: 空图片段防线（空载荷 data URL 修复）', () => {
    const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
    let server
    let baseUrl

    before(async () => {
      // 本地回环 HTTP 服务：imageSegmentToDataUrl 走 safeFetchWithRedirects（默认拒绝私有地址），
      // 测试用 security.allowPrivateHosts 显式放行 127.0.0.1
      writeConfig({ security: { allowPrivateHosts: ['127.0.0.1'] } })
      server = http.createServer((req, res) => {
        if (req.url === '/empty') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(); return }
        if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>Forbidden</body></html>'); return }
        if (req.url === '/png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG_BYTES); return }
        if (req.url === '/big') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.alloc(64, 1)); return }
        res.writeHead(404); res.end()
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`
    })

    after(async () => {
      if (server) await new Promise((resolve) => server.close(resolve))
      restoreConfig()
    })

    it('下载返回 HTTP 200 + 空 body → 拒绝（不再拼出空载荷 data URL）', async () => {
      const r = await helper.imageSegmentToDataUrl({ url: `${baseUrl}/empty` })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /空内容/)
    })

    it('下载返回 HTML 错误页（非图片魔数）→ 拒绝', async () => {
      const r = await helper.imageSegmentToDataUrl({ url: `${baseUrl}/html` })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /不是可识别的图片格式/)
    })

    it('正常 PNG 下载 → dataUrl 前缀与字节数正确', async () => {
      const r = await helper.imageSegmentToDataUrl({ url: `${baseUrl}/png` })
      assert.equal(r.ok, true)
      assert.match(r.dataUrl, /^data:image\/png;base64,/)
      assert.equal(r.bytes, PNG_BYTES.length)
      const b64 = r.dataUrl.split(',')[1]
      assert.equal(Buffer.byteLength(b64, 'base64'), PNG_BYTES.length)
    })

    it('空载荷 data URL（data:image/png;base64,）→ 拒绝', async () => {
      const r = await helper.imageSegmentToDataUrl({ data: 'data:image/png;base64,' })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /空图片/)
    })

    it('base64 字段解码后非图片 → 拒绝（去掉 || image/png 假兜底）', async () => {
      const b64 = Buffer.from('hello world, not an image').toString('base64')
      const r = await helper.imageSegmentToDataUrl({ data: b64 })
      assert.equal(r.ok, false)
      assert.match(String(r.error), /不是可识别的图片格式/)
    })

    it('超限下载仍被拒绝（回归）', async () => {
      const r = await helper.imageSegmentToDataUrl({ url: `${baseUrl}/big` }, 4)
      assert.equal(r.ok, false)
      assert.match(String(r.error), /图片过大/)
    })

    it('applyImagesToHistory 双保险：空载荷 data URL 不注入', () => {
      writeConfig({ model: { default: 'vlm9', vlm9: {
        apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o', vision: true } } })
      const history = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '看图 [图片:https://x.com/a.png]' },
      ]
      const assets = { dataUrls: ['data:image/png;base64,', pngDataUrlPayload()], ocrText: '' }
      const out = chatService.applyImagesToHistory(history, assets, 'vlm9')
      const parts = out[1].content
      assert.ok(Array.isArray(parts))
      const imgs = parts.filter((p) => p.type === 'image_url')
      assert.equal(imgs.length, 1, '空载荷段被过滤，仅注入合法图片')
      const payload = String(imgs[0].image_url.url.split(',')[1] || '')
      assert.ok(payload.length >= 16, '注入的图片必须有非空 base64 载荷')
      assert.ok(parts.some((p) => p.type === 'text' && p.text === '看图'))
    })
  })
})
