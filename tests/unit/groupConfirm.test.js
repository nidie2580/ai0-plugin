import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

// 群操作「同行评审」（多模型一致确认）回归测试
// 覆盖点：
//  - G1：parseGroupActions —— 只提取群操作 [action:*]，跳过 image/agent/member_list 等非评审操作；
//        recall（撤回消息）目标是无QQ目标类型，targetUid=null。
//  - G2：isGroupReviewEnabled —— 需 multiModel.enabled && multiChat!==false 且可用模型>=2 才开启。
//  - G3：评测模型不足 2 个 → 全部取消（安全优先，无真正"其他模型"可确认）。
//  - G4：参与评审模型否决(n) / 能回复但读不出 y/n(unknown) → 该操作取消。
//  - G5：全部参与评审模型一致同意(y) → ok（调用异常模型已排除，不计入投票集）。
//  - G6：评审模型调用异常 → 排除出票；仅剩的参与模型一致同意时放行；无任何参与者 → 取消。

const svc = await import('../../src/groupConfirm.js')

const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(extra) {
  const base = {
    model: {
      default: 'openai-compatible',
      'openai-compatible': { name: '默认模型', apiBase: 'https://api.openai.com/v1', apiKey: 'test-key', model: 'gpt-4' },
      'deepseek': { name: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', apiKey: 'dk', model: 'deepseek-chat' },
    },
    chat: { groupAtReply: false, privateReply: true, triggerPrefix: [] },
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

before(() => restoreConfig())
after(() => restoreConfig())

// 注入式评审调用：judgeFn(msgs, opts) → {text}
// 根据 prompt 里的 [action:*] 与目标返回值映射（用 action full 作为 key）
function makeJudgeFn(replies) {
  return async (msgs) => {
    const prompt = msgs.find((m) => m.role === 'user')?.content || ''
    const m = prompt.match(/\[action:(\w+):([^\]]*)\]/)
    const key = m ? m[0] : ''
    const text = replies[key] ?? 'y'
    return { text, ok: true }
  }
}

describe('群操作同行评审', () => {
  describe('G1: parseGroupActions', () => {
    it('仅提取群操作，跳过 image/agent', () => {
      const out = svc.parseGroupActions('你好 [action:ban:12345:60] 生成 [action:image:prompt] 跑agent [action:agent:task]')
      assert.deepEqual(
        out.map((o) => o.type),
        ['ban']
      )
      assert.equal(out[0].targetUid, '12345')
      assert.equal(out[0].args.join(':'), '12345:60')
    })

    it('无目标类型操作 targetUid 为 null', () => {
      const out = svc.parseGroupActions('[action:mute_all:10]')
      assert.equal(out[0].targetUid, null)
    })

    it('recall（撤回消息）属于无目标类型，targetUid 为 null 且可被评审解析', () => {
      const out = svc.parseGroupActions('撤回它 [action:recall:889988998899]')
      assert.equal(out.length, 1)
      assert.equal(out[0].type, 'recall')
      assert.equal(out[0].targetUid, null)
      assert.equal(out[0].args.join(':'), '889988998899')
    })
  })

  describe('G2: isGroupReviewEnabled', () => {
    it('multiModel 关闭时不启用', () => {
      writeConfig()
      assert.equal(svc.isGroupReviewEnabled(), false)
    })

    it('multiModel.enabled 且 multiChat=true 且 >=2 模型时启用', () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      assert.equal(svc.isGroupReviewEnabled(), true)
    })

    it('multiChat=false 时不启用', () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: false } } })
      assert.equal(svc.isGroupReviewEnabled(), false)
    })

    it('groupConfirm=false 时不启用（显式关闭）', () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true, groupConfirm: false } } })
      assert.equal(svc.isGroupReviewEnabled(), false)
    })
  })

  describe('G3: 评审模型不足 → 取消', () => {
    it('单模型时不放行高风险群操作', async () => {
      writeConfig({ model: { default: 'openai-compatible', 'openai-compatible': { name: 'A', apiBase: 'https://a/v1', apiKey: 'k', model: 'm' } } })
      const r = await svc.reviewGroupActions({ replyText: '[action:ban:123:60]', groupId: '1', userText: 'hi' })
      assert.equal(r.verdicts.length, 1)
      assert.equal(r.verdicts[0].ok, false)
      assert.match(r.verdicts[0].reasons.join(';'), /评审模型不足/)
    })
  })

  describe('G4: 任一模型否决/无法解析/出错 → 取消', () => {
    it('某模型否决则取消', async () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      const r = await svc.reviewGroupActions({ replyText: '[action:ban:123:60]', groupId: '1', userText: 'hi', judgeFn: makeJudgeFn({ '[action:ban:123:60]': 'n' }) })
      assert.equal(r.verdicts[0].ok, false)
      assert.match(r.verdicts[0].reasons.join(';'), /否决/)
    })

    it('模型未返回明确 y/n 视为取消', async () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      const r = await svc.reviewGroupActions({ replyText: '[action:ban:123:60]', groupId: '1', userText: 'hi', judgeFn: makeJudgeFn({ '[action:ban:123:60]': '我不确定' }) })
      assert.equal(r.verdicts[0].ok, false)
      assert.match(r.verdicts[0].reasons.join(';'), /未明确/)
    })

  })

  describe('G5: 全部一致同意 → ok', () => {
    it('所有评审模型都返回 y 则放行', async () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      const r = await svc.reviewGroupActions({ replyText: '[action:ban:123:60]', groupId: '1', userText: 'hi', judgeFn: makeJudgeFn({ '[action:ban:123:60]': 'y' }) })
      assert.equal(r.verdicts.length, 1)
      assert.equal(r.verdicts[0].ok, true)
      assert.match(r.verdicts[0].reasons.join(';'), /一致同意/)
    })
  })

  describe('G6: 评审模型调用异常 → 排除出票', () => {
    // judgeFn 通过 opts.modelKey 区分模型：deepseek 抛异常，openai-compatible 正常投票
    const partialBoom = (replies) => async (msgs, opts) => {
      if (opts?.modelKey === 'deepseek') throw new Error('boom')
      const prompt = msgs.find((m) => m.role === 'user')?.content || ''
      const m = prompt.match(/\[action:(\w+):([^\]]*)\]/)
      return { text: replies[m ? m[0] : ''] ?? 'y', ok: true }
    }

    it('部分模型异常 + 剩余模型全部 y → 放行（排除出票不计票）', async () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      const r = await svc.reviewGroupActions({ replyText: '[action:ban:123:60]', groupId: '1', userText: 'hi', judgeFn: partialBoom({ '[action:ban:123:60]': 'y' }) })
      assert.equal(r.verdicts[0].ok, true)
      assert.match(r.verdicts[0].reasons.join(';'), /一致同意/)
      assert.match(r.verdicts[0].reasons.join(';'), /1 个调用异常模型已排除出票/)
    })

    it('部分模型异常 + 剩余模型否决 → 取消', async () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      const r = await svc.reviewGroupActions({ replyText: '[action:ban:123:60]', groupId: '1', userText: 'hi', judgeFn: partialBoom({ '[action:ban:123:60]': 'n' }) })
      assert.equal(r.verdicts[0].ok, false)
      assert.match(r.verdicts[0].reasons.join(';'), /否决/)
      assert.match(r.verdicts[0].reasons.join(';'), /已排除出票/)
    })

    it('全部模型调用异常（无参与者）→ 取消', async () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      const boom = async () => { throw new Error('boom') }
      const r = await svc.reviewGroupActions({ replyText: '[action:ban:123:60]', groupId: '1', userText: 'hi', judgeFn: boom })
      assert.equal(r.verdicts[0].ok, false)
      assert.match(r.verdicts[0].reasons.join(';'), /全部调用异常，无参与者可确认/)
    })

    it('recall 操作同样参与评审（异常排除、参与需全 y）', async () => {
      writeConfig({ chat: { multiModel: { enabled: true, multiChat: true } } })
      const r = await svc.reviewGroupActions({ replyText: '[action:recall:889988998899]', groupId: '1', userText: '撤回那条', judgeFn: makeJudgeFn({ '[action:recall:889988998899]': 'y' }) })
      assert.equal(r.verdicts[0].type, 'recall')
      assert.equal(r.verdicts[0].ok, true)
    })
  })
})
