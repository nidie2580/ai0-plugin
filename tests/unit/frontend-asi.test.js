import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const appJs = path.resolve(here, '../../web/assets/app.js')

// 语句以 ( 开头时，若上一行未以 ; { } : , 或运算符结尾，JS 的自动分号插入（ASI）
// 会把两行合并成一次调用，例如：
//   const waitPane = $('#waitPane')
//   (input && input.addEventListener(...))   // ← 被解析成 $('#waitPane')(...)
// 历史回归：把 x?.m(...) 降级写成 (x && x.m(...)) 时踩中此坑，报 "$(...) is not a function"。
const SAFE_END = /[;{}:,]\s*$/
const SAFE_OP = /(=>|&&|\|\||\?\?|[+\-*/%=&|^!<>?:~])\s*$/

describe('frontend: app.js ASI 安全（以 ( 开头的语句不得与上一行合并）', () => {
  test('不存在会与上一行合并的 ( 起始语句', () => {
    const lines = fs.readFileSync(appJs, 'utf8').split('\n')
    const bad = []
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*\(/.test(lines[i])) continue
      let j = i - 1
      while (j >= 0 && (lines[j].trim() === '' || lines[j].trim().startsWith('//'))) j--
      const prev = j >= 0 ? lines[j].trim() : ''
      if (SAFE_END.test(prev) || SAFE_OP.test(prev)) continue
      bad.push(i + 1)
    }
    assert.deepEqual(bad, [], `以下行以 ( 开头且上一行未终止，会被 ASI 合并：${bad.join(', ')}`)
  })
})
