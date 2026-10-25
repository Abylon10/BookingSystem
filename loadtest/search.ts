// Search fan-out benchmark: sequential vs parallel RPC to all islands, via central.
//
//   node loadtest/search.ts --runs 20
import { parseArgs } from 'node:util';
import { loadNetwork } from '../shared/config.ts';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '20' } } });
const { central } = loadNetwork();
const runs = Number(values.runs);

async function bench(mode: 'sequential' | 'parallel') {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await (await fetch(`http://${central.host}:${central.httpPort}/api/listings?mode=${mode}`)).json();
    times.push(r.totalMs);
  }
  times.sort((a, b) => a - b);
  return { mode, runs, avgMs: Math.round(times.reduce((a, b) => a + b, 0) / runs), p95Ms: times[Math.floor(runs * 0.95) - 1] ?? times.at(-1) };
}

const seq = await bench('sequential');
const par = await bench('parallel');
console.table([seq, par]);
console.log(`Speedup: ${(seq.avgMs / Math.max(par.avgMs, 1)).toFixed(2)}x`);
