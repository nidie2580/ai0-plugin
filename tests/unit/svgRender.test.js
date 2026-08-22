import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const svgR = await import('../../src/svgRender.js')

describe('svgRender: esc()', () => {
  const esc = svgR.esc

  it('转义 & 为 &amp;', () => {
    assert.equal(esc('a&b'), 'a&amp;b')
  })

  it('转义 < 为 &lt;', () => {
    assert.equal(esc('a<b'), 'a&lt;b')
  })

  it('转义 > 为 &gt;', () => {
    assert.equal(esc('a>b'), 'a&gt;b')
  })

  it('转义 " 为 &quot;', () => {
    assert.equal(esc('a"b'), 'a&quot;b')
  })

  it("转义 ' 为 &#39;（防 SVG 单引号属性逃逸）", () => {
    assert.equal(esc("a'b"), 'a&#39;b')
  })

  it('转义 / 为 &#x2F;（防 </script> 标签内嵌 JSON 场景）', () => {
    assert.equal(esc('a/b'), 'a&#x2F;b')
  })

  it('组合转义', () => {
    assert.equal(esc('<script>alert("xss")&</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&amp;&lt;&#x2F;script&gt;')
  })

  it('空值返回空字符串', () => {
    assert.equal(esc(null), '')
    assert.equal(esc(undefined), '')
    assert.equal(esc(''), '')
  })

  it('非字符串转为字符串', () => {
    assert.equal(esc(123), '123')
    assert.equal(esc(true), 'true')
  })
})
