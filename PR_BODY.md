# PR: fix(security): prevent SSRF, add rate limiting, harden cookies and validate inputs

This PR implements security hardening for AI0-Plugin:

- Adds outbound URL checks (DNS lookup + private IP blocking) to prevent SSRF.
- Applies checks to image download/generation and model endpoints.
- Adds simple in-memory rate limiting for sensitive web APIs (/api/providers/probe, /api/providers/probe-all, /api/test-model, /api/test-image).
- Sets cookie secure flag when requests are over HTTPS (or when trustProxy + X-Forwarded-Proto indicates HTTPS).
- Guards logger usage; fallback to console when logger is not available.
- Validates QQ target format in group operations to avoid malformed operations.
- Minor XSS hardening on dashboard about block.

Testing steps (repeat from PR_DESCRIPTION.md):
1. Switch to branch, install deps, run web server.
2. Verify SSRF protections by trying to probe local/private IPs.
3. Verify rate limits return 429 when exceeded.
4. Verify cookies have secure when X-Forwarded-Proto=https and web.trustProxy=true.
5. Verify plugin runs without global logger.

Files changed: see branch.
