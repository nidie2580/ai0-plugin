import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as cfg from '../../config/index.js'
import * as caps from '../../src/modelCapabilities.js'
import * as imageGen from '../../src/imageGen.js'
import * as videoGen from '../../src/videoGen.js'

// 模型能力作用域（scopes）回归测试
// 覆盖点：
//  - normalizeScopes：数组/字符串归一化、去重、非法值过滤、旧 vision 布尔回退
//  - validateScopes：生图/生视频互斥
//  - findGenerationProvider：按 config.model 出现顺序取第一个具备能力的平台
//  - hasScope/isChatModel/isVisionModel
//  - imageGen.buildImageContext(provider) / videoGen.buildVideoContext(provider) 按平台条目生成
//  - videoGen.generateVideo 的配置/提示词校验（不发起网络）

const chatService = await import('../../src/chatService.js')

const CONFIG_PATH = fileURLToPath(new URL('../../config/config.yaml', import.meta.url))
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(model) {
  const base = { model, chat: { groupAtReply: false, privateReply: true, triggerPrefix: [] } }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(base), 'utf-8')
  cfg.setForceLoad(true)
}

function restoreConfig() {
  if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  cfg.setForceLoad(false)
}

describe('modelCapabilities: normalizeScopes', () => {
  it('数组归一化：过滤非法值、去重、按固定顺序排列', () => {
    assert.deepEqual(caps.normalizeScopes({ scopes: ['video', 'chat', 'chat', 'bogus'] }), ['chat', 'video'])
    assert.deepEqual(caps.normalizeScopes({ scopes: ['image'] }), ['image'])
  })

  it('字符串归一化：支持逗号/空白分隔', () => {
    assert.deepEqual(caps.normalizeScopes({ scopes: 'chat, vision' }), ['chat', 'vision'])
    assert.deepEqual(caps.normalizeScopes({ scopes: 'image  video' }), ['image', 'video'])
  })

  it('缺省回退：无 scopes 时默认 chat；旧 vision:true → chat+vision', () => {
    assert.deepEqual(caps.normalizeScopes({}), ['chat'])
    assert.deepEqual(caps.normalizeScopes(null), ['chat'])
    assert.deepEqual(caps.normalizeScopes({ vision: true }), ['chat', 'vision'])
    assert.deepEqual(caps.normalizeScopes({ vision: false }), ['chat'])
  })

  it('非法/空 scopes 视为未配置，回退默认', () => {
    assert.deepEqual(caps.normalizeScopes({ scopes: [] }), ['chat'])
    assert.deepEqual(caps.normalizeScopes({ scopes: ['nope'] }), ['chat'])
  })
})

describe('modelCapabilities: validateScopes', () => {
  it('生图与生视频互斥', () => {
    const r = caps.validateScopes(['chat', 'image', 'video'])
    assert.equal(r.ok, false)
    assert.match(r.error, /同时具备/)
  })

  it('合法组合通过并保序', () => {
    const r = caps.validateScopes(['image', 'chat'])
    assert.equal(r.ok, true)
    assert.deepEqual(r.scopes, ['chat', 'image'])
  })

  it('空输入回退 chat', () => {
    assert.deepEqual(caps.validateScopes([]).scopes, ['chat'])
  })
})

describe('modelCapabilities: hasScope / isChatModel / isVisionModel', () => {
  it('按 scopes 判定能力', () => {
    const e = { scopes: ['chat', 'vision'] }
    assert.equal(caps.hasScope(e, 'chat'), true)
    assert.equal(caps.hasScope(e, 'vision'), true)
    assert.equal(caps.hasScope(e, 'image'), false)
    assert.equal(caps.isChatModel(e), true)
    assert.equal(caps.isVisionModel(e), true)
  })

  it('纯生成器（无 chat）不算对话模型', () => {
    assert.equal(caps.isChatModel({ scopes: ['image'] }), false)
    assert.equal(caps.hasScope({ scopes: ['image'] }, 'image'), true)
  })
})

describe('modelCapabilities: findGenerationProvider', () => {
  const config = {
    model: {
      default: 'a',
      a: { scopes: ['chat'], apiBase: 'https://a', apiKey: 'k' },
      b: { scopes: ['chat', 'image'], apiBase: 'https://b', apiKey: 'k' },
      c: { scopes: ['video'], apiBase: 'https://c', apiKey: 'k' },
    },
  }

  it('按出现顺序取第一个具备该能力的平台（含纯生成器）', () => {
    assert.equal(caps.findGenerationProvider(config, 'image').key, 'b')
    assert.equal(caps.findGenerationProvider(config, 'video').key, 'c')
  })

  it('无匹配返回 null；非生成能力返回 null', () => {
    assert.equal(caps.findGenerationProvider({ model: { a: { scopes: ['chat'] } } }, 'image'), null)
    assert.equal(caps.findGenerationProvider(config, 'chat'), null)
  })
})

describe('imageGen / videoGen: 平台条目上下文', () => {
  const provider = { apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'dall-e-3', imageSize: '512x512' }

  it('buildImageContext(provider) 使用平台自身模型与尺寸', () => {
    const ctx = imageGen.buildImageContext(provider)
    assert.ok(ctx)
    assert.match(ctx, /dall-e-3/)
    assert.match(ctx, /512x512/)
    assert.match(ctx, /\[action:image:/)
  })

  it('buildImageContext(provider) 配置不全时返回 null', () => {
    assert.equal(imageGen.buildImageContext({ apiBase: 'https://x', model: 'm' }), null)
  })

  it('buildVideoContext(provider) 生成视频能力上下文', () => {
    const vp = { apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'sora-1', videoSeconds: 8 }
    const ctx = videoGen.buildVideoContext(vp)
    assert.ok(ctx)
    assert.match(ctx, /sora-1/)
    assert.match(ctx, /\[action:video:/)
    assert.equal(videoGen.buildVideoContext(null), null)
    assert.equal(videoGen.buildVideoContext({ apiBase: 'https://x' }), null)
  })
})

describe('videoGen: 输入校验（不发起网络）', () => {
  it('缺少 provider 时直接报配置不完整', async () => {
    const r = await videoGen.generateVideo('a cat', {})
    assert.equal(r.ok, false)
    assert.match(r.error, /配置不完整/)
  })

  it('空提示词被拒绝', async () => {
    const r = await videoGen.generateVideo('   ', { provider: { apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'sora-1' } })
    assert.equal(r.ok, false)
    assert.match(r.error, /提示词为空/)
  })

  it('超长提示词被拒绝', async () => {
    const r = await videoGen.generateVideo('x'.repeat(4001), { provider: { apiBase: 'https://api.openai.com/v1', apiKey: 'k', model: 'sora-1' } })
    assert.equal(r.ok, false)
    assert.match(r.error, /提示词过长/)
  })
})

describe('chatService: scopes 驱动模型筛选', () => {
  before(() => {
    writeConfig({
      default: 'chat-a',
      'chat-a': { name: 'A', apiBase: 'https://a/v1', apiKey: 'k', model: 'gpt', scopes: ['chat'] },
      'vision-b': { name: 'B', apiBase: 'https://b/v1', apiKey: 'k', model: 'vl', scopes: ['chat', 'vision'] },
      'image-only': { name: 'C', apiBase: 'https://c/v1', apiKey: 'k', model: 'dall-e', scopes: ['image'] },
    })
  })
  after(restoreConfig)

  it('listConfiguredModels 只返回具备「文字对话」的平台', () => {
    const keys = chatService.listConfiguredModels()
    assert.ok(keys.includes('chat-a'))
    assert.ok(keys.includes('vision-b'))
    assert.ok(!keys.includes('image-only'))
  })

  it('isModelVision 依据 scopes 判定', () => {
    assert.equal(chatService.isModelVision('vision-b'), true)
    assert.equal(chatService.isModelVision('chat-a'), false)
  })

  it('buildAtModelIndex 排除纯生成器，避免被艾特调用', () => {
    const idx = chatService.buildAtModelIndex()
    assert.equal(idx.get('chat-a'), 'chat-a')
    assert.equal(idx.get('image-only'), undefined)
  })
})
