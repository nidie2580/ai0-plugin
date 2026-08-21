#!/usr/bin/env node

// Simple integration tests for redirect and login-code flows
import http from 'node:http'
import { safeFetchWithRedirects } from '../../src/security.js'
import { generateTerminalCode } from '../../src/auth.js'

const PORT = 30456

async function testRedirectReject() {
  console.log('Running redirect rejection test...')
  const server = http.createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { Location: 'http://127.0.0.1:65535/secret' })
      res.end()
    } else if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(PORT)
  try {
    const url = `http://127.0.0.1:${PORT}/redir`
    const r = await safeFetchWithRedirects(url, { method: 'GET' }, 3)
    if (r.ok) {
      console.error('Expected redirect to be rejected, but request succeeded')
      process.exitCode = 2
    } else {
      console.log('Redirect rejected as expected:', r.error)
    }
  } catch (e) {
    console.error('Test error:', e)
    process.exitCode = 2
  } finally {
    server.close()
  }
}

async function testTerminalCodePrinting() {
  console.log('Running terminal code generation test...')
  const res = generateTerminalCode()
  if (!res || !res.code) {
    console.error('Failed to generate terminal code')
    process.exitCode = 2
  } else {
    console.log('Generated code id:', res.id, '(code printed to terminal if TTY and/or config allows)')
  }
}

async function run() {
  await testRedirectReject()
  await testTerminalCodePrinting()
  console.log('Tests completed')
}

run()
