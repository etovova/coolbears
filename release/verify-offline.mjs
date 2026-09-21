// Reproducible offline gate. This does not certify RPC access or a physical wallet.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('.', import.meta.url);
const report = { checkedAt: new Date().toISOString(), scope: 'local SDK, Core VM, journal and mocked HTTP only',
  passed: true, physicalPhantomVerified: false, liveRpcVerified: false, suites: [] };
for (const [script, artifact] of [
  ['verify-settings.mjs', 'settings'], ['verify-runtime.mjs', 'runtime'],
  ['verify-journal.mjs', 'journal'], ['verify-phantom.mjs', 'phantom-adapter'],
  ['verify-phantom-rpc.mjs', 'phantom-rpc'],
]) {
  let output = '';
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    child.on('error', error => resolve({ exitCode: null, error: String(error) }));
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  let source;
  try { source = JSON.parse(await readFile(new URL(`reports/${artifact}.json`, root))); } catch {}
  const passed = result.exitCode === 0 && source?.passed === true;
  const row = { script, report: `reports/${artifact}.json`, passed, checks: source?.checks?.length || 0, ...result };
  if (!passed) { row.error = source?.error || output.slice(-2500); report.passed = false; }
  report.suites.push(row); console.log(`${passed ? 'PASS' : 'FAIL'} ${script}: ${row.checks} checks`);
}
report.totalChecks = report.suites.reduce((n, row) => n + row.checks, 0);
await writeFile(new URL('reports/offline-gate.json', root), JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
console.log(JSON.stringify({ passed: report.passed, totalChecks: report.totalChecks, scope: report.scope }));
