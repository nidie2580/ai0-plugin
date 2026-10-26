import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cfg from '../../config/index.js'

// 语音输入（ASR）回归测试
// 覆盖点：
//  - V1：helper.getVoiceSegments 从 e.message 提取 record/voice 段（file/url/path 三种来源）。
//  - V2：helper.replaceVoicePlaceholders 按顺序替换 [语音]，失败的段保留占位符。
//  - V3：asr.detectAudioFormat 按魔数识别 mp3/wav/silk/amr。
//  - V4：asr.resolveAsrConfig 读取 voiceInput.asr；禁用/缺凭据时返回 null；apiBase 复用默认模型。
//  - V5：asr.transcribeAudioBuffer 用注入的 request 验证 URL/鉴权/multipart 字段与文本解析。
//  - V6：asr.transcribeVoiceMessage 串联本地音频 → 转写，并命中短时缓存（只请求一次）。

const helper = await import('../../src/helper.js')
const asr = await import('../../src/asr.js')

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
    voiceInput: {
      enabled: true,
      asr: { apiBase: '', apiKey: '', model: 'whisper-1', language: 'zh', timeout: 60000, maxBytes: 26214400, prompt: '' },
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

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai0-asrtest-'))
const TMP_MP3 = path.join(TMP_DIR, 'voice-input.mp3')
const MP3_BUF = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.alloc(32, 0x11)])

function createTempMp3() {
  fs.writeFileSync(TMP_MP3, MP3_BUF)
}

function messageWithVoice(seg) {
  return { message: [seg], isGroup: false, groupId: 1, userId: 2 }
}

before(() => { restoreConfig(); createTempMp3() })
after(() => {
  restoreConfig()
  asr.clearTranscriptCache()
  if (fs.existsSync(TMP_MP3)) fs.unlinkSync(TMP_MP3)
  try { fs.rmdirSync(TMP_DIR) } catch (_) {}
})

describe('V1 getVoiceSegments', () => {
  it('提取 record/voice 段，兼容 data 嵌套与 url/file/path', () => {
    const e = {
      message: [
        { type: 'text', text: 'hi' },
        { type: 'record', file: 'a.silk', url: 'https://cdn.example.com/a' },
        { type: 'voice', data: { file: 'b.amr' } },
        { type: 'record', data: { url: 'https://cdn.example.com/c', path: '/tmp/c.mp3' } },
      ],
    }
    const segs = helper.getVoiceSegments(e)
    assert.equal(segs.length, 3)
    assert.equal(segs[0].url, 'https://cdn.example.com/a')
    assert.equal(segs[1].file, 'b.amr')
    assert.equal(segs[2].path, '/tmp/c.mp3')
    // 缓存：同一对象第二次返回同一数组
    assert.equal(helper.getVoiceSegments(e), segs)
  })

  it('无 message 或无关段时返回空数组', () => {
    assert.deepEqual(helper.getVoiceSegments(null), [])
    assert.deepEqual(helper.getVoiceSegments({ message: [{ type: 'text', text: 'x' }] }), [])
  })
})

describe('V2 replaceVoicePlaceholders', () => {
  it('按顺序替换，失败段保留 [语音]', () => {
    assert.equal(helper.replaceVoicePlaceholders('[语音] 和 [语音]', ['你好', '']), '你好 和 [语音]')
  })

  it('无占位符时原样返回', () => {
    assert.equal(helper.replaceVoicePlaceholders('纯文本', ['你好']), '纯文本')
    assert.equal(helper.replaceVoicePlaceholders('', ['你好']), '')
  })
})

describe('V3 detectAudioFormat', () => {
  it('识别常见容器', () => {
    assert.equal(asr.detectAudioFormat(MP3_BUF)?.ext, 'mp3')
    assert.equal(asr.detectAudioFormat(Buffer.from('RIFF....WAVEfmt ', 'latin1'))?.ext, 'wav')
    assert.equal(asr.detectAudioFormat(Buffer.from('#!SILK_V3....', 'latin1'))?.ext, 'silk')
    assert.equal(asr.detectAudioFormat(Buffer.from('#!AMR\nxxxxxxxx', 'latin1'))?.ext, 'amr')
    assert.equal(asr.detectAudioFormat(Buffer.from('not-audio!!', 'latin1')), null)
  })
})

describe('V4 resolveAsrConfig', () => {
  it('apiBase/apiKey 留空时复用默认模型，并清理完整端点', () => {
    const conf = asr.resolveAsrConfig({
      model: { default: 'x', x: { apiBase: 'https://api.openai.com/v1/audio/transcriptions', apiKey: 'k' } },
      voiceInput: { enabled: true, asr: { apiBase: '', apiKey: '', model: 'whisper-1' } },
    })
    assert.equal(conf.apiBase, 'https://api.openai.com/v1')
    assert.equal(conf.apiKey, 'k')
    assert.equal(conf.model, 'whisper-1')
    assert.equal(conf.timeout, 60000)
  })

  it('禁用或缺凭据时返回 null', () => {
    assert.equal(asr.resolveAsrConfig({ voiceInput: { enabled: false } }), null)
    assert.equal(asr.resolveAsrConfig({ voiceInput: { enabled: true, asr: {} } }), null)
  })
})

describe('V5 transcribeAudioBuffer', () => {
  it('POST /audio/transcriptions，带 Bearer 与 multipart 字段，解析 text', async () => {
    let captured = null
    const request = async (method, url, form, opts) => {
      captured = { method, url, form, opts }
      return { status: 200, data: { text: '  你好世界  ' } }
    }
    const conf = {
      apiBase: 'https://api.example.com/v1',
      apiKey: 'secret',
      model: 'whisper-1',
      timeout: 5000,
      maxBytes: 1024 * 1024,
      language: 'zh',
      prompt: '专有名词',
    }
    const r = await asr.transcribeAudioBuffer(MP3_BUF, { config: conf }, { request })
    assert.equal(r.ok, true)
    assert.equal(r.text, '你好世界')
    assert.equal(captured.method, 'post')
    assert.equal(captured.url, 'https://api.example.com/v1/audio/transcriptions')
    assert.equal(captured.opts.headers.Authorization, 'Bearer secret')
    assert.equal(captured.form.get('model'), 'whisper-1')
    assert.equal(captured.form.get('language'), 'zh')
    assert.equal(captured.form.get('response_format'), 'json')
    assert.ok(captured.form.get('file') instanceof Blob)
  })

  it('非 2xx 与空文本返回失败', async () => {
    const conf = { apiBase: 'https://api.example.com/v1', apiKey: 'k', model: 'whisper-1', timeout: 5000, maxBytes: 1024 * 1024 }
    const bad = await asr.transcribeAudioBuffer(MP3_BUF, { config: conf }, { request: async () => ({ status: 401, data: 'nope' }) })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /401/)
    const empty = await asr.transcribeAudioBuffer(MP3_BUF, { config: conf }, { request: async () => ({ status: 200, data: { text: '   ' } }) })
    assert.equal(empty.ok, false)
  })
})

describe('V6 transcribeVoiceMessage', () => {
  it('本地音频转写成功，并命中缓存只请求一次', async () => {
    let calls = 0
    const request = async () => {
      calls += 1
      return { status: 200, data: { text: '语音内容' } }
    }
    const conf = {
      apiBase: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'whisper-1',
      timeout: 5000,
      maxBytes: 1024 * 1024,
      language: 'zh',
      prompt: '',
    }
    const e = messageWithVoice({ type: 'record', path: TMP_MP3 })
    const r1 = await asr.transcribeVoiceMessage(e, { config: conf, request })
    assert.equal(r1.ok, true)
    assert.deepEqual(r1.texts, ['语音内容'])
    const r2 = await asr.transcribeVoiceMessage(messageWithVoice({ type: 'record', path: TMP_MP3 }), { config: conf, request })
    assert.equal(r2.ok, true)
    assert.deepEqual(r2.texts, ['语音内容'])
    assert.equal(calls, 1)
  })

  it('音频读取失败时返回失败且 texts 保留空位', async () => {
    const conf = { apiBase: 'https://api.example.com/v1', apiKey: 'k', model: 'whisper-1', timeout: 5000, maxBytes: 1024, language: '', prompt: '' }
    const r = await asr.transcribeVoiceMessage(messageWithVoice({ type: 'record', path: path.join(TMP_DIR, 'missing.mp3') }), { config: conf, request: async () => ({ status: 200, data: { text: 'x' } }) })
    assert.equal(r.ok, false)
    assert.deepEqual(r.texts, [''])
    assert.ok(r.errors.length > 0)
  })
})
