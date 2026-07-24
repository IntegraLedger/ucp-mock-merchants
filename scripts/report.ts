// Run the conformance report — for Fisher's dev environment / CI.
//
//   pnpm report                          # in-process, all merchants
//   pnpm report https://<host>/homegoods # against a live merchant URL
//
// Exits non-zero if any merchant fails a check (so CI goes red).

import app from '../src/index.js';
import { runReport, type FetchLike } from '../src/report.js';
import { MERCHANT_IDS } from '../src/merchants.js';

const inproc: FetchLike = async (url, init) => app.fetch(new Request(url, init));

async function main(): Promise<void> {
  const arg = process.argv[2];
  const isUrl = !!arg && (arg.startsWith('http://') || arg.startsWith('https://'));
  const fetchLike: FetchLike = isUrl ? (u, i) => fetch(u, i) : inproc;
  const bases = isUrl ? [arg!.replace(/\/+$/, '')] : MERCHANT_IDS.map((id) => `https://mock.local/${id}`);

  let failed = 0;
  for (const base of bases) {
    const r = await runReport({ merchantBase: base, fetch: fetchLike, ranAt: new Date().toISOString() });
    console.log(`\n${r.ok ? '✓' : '✗'} ${r.merchant} — ${r.passed}/${r.checks.length} checks passed  (${base})`);
    for (const c of r.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${failed === 0 ? 'ALL MERCHANTS PASSED' : failed + ' MERCHANT(S) FAILED'}`);
  if (failed) process.exitCode = 1;
}

void main();
