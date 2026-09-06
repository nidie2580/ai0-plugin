import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as cfg from '../../config/index.js'

// 点歌服务（musicService）纯逻辑测试
// 覆盖点：
//  - M1：parseQQSearchList / parseNeteaseSearchList —— 两家接口 JSON 归一化成统一歌曲对象。
//  - M2：searchSongs 注入 httpFn 走 QQ 搜索 → 返回归一化歌曲列表；注入 httpPostFn 换直链。
//  - M3：网易云风控 code≠200 → 返回明确 msg（不抛错）。
//  - M4：关键词为空/超长、结果为空等边界。
//  - M5：卡片段构造（有/无可播直链）、share 段、纯文本降级。
//  - M6：sendSongsResult 三级发送策略（fake e.reply 记录调用）。
// 全部网络通过 httpFn/httpPostFn 注入，不触网。

const music = await import('../../src/musicService.js')

const CONFIG_PATH = new URL('../../config/config.yaml', import.meta.url).pathname
const backupExists = fs.existsSync(CONFIG_PATH)
const backupContent = backupExists ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null

function writeConfig(tryPlayUrl = false) {
  const base = {
    model: {
      default: 'a',
      a: { apiBase: 'https://api.openai.com/v1', apiKey: 'test-key', model: 'gpt-a' },
    },
    chat: {
      music: {
        enabled: true,
        source: 'qq',
        maxResults: 3,
        tryPlayUrl,
        qq: { cookie: '' },
        netease: { cookie: '' },
      },
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

const qqSongJson = () => ({
  data: {
    song: {
      list: [
        {
          songname: '晴天',
          songid: 9001,
          songmid: 'mid_qt',
          albummid: '003abc',
          albumname: '叶惠美',
          interval: 269,
          singer: [{ name: '周杰伦' }],
        },
        { songname: '七里香', songmid: 'mid_qlx', singer: [{ name: '周杰伦' }] },
      ],
    },
  },
})

const neteaseSongJson = () => ({
  result: {
    songs: [
      {
        id: 186016,
        name: '晴天',
        artists: [{ name: '周杰伦' }],
        album: { name: '叶惠美', picUrl: 'https://p1.music.126.net/x/cover.jpg' },
        duration: 269000,
      },
    ],
  },
})

const vkeyOkJson = () => ({
  req_0: { data: { sip: ['https://dl.stream.qqmusic.qq.com/'], midurlinfo: [{ purl: 'C4000000.m4a?x=y' }] } },
})

before(() => writeConfig())
after(restoreConfig)

describe('parse*SearchList', () => {
  it('M1a：QQ 搜索结果归一化', () => {
    const songs = music.parseQQSearchList(qqSongJson())
    assert.equal(songs.length, 2)
    assert.deepEqual({ ...songs[0] }, {
      source: 'qq',
      id: '9001',
      songmid: 'mid_qt',
      title: '晴天',
      artist: '周杰伦',
      album: '叶惠美',
      cover: 'https://y.qq.com/music/photo_new/T002R300x300M000003abc.jpg',
      pageUrl: 'https://y.qq.com/n/ryqq/songDetail/mid_qt',
      playUrl: '',
      durationSec: 269,
    })
  })

  it('M1b：网易云搜索结果归一化（duration 毫秒转秒）', () => {
    const songs = music.parseNeteaseSearchList(neteaseSongJson())
    assert.equal(songs.length, 1)
    assert.equal(songs[0].source, 'netease')
    assert.equal(songs[0].id, '186016')
    assert.equal(songs[0].artist, '周杰伦')
    assert.equal(songs[0].durationSec, 269)
    assert.match(songs[0].cover, /^https:/)
  })

  it('M1c：空/异常结构返回空数组不抛错', () => {
    assert.deepEqual(music.parseQQSearchList({}), [])
    assert.deepEqual(music.parseNeteaseSearchList(null), [])
  })
})

describe('searchSongs', () => {
  it('M2a：QQ 源注入 httpFn，无 tryPlayUrl 时直接返回列表', async () => {
    writeConfig(false)
    const res = await music.searchSongs({ keyword: '晴天 周杰伦', httpFn: async () => qqSongJson() })
    assert.equal(res.ok, true)
    assert.equal(res.source, 'qq')
    assert.equal(res.songs[0].title, '晴天')
    assert.equal(res.songs[0].playUrl, '')
  })

  it('M2b：tryPlayUrl 开启且 vkey 返回直链 → 首条填充 playUrl（可发卡片）', async () => {
    writeConfig(true)
    const res = await music.searchSongs({
      keyword: '晴天',
      httpFn: async () => qqSongJson(),
      httpPostFn: async () => vkeyOkJson(),
    })
    assert.equal(res.ok, true)
    assert.match(res.songs[0].playUrl, /^https:\/\/dl\.stream\.qqmusic\.qq\.com\/C4000000\.m4a/)
  })

  it('M2c：网易云源注入风控返回 → ok=false 且提示填 Cookie', async () => {
    writeConfig(false)
    const res = await music.searchSongs({
      keyword: '晴天',
      source: 'netease',
      httpFn: async () => ({ code: -462 }),
    })
    assert.equal(res.ok, false)
    assert.match(res.msg, /风控/)
  })

  it('M4a：关键词为空/超长直接拒绝', async () => {
    writeConfig(false)
    const r1 = await music.searchSongs({ keyword: '  ' })
    assert.equal(r1.ok, false)
    const r2 = await music.searchSongs({ keyword: 'x'.repeat(101) })
    assert.equal(r2.ok, false)
    assert.match(r2.msg, /过长/)
  })

  it('M4b：搜索无结果给友好提示', async () => {
    writeConfig(false)
    const res = await music.searchSongs({ keyword: '不存在的歌', httpFn: async () => ({ data: { song: { list: [] } } }) })
    assert.equal(res.ok, false)
    assert.match(res.msg, /没有找到/)
  })
})

describe('buildMusicCardSegment / buildShareSegment / buildSongsText', () => {
  const playable = { pageUrl: 'https://y.qq.com/x', playUrl: 'https://cdn/x.mp3', title: '晴天', artist: '周杰伦', cover: '' }

  it('M5a：无可播直链 → 卡片段为 null', () => {
    assert.equal(music.buildMusicCardSegment({ ...playable, playUrl: '' }), null)
  })

  it('M5b：可播直链 → 返回 OneBot music 段', () => {
    const seg = music.buildMusicCardSegment(playable)
    assert.equal(seg.type, 'music')
    assert.equal(seg.data.type, 'custom')
    assert.equal(seg.data.audio, 'https://cdn/x.mp3')
  })

  it('M5c：share 段与纯文本降级内容', () => {
    const share = music.buildShareSegment(playable)
    assert.equal(share.type, 'share')
    const text = music.buildSongsText([playable], { source: 'qq' })
    assert.match(text, /晴天/)
    assert.match(text, /QQ音乐/)
    assert.match(text, /https:\/\/y\.qq\.com/)
  })
})

describe('sendSongsResult（三级发送策略）', () => {
  async function makeE() {
    const calls = []
    return { calls, e: { reply: async (m) => { calls.push(m) } } }
  }

  it('M6a：首条可播 → 发音乐卡片并返回 sentCard', async () => {
    const { calls, e } = await makeE()
    const songs = [{
      pageUrl: 'https://y.qq.com/x', playUrl: 'https://cdn/x.mp3', title: '晴天', artist: '周杰伦', cover: '',
    }]
    const res = await music.sendSongsResult(e, songs, { source: 'qq' })
    assert.equal(res.ok, true)
    assert.equal(res.sentCard, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].type, 'music')
  })

  it('M6b：无可播直链 → 降级 share 卡片', async () => {
    const { calls, e } = await makeE()
    const songs = [{ pageUrl: 'https://y.qq.com/x', playUrl: '', title: '晴天', artist: '周杰伦' }]
    const res = await music.sendSongsResult(e, songs, { source: 'qq' })
    assert.equal(res.ok, true)
    assert.equal(res.sentCard, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].type, 'share')
  })

  it('M6c：空列表 → 返回提示文本', async () => {
    const { calls, e } = await makeE()
    const res = await music.sendSongsResult(e, [], { source: 'qq' })
    assert.equal(res.ok, false)
    assert.equal(calls[0], '没有找到相关歌曲，换个关键词试试？')
  })
})
