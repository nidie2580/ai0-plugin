# Pull Request: fix(security): prevent SSRF, add rate limiting, harden cookies and validate inputs

This PR implements security fixes to reduce SSRF risk, add rate limiting for sensitive endpoints, harden session cookies, guard logger usage, and validate group operation inputs.

Changes:
- Added `src/security.js` for outbound URL checks (DNS resolution + private IP blocking)
- Applied outbound URL checks in `src/helper.js`, `src/imageGen.js`, `src/llm.js`
- Added simple in-memory rate limiting middleware for sensitive web API endpoints in `src/webServer.js`
- Made session cookie use `secure` when requests indicate HTTPS or when `web.trustProxy` is enabled
- Guarded usage of `logger` in `index.js` (fallback to `console.log`)
- Added basic QQ target ID validation in `src/groupOps.js`
- Escaped dynamic content in `web/assets/app.js` (dashboard about block)

Testing steps:
1. Switch to branch `fix/security-ssrf-rate-limits` and run `npm install` then `npm run web`.
2. Verify SSRF protection: try probing a provider with apiBase pointing to `http://127.0.0.1:11434` or `http://10.0.0.5` — the probe should be rejected.
3. Verify rate limiting by sending repeated requests to `/api/providers/probe` and expect 429 after threshold.
4. Verify cookie `secure` flag when `web.trustProxy=true` and header `X-Forwarded-Proto: https` is set.
5. Verify logger fallback: run plugin without global `logger` defined — it should log version with `console.log`.

Please review and run the tests above.
