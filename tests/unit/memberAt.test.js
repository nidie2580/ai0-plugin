import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseMemberMentions } from '../../src/memberAt.js'

const members = [
  { qq: '111', name: '张三' },
  { qq: '222', name: '李四' }
]

const membersWithAllName = [...members, { qq: '333', name: 'all' }]

const asText = (segs) => segs.map((s) => (s.type === 'at' ? `<at ${s.qq}>` : s.text)).join('')

describe('memberAt: 艾特全体成员', () => {
  test('@all 转成 at all', () => {
    const segs = parseMemberMentions('@all 开会了', members)
    assert.deepEqual(segs[0], { type: 'at', qq: 'all' })
    assert.equal(asText(segs), '<at all>  开会了')
  })

  test('方括号包裹 [@all] 一并去掉括号', () => {
    assert.equal(asText(parseMemberMentions('[@all] 开会了', members)), '<at all>  开会了')
    assert.equal(asText(parseMemberMentions('【@全体成员】开会了', members)), '<at all> 开会了')
  })

  test('常见别名与大小写：@ALL / @全体成员 / @所有人', () => {
    for (const s of ['@ALL 来', '@全体成员 来', '@所有人 来', '@everyone 来']) {
      const segs = parseMemberMentions(s, members)
      assert.equal(segs[0].qq, 'all', `${s} 应转 at all`)
    }
  })

  test('群成员真名是 all 时优先艾特该成员', () => {
    assert.deepEqual(parseMemberMentions('@all 你好', membersWithAllName)[0], { type: 'at', qq: '333' })
  })

  test('allowAtAll=false 时不转换', () => {
    assert.equal(parseMemberMentions('@all 开会', members, { allowAtAll: false }), null)
  })

  test('空成员列表也能艾特全体', () => {
    assert.deepEqual(parseMemberMentions('@全体成员 集合', []), [
      { type: 'at', qq: 'all' },
      { type: 'text', text: '  集合' }
    ])
  })

  test('每条回复最多生效一次全体艾特', () => {
    const segs = parseMemberMentions('@all 第一次 @all 第二次', members)
    const allCount = segs.filter((s) => s.type === 'at' && s.qq === 'all').length
    assert.equal(allCount, 1)
  })
})

describe('memberAt: 既有成员艾特行为保持', () => {
  test('@昵称 / @QQ号 命中', () => {
    assert.deepEqual(parseMemberMentions('@张三 来', members)[0], { type: 'at', qq: '111' })
    assert.deepEqual(parseMemberMentions('@222 来', members)[0], { type: 'at', qq: '222' })
  })

  test('未知 @ 原样保留', () => {
    assert.equal(parseMemberMentions('@不存在的人 你好', members), null)
  })

  test('@自己 不转换', () => {
    assert.equal(parseMemberMentions('@张三 自己', members, { selfId: '111' }), null)
  })

  test('没有 @ 返回 null', () => {
    assert.equal(parseMemberMentions('普通文本', members), null)
  })
})
