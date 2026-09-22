// Focused acceptance of the unmodified staged production client.
// Uses the exact configured deployment URL, intercepted by deterministic RPC
// fixtures. The mocked Phantom rejects its one signature request; recovery only
// reads a saved existing-asset fixture. No real wallet or blockchain submission.
// Optional: COOLBEARS_PLAYWRIGHT, COOLBEARS_ENGINE, COOLBEARS_CHROMIUM and
// COOLBEARS_BROWSER_OUTPUT, as supported by the shared matrix harness.
process.env.COOLBEARS_SCENARIO_FILTER = '^staged production bundle ';
process.env.COOLBEARS_BROWSER_OUTPUT ||= 'build/built-client-check';
await import('./devnet-matrix.browser.mjs');
