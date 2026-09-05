import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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
const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
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
const TMP_PNG = '/tmp/opencode/img-input-shared.png'
function createTempPng() {
  fs.writeFileSync(TMP_PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]))
}
function cleanupTempPng() {
  if (fs.existsSync(TMP_PNG)) fs.unlinkSync(TMP_PNG)
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
      const f = '/tmp/opencode/img-input-test.png'
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
})
