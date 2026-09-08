import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

// 深度思考全局开关（response.deepThink）纯逻辑测试
// 覆盖点：
//  - global-on：response.deepThink=true → 所有模型（含未配置 thinking 的模型）都视为深度思考。
//  - global-off：response.deepThink=false → 即使旧 per-model thinking=true 也被强制关闭。
//  - legacy-fallback：response.deepThink 未配置 → 回退读旧版 model.<key>.thinking（向后兼容）。
//  - timeout：全局 deepThinkTimeout 优先；未配回退 per-model thinkingTimeout / timeout，兜底 ≥180s。

const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(modelExtra = {}, responseExtra = {}) {
  const base = {
    model: {
      default: 'a',
      a: {
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-a',
        timeout: 60000,
        ...modelExtra,
      },
    },
    response: { ...responseExtra },
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(base), 'utf-8')
  cfg.setForceLoad(true)
}

function restoreConfig() {
  if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  cfg.setForceLoad(false)
}

describe('config: getDeepThinkConfig 深度思考全局开关', () => {
  before(() => restoreConfig())
  after(() => restoreConfig())

  it('全局 deepThink=true → 所有模型都启用（未配 thinking 的模型也生效）', () => {
    writeConfig({}, { deepThink: true, deepThinkTimeout: 250000 })
    const r = cfg.getDeepThinkConfig('a')
    assert.equal(r.enabled, true)
    assert.equal(r.timeout, 250000)
    // 任意其他 key 也生效（全局）
    assert.equal(cfg.getDeepThinkConfig('nonexistent').enabled, true)
  })

  it('全局 deepThink=false → 强制关闭，覆盖旧 per-model thinking', () => {
    writeConfig({ thinking: true, thinkingTimeout: 200000 }, { deepThink: false })
    const r = cfg.getDeepThinkConfig('a')
    assert.equal(r.enabled, false)
  })

  it('全局未配置 → 回退读旧 per-model thinking', () => {
    writeConfig({ thinking: true, thinkingTimeout: 200000 }, {})
    const r = cfg.getDeepThinkConfig('a')
    assert.equal(r.enabled, true)
    assert.equal(r.timeout, 200000)
    // 未配置思考模型 → 不启用
    writeConfig({}, {})
    assert.equal(cfg.getDeepThinkConfig('a').enabled, false)
  })

  it('全局 deepThink=true 且未配 deepThinkTimeout → 回退 per-model thinkingTimeout，兜底 ≥180s', () => {
    writeConfig({ thinkingTimeout: 220000 }, { deepThink: true })
    const r = cfg.getDeepThinkConfig('a')
    assert.equal(r.enabled, true)
    assert.equal(r.timeout, 220000)
    // 无任何超时配置 → 兜底 180s
    writeConfig({}, { deepThink: true })
    assert.equal(cfg.getDeepThinkConfig('a').timeout, 180000)
  })
})
