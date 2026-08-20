# PR: follow-up security enhancements

This update implements the following follow-ups requested:

- Allow redirects but validate each redirect Location before following it (limit default to 3 hops). Previously redirects were rejected outright; now we perform validation on Location and follow only when the target is allowed.
- Add helper functions safeFetchWithRedirects and safeAxiosRequest to centralize redirect-safe outbound requests.
- Add a simple integration test script tests/integration/run_integration_tests.js that validates redirect rejection and terminal code generation behavior.

Please run `node tests/integration/run_integration_tests.js` locally (after installing dependencies) to execute the simple integration checks.
