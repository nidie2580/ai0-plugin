import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

const botIdentity = await import('../../src/botIdentity.js')
const helper = await import('../../src/helper.js')

const MULTI_BOT = {
  uin: '1111',
  adapter: [
    { uin: '2222' },
    { uin: '3333' },
    { uin: '4444' }
  ]
}

describe('botIdentity 多账号身份', () => {
  describe('normalizeBotAccount', () => {
    it('抽取事件级适配器与 self_id', () => {
      const r = botIdentity.normalizeBotAccount({ self_id: '2222', adapter: 'snowluma' })
      assert.equal(r.adapter, 'snowluma')
      assert.equal(r.selfId, '2222')
      assert.equal(r.key, 'snowluma_2222')
    })

    it('适配器缺失时回退 unknown，并可从 bot.uin 取号', () => {
      const r = botIdentity.normalizeBotAccount({ bot: { uin: '3333' } })
      assert.equal(r.adapter, 'unknown')
      assert.equal(r.selfId, '3333')
    })

    it('空事件不抛错', () => {
      const r = botIdentity.normalizeBotAccount(null)
      assert.equal(r.selfId, '')
      assert.equal(r.adapter, 'unknown')
    })
  })

  describe('单账号场景', () => {
    it('未发现多账号时不注入身份块', () => {
      assert.equal(botIdentity.isMultiAccountConfigured(), false)
      assert.equal(botIdentity.buildBotIdentityContext({ self_id: '1111' }), null)
    })

    it('resolveBotIdentity 提供默认名称', () => {
      const id = botIdentity.resolveBotIdentity({ self_id: '1111', adapter: 'napcat' })
      assert.equal(id.name, 'AI助手')
      assert.equal(id.adapter, 'napcat')
      assert.equal(id.selfId, '1111')
    })

    it('单账号不对回应归属做限制', () => {
      assert.equal(botIdentity.shouldAccountRespond({ self_id: '1111' }, ['2222']), true)
    })
  })

  describe('多账号场景（运行时自动发现）', () => {
    before(() => { globalThis.Bot = MULTI_BOT })
    after(() => { delete globalThis.Bot })

    it('发现全部自身账号', () => {
      const ids = botIdentity.listSelfIds()
      for (const u of ['1111', '2222', '3333', '4444']) assert.ok(ids.includes(u), `缺少 ${u}`)
    })

    it('判定为多账号', () => {
      assert.equal(botIdentity.isMultiAccountConfigured(), true)
    })

    it('注入的身份块以"当前账号"为准并列出兄弟账号', () => {
      const ctx = botIdentity.buildBotIdentityContext(
        { self_id: '2222', adapter: 'snowluma', group_id: '999' },
        { current: { user_id: '5555', name: '张三', isBot: false } }
      )
      assert.ok(ctx, '应生成身份块')
      assert.match(ctx, /QQ=2222/)
      assert.match(ctx, /适配器=snowluma/)
      assert.match(ctx, /1111/)
      assert.match(ctx, /3333/)
      assert.match(ctx, /4444/)
      assert.match(ctx, /机器人（AI）/)
    })

    it('helper.isSelfId 把兄弟账号识别为机器人', () => {
      assert.equal(helper.isSelfId({ self_id: '1111' }, '1111'), true)
      assert.equal(helper.isSelfId({ self_id: '1111' }, '3333'), true)
      assert.equal(helper.isSelfId({ self_id: '1111' }, '9999'), false)
    })

    it('helper.listAtTargets 提取全部 @ 目标', () => {
      const e = { message: [{ type: 'at', qq: '3333' }, { type: 'text', text: '你好' }, { type: 'at', data: { qq: '4444' } }] }
      assert.deepEqual(helper.listAtTargets(e).sort(), ['3333', '4444'])
      assert.deepEqual(helper.listAtTargets({ at: '2222' }), ['2222'])
      assert.deepEqual(helper.listAtTargets(null), [])
    })

    it('@ 指定账号时仅该账号回应', () => {
      const e = (sid) => ({ self_id: sid, group_id: '999' })
      assert.equal(botIdentity.shouldAccountRespond(e('3333'), ['3333']), true)
      assert.equal(botIdentity.shouldAccountRespond(e('2222'), ['3333']), false)
      assert.equal(botIdentity.shouldAccountRespond(e('2222'), ['3333', '2222']), true)
    })

    it('未 @ 任何自身账号时仅主账号回应', () => {
      const e = (sid) => ({ self_id: sid, group_id: '999' })
      assert.equal(botIdentity.shouldAccountRespond(e('1111'), []), true)
      assert.equal(botIdentity.shouldAccountRespond(e('2222'), []), false)
      assert.equal(botIdentity.shouldAccountRespond(e('2222'), [], { primarySid: '2222' }), true)
      // 配置的主账号不在集合内时回退到第一个自身账号
      assert.equal(botIdentity.shouldAccountRespond(e('1111'), [], { primarySid: '9999' }), true)
      assert.equal(botIdentity.shouldAccountRespond(e('2222'), [], { primarySid: '9999' }), false)
    })

    it('非本插件账号不被干预', () => {
      assert.equal(botIdentity.shouldAccountRespond({ self_id: '9999', group_id: '999' }, []), true)
    })
  })
})
