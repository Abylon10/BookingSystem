/**
 * central/reports.ts
 *
 * Data-parallel report generation with a pool of worker threads (the
 * parallel experiment in the design: speedup with 1 / 2 / 4 / 8 threads).
 *
 * The records 0..N-1 are split into equal ranges, one per thread. Each worker
 * (central/report-worker.ts) aggregates its range; the main thread merges the
 * partial totals — the merge is the sequential part in Amdahl's law.
 * Workers are started once and reused, so only the computation is timed.
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

const WORKER_URL = new URL('./report-worker.ts', import.meta.url);

type Partial = {
  records: number;
  revenueByIsland: Record<string, number>;
  bookingsByPackage: Record<string, number>;
  bookingsByMonth: number[];
  guestNights: number;
};

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

const pool: Worker[] = [];
let nextJob = 1;
const waiting = new Map<number, (r: Partial) => void>();

// Makes sure at least n workers are running (started once, then reused).
async function ensureWorkers(n: number): Promise<void> {
  while (pool.length < n) {
    const w = new Worker(WORKER_URL);
    w.on('message', (m: { id: number; result: Partial }) => {
      waiting.get(m.id)?.(m.result);
      waiting.delete(m.id);
    });
    pool.push(w);
    // Warm up: the first job loads and compiles the worker code.
    await runOn(w, 0, 1000);
  }
}

// Sends one job to one worker and resolves with its partial totals.
function runOn(w: Worker, start: number, end: number): Promise<Partial> {
  const id = nextJob++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    w.postMessage({ id, start, end });
  });
}

// Stops all workers (used by the command-line benchmark when it is done).
export async function closePool(): Promise<void> {
  await Promise.all(pool.splice(0).map((w) => w.terminate()));
}

// Merges partial totals from all workers into one report.
function merge(parts: Partial[]): Partial {
  const out: Partial = { records: 0, revenueByIsland: {}, bookingsByPackage: {}, bookingsByMonth: new Array(12).fill(0), guestNights: 0 };
  for (const p of parts) {
    out.records += p.records;
    out.guestNights += p.guestNights;
    for (const [k, v] of Object.entries(p.revenueByIsland)) out.revenueByIsland[k] = (out.revenueByIsland[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.bookingsByPackage)) out.bookingsByPackage[k] = (out.bookingsByPackage[k] ?? 0) + v;
    p.bookingsByMonth.forEach((v, m) => { out.bookingsByMonth[m] += v; });
  }
  return out;
}

// Builds the report for `records` records using `threads` worker threads.
// Returns the merged report and the time of split + parallel work + merge.
export async function parallelReport(records: number, threads: number) {
  await ensureWorkers(threads);
  const started = performance.now();
  const size = Math.ceil(records / threads);
  const parts = await Promise.all(pool.slice(0, threads).map((w, t) =>
    runOn(w, t * size, Math.min(records, (t + 1) * size))));
  const report = merge(parts);
  return { ms: performance.now() - started, report };
}

// Benchmark: same report with 1, 2, 4, 8 threads. Each setting runs `runs`
// times and keeps the best time (less noise from other programs). Speedup
// S(p) = T(1) / T(p); efficiency E(p) = S(p) / p; the parallel fraction f is
// estimated from S(p) with Amdahl's law: f = (1 - 1/S) / (1 - 1/p).
export async function benchmark(records = 4_000_000, threadCounts = [1, 2, 4, 8], runs = 3) {
  await ensureWorkers(Math.max(...threadCounts));
  const rows: { threads: number; ms: number; speedup: number; efficiency: number; parallelFraction: number | null }[] = [];
  let base = 0;
  let check = '';
  for (const threads of threadCounts) {
    let best = Infinity;
    let report: Partial | undefined;
    for (let r = 0; r < runs; r++) {
      const res = await parallelReport(records, threads);
      if (res.ms < best) { best = res.ms; report = res.report; }
    }
    // Every thread count must give exactly the same totals.
    const sig = JSON.stringify([report!.bookingsByMonth, report!.guestNights]);
    if (!check) check = sig; else if (sig !== check) throw new Error('parallel result differs from sequential');
    if (threads === threadCounts[0]) base = best;
    const speedup = base / best;
    rows.push({
      threads, ms: Math.round(best), speedup: Number(speedup.toFixed(2)),
      efficiency: Number((speedup / threads).toFixed(2)),
      parallelFraction: threads > 1 ? Number(((1 - 1 / speedup) / (1 - 1 / threads)).toFixed(3)) : null,
    });
  }
  return { records, cores: availableParallelism(), rows, resultsIdentical: true };
}
