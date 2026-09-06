import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

// 多模型协同（讨论收敛）纯逻辑测试
// 覆盖点：
//  - D1：parseVerdict —— 识别末尾「结论 同意编号k / 结论 不同意」，并剥离表决行。
//  - D2：单模型直接返回独立首答（不走讨论）。
//  - D3：Round≥2 过半同意同一编号 → 收敛，采用对应版本为统一回复。
//  - D4：达 maxRounds 仍未收敛 → 主持人(llmCall 注入)综合成统一回复。
//  - D5：全部模型首轮调用失败 → ok=false，不产出结论。
// llmCall 全部注入 fake，不触网、不依赖真实模型。

const deliberate = await import('../../src/deliberate.js')

const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig() {
  const base = {
    model: {
      default: 'a',
      a: { apiBase: 'https://api.openai.com/v1', apiKey: 'test-key', name: '模型A', model: 'gpt-a', temperature: 0.8, maxTokens: 2000, timeout: 60000 },
      b: { apiBase: 'https://api.openai.com/v1', apiKey: 'test-key', name: '模型B', model: 'gpt-b', temperature: 0.8, maxTokens: 2000, timeout: 60000 },
      c: { apiBase: 'https://api.openai.com/v1', apiKey: 'test-key', name: '模型C', model: 'gpt-c', temperature: 0.8, maxTokens: 2000, timeout: 60000 },
    },
    chat: {
      multiModel: { enabled: true, multiChat: true, groupConfirm: true, atModel: true, deliberate: true, maxRounds: 3, judgeModel: 'a' },
    },
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(base), 'utf-8')
  cfg.setForceLoad(true)
}

function restoreConfig() {
  if (backupExists) fs.writeFileSync(CONFIG_PATH, backupContent, 'utf-8')
  else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  cfg.setForceLoad(false)
}

before(writeConfig)
after(restoreConfig)

describe('parseVerdict', () => {
  it('识别「结论 同意编号k」并把表决行从正文剥离', () => {
    const { agree, disagree, body } = deliberate.parseVerdict('我认为B方案更严谨。\n结论 同意编号2')
    assert.equal(agree, 1)
    assert.equal(disagree, false)
    assert.equal(body, '我认为B方案更严谨。')
  })

  it('识别「结论 不同意」并保留修订正文', () => {
    const { agree, disagree, body } = deliberate.parseVerdict('我给出修订版：晴天是周杰伦专辑叶惠美中的歌。\n结论 不同意')
    assert.equal(agree, null)
    assert.equal(disagree, true)
    assert.match(body, /修订版/)
  })

  it('正文中偶尔出现「不同意」但不位于末行时不误判', () => {
    const text = '我不太同意前面那句，但整体可以采纳。\n补充一点理由。\n结论 同意编号1'
    const { agree, body } = deliberate.parseVerdict(text)
    assert.equal(agree, 0)
    assert.match(body, /补充一点理由/)
  })

  it('没有表决行时原样返回正文', () => {
    const { agree, disagree, body } = deliberate.parseVerdict('只是普通的一段回答。')
    assert.equal(agree, null)
    assert.equal(disagree, false)
    assert.equal(body, '只是普通的一段回答。')
  })
})

// 构造按"轮次+模型"返回固定文本的 fake llmCall
function scriptedLlm(script) {
  return async (messages, opts) => {
    const modelKey = opts.modelKey
    const last = messages[messages.length - 1]
    const user = last && last.content
    if (typeof user === 'string' && user.includes('下面是团队中')) {
      const t = script.r2 && script.r2[modelKey]
      if (t != null) return { text: t }
    }
    if (typeof user === 'string' && user.includes('各模型讨论观点')) {
      return { text: script.judge || '' }
    }
    const t = script.r1 && script.r1[modelKey]
    if (t != null) return { text: t }
    throw new Error('unexpected llmCall in scriptedLlm')
  }
}

describe('runDeliberation', () => {
  it('单模型：不讨论，直接返回独立首答', async () => {
    const fake = scriptedLlm({
      r1: { a: '单模型回答内容。' },
      judge: '',
    })
    const res = await deliberate.runDeliberation({ question: '测试问题', modelKeys: ['a'], llmCall: fake })
    assert.equal(res.ok, true)
    assert.equal(res.finalText, '单模型回答内容。')
    assert.equal(res.rounds.length, 1)
  })

  it('三模型第二轮过半同意编号2 → 收敛并采用该版本', async () => {
    const fake = scriptedLlm({
      r1: {
        a: 'A 的初始观点。',
        b: 'B 的初始观点（最完整）。',
        c: 'C 的初始观点。',
      },
      r2: {
        a: '我认同 B 的分析。\n结论 同意编号2',
        b: 'B 修订版观点，更完善。\n结论 不同意',
        c: 'B 说得对，我附议。\n结论 同意编号2',
      },
      judge: '',
    })
    const res = await deliberate.runDeliberation({ question: '什么歌适合雨天？', modelKeys: ['a', 'b', 'c'], llmCall: fake })
    assert.equal(res.ok, true)
    assert.equal(res.converged, true)
    assert.equal(res.chosenModelKey, 'b')
    assert.match(res.finalText, /修订版/)
    assert.equal(res.rounds.length, 2)
  })

  it('达 maxRounds 仍未收敛 → 主持人综合成统一回复', async () => {
    const fake = scriptedLlm({
      r1: { a: 'A 观点。', b: 'B 观点。', c: 'C 观点。' },
      r2: { a: 'A 修订。\n结论 不同意', b: 'B 修订。\n结论 不同意', c: 'C 修订。\n结论 不同意' },
      judge: '主持人的统一综合答案。',
    })
    const res = await deliberate.runDeliberation({ question: '测试', modelKeys: ['a', 'b', 'c'], maxRounds: 2, llmCall: fake })
    assert.equal(res.ok, true)
    assert.equal(res.converged, false)
    assert.equal(res.finalText, '主持人的统一综合答案。')
    assert.equal(res.rounds.length, 2)
  })

  it('全部模型首轮调用失败 → ok=false，不产出结论', async () => {
    const boom = async () => { throw new Error('api down') }
    const res = await deliberate.runDeliberation({ question: '测试', modelKeys: ['a', 'b', 'c'], llmCall: boom })
    assert.equal(res.ok, false)
    assert.equal(res.converged, false)
    assert.match(res.msg, /首轮均调用失败/)
  })

  it('参与模型为空/问题为空直接返回错误', async () => {
    const empty1 = await deliberate.runDeliberation({ question: '', modelKeys: ['a'], llmCall: () => ({ text: '' }) })
    assert.equal(empty1.ok, false)
    const empty2 = await deliberate.runDeliberation({ question: 'x', modelKeys: [], llmCall: () => ({ text: '' }) })
    assert.equal(empty2.ok, false)
  })
})
