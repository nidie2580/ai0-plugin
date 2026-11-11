import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 必须在 import 模块前设置环境变量
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai0-ext-'))
process.env.AI0_EXTENSIONS_DIR = path.join(TMP, 'extensions')
process.env.AI0_EXTENSIONS_STATE = path.join(TMP, 'state.json')

const ext = await import('../../src/extensions.js')

function mkExt(id, manifest, files = {}) {
  const dir = path.join(process.env.AI0_EXTENSIONS_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body)
  }
}

test.before(() => {
  mkExt('hello', { id: 'hello', name: 'Hello', version: '1.0.0', main: 'index.js', web: 'web' }, { 'index.js': 'export default function () {}' })
  mkExt('broken-json', { id: 'broken-json' })
  fs.writeFileSync(path.join(process.env.AI0_EXTENSIONS_DIR, 'broken-json/manifest.json'), '{oops')
  mkExt('id-mismatch', { id: 'other', name: 'X', main: 'index.js' })
  mkExt('traversal', { id: 'traversal', name: 'T', main: '../evil.js' })
})

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) {}
})

test('validateManifest：合法 manifest 通过', () => {
  const r = ext.validateManifest({ id: 'abc', name: 'A', version: '1.0.0', main: 'index.js' }, 'abc')
  assert.equal(r.ok, true)
  assert.equal(r.manifest.id, 'abc')
})

test('validateManifest：非法 id / 目录不一致 / 路径穿越被拒', () => {
  assert.equal(ext.validateManifest({ id: 'BAD' }, 'BAD').ok, false)
  assert.equal(ext.validateManifest({ id: 'a', main: 'index.js' }, 'b').ok, false)
  assert.equal(ext.validateManifest({ id: 'abc', main: '../x.js' }, 'abc').ok, false)
  assert.equal(ext.validateManifest({ id: 'abc', main: '/etc/passwd' }, 'abc').ok, false)
  assert.equal(ext.validateManifest(null, 'abc').ok, false)
})

test('listExtensions：能识别正常/坏 manifest/目录不一致/穿越', () => {
  const list = ext.listExtensions()
  const by = Object.fromEntries(list.map((x) => [x.id, x]))
  assert.equal(by.hello.status, 'ready')
  assert.equal(by['broken-json'].status, 'broken')
  assert.match(by['broken-json'].error, /解析失败/)
  assert.equal(by['id-mismatch'].status, 'broken')
  assert.equal(by.traversal.status, 'broken')
})

test('setEnabled：停用/启用会写入状态文件', () => {
  assert.equal(ext.isEnabled('hello'), true)
  const off = ext.setEnabled('hello', false)
  assert.equal(off.ok, true)
  assert.equal(ext.isEnabled('hello'), false)
  assert.equal(ext.setEnabled('hello', true).ok, true)
  assert.equal(ext.isEnabled('hello'), true)
  assert.equal(ext.setEnabled('not-exist', true).ok, false)
})

test('listExtensions：停用后状态为 disabled', () => {
  ext.setEnabled('hello', false)
  const hello = ext.listExtensions().find((x) => x.id === 'hello')
  assert.equal(hello.enabled, false)
  assert.equal(hello.status, 'disabled')
  ext.setEnabled('hello', true)
})
