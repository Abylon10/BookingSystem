/**
 * loadtest/search.ts
 *
 * Search fan-out benchmark: compares asking the islands one after another
 * (sequential) with asking them all at once (parallel), through central.
 *
 * Expected: sequential ≈ sum of island latencies, parallel ≈ the slowest
 * island, so the speedup approaches the number of islands (3).
 * Set LINK_LATENCY_MS (e.g. 150) on the islands to simulate the sea link.
 *
 *   npm run test:search -- --runs 20
 */
import { parseArgs } from 'node:util';
import { loadNetwork } from '../shared/config.ts';

// Number of searches per mode; more runs = more stable averages.
const { values } = parseArgs({ options: { runs: { type: 'string', default: '20' } } });
const { central } = loadNetwork();
const runs = Number(values.runs);

// Runs `runs` searches in one mode and returns average and 95th-percentile
// time. Uses fanoutMs, measured by central itself: only the time spent calling
// the islands, without HTTP overhead to this script or the Supabase lookups
// (those cost the same in both modes and would hide the parallel speedup).
async function bench(mode: 'sequential' | 'parallel') {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await (await fetch(`http://${central.host}:${central.httpPort}/api/listings?mode=${mode}`)).json();
    times.push(r.fanoutMs);
  }
  times.sort((a, b) => a - b);
  const avgMs = Math.round(times.reduce((a, b) => a + b, 0) / runs);
  const p95Ms = times[Math.max(0, Math.ceil(runs * 0.95) - 1)];
  return { mode, runs, avgMs, p95Ms };
}

// Run both modes and print a table plus the speedup factor for the report.
const seq = await bench('sequential');
const par = await bench('parallel');
console.table([seq, par]);
console.log(`Speedup: ${(seq.avgMs / Math.max(par.avgMs, 1)).toFixed(2)}x`);
