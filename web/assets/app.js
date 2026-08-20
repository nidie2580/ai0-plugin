/* global document, window, fetch */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const opts = {
    method,
    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    credentials: 'same-origin'
  }
  if (body != null) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const r = await fetch(path, opts)
  const text = await r.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (raw) return { status: r.status, ok: r.ok, data }
  return data
}

const route = document.currentScript?.dataset.route || ''

// ============== Login ==============
if (route === 'login') {
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'))
      $$('.tab-pane').forEach(p => p.classList.remove('active'))
      btn.classList.add('active')
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active')
    })
  })

  const input = $('#codeInput')
  const err = $('#err')
  input?.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6)
    err.textContent = ''
  })
  input?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin() })

  $('#loginBtn')?.addEventListener('click', doLogin)

  $('#requestCodeBtn')?.addEventListener('click', async () => {
    const msg = $('#reqCodeMsg')
    msg.textContent = '请求中…'
    try {
      const r = await api('/api/request-code', { method: 'POST' })
      if (r.ok) {
        msg.textContent = '已在终端生成验证码，请查看插件所在终端（5 分钟内有效）'
      } else {
        msg.textContent = r.msg || '请求失败'
      }
    } catch (e) {
      msg.textContent = '请求失败'
    }
    setTimeout(() => { msg.textContent = '' }, 8000)
  })

  async function doLogin() {
    const code = input.value.trim()
    if (code.length !== 6) {
      err.textContent = '请输入 6 位数字验证码'
      return
    }
    const r = await api('/api/login/code', { method: 'POST', body: { code } })
    if (r.ok) {
      location.href = '/'
    } else {
      err.textContent = r.msg || '登录失败'
    }
  }
}

// rest of file unchanged

