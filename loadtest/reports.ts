// Parallel report benchmark (worker threads), run on this laptop.
//
//   npm run test:reports -- --records 4000000
import { parseArgs } from 'node:util';
import { benchmark, closePool } from '../central/reports.ts';

const { values } = parseArgs({ options: { records: { type: 'string', default: '4000000' }, runs: { type: 'string', default: '3' } } });
const res = await benchmark(Number(values.records), [1, 2, 4, 8], Number(values.runs));

console.log(`Records: ${res.records.toLocaleString()} · CPU cores available: ${res.cores}`);
console.table(res.rows);
console.log('Totals identical for every thread count:', res.resultsIdentical);
const last = res.rows.at(-1)!;
const best = res.rows.reduce((a, b) => (b.speedup > a.speedup ? b : a));
console.log(`Best: ${best.speedup}× with ${best.threads} threads on ${res.cores} cores.`);
if (best.parallelFraction !== null) {
  console.log(`Amdahl estimate from that run: parallel fraction ≈ ${best.parallelFraction} → upper bound ≈ ${(1 / (1 - best.parallelFraction)).toFixed(1)}× with unlimited cores.`);
}
console.log(`With ${last.threads} threads on ${res.cores} cores: ${last.speedup}× (more threads than cores adds switching overhead).`);
await closePool();
