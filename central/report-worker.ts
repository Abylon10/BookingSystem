/**
 * central/report-worker.ts
 *
 * One worker thread of the parallel report pool. It stays alive and handles
 * jobs: each job is a range of record numbers [start, end). The worker
 * generates those booking records deterministically (same number -> same
 * record, on any thread) and aggregates them:
 *   revenue per island, bookings per package, bookings per month, guest-nights.
 * Only the small totals are sent back, so the work is pure CPU in parallel.
 */
import { parentPort } from 'node:worker_threads';

interface Job { id: number; start: number; end: number }

// The catalog the synthetic records are drawn from: [island, package, price].
const PACKAGES: [string, string, number, boolean][] = [
  ['biliran', 'biliran-falls-day', 950, false], ['biliran', 'biliran-lagundi-2d1n', 4200, true],
  ['maripipi', 'maripipi-sambawan-day', 1500, false], ['maripipi', 'maripipi-sambawan-overnight', 3500, true],
  ['higatangan', 'higatangan-sandbar-day', 800, false], ['higatangan', 'higatangan-escape-2d1n', 3200, true],
];
const ISLANDS = ['biliran', 'maripipi', 'higatangan'];

// Small fast hash -> pseudo-random number in [0, 1) for record i, salt k.
function rand(i: number, k: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Aggregates records start..end-1 (arrays instead of objects in the hot loop).
export function aggregate(start: number, end: number) {
  const revenue = new Float64Array(PACKAGES.length);
  const count = new Float64Array(PACKAGES.length);
  const byMonth = new Array<number>(12).fill(0);
  let guestNights = 0;

  for (let i = start; i < end; i++) {
    const p = Math.floor(rand(i, 1) * PACKAGES.length);
    const multiNight = PACKAGES[p][3];
    const guests = 1 + Math.floor(rand(i, 3) * 4);
    const nights = multiNight ? 1 + Math.floor(rand(i, 4) * 3) : 1;
    revenue[p] += PACKAGES[p][2] * (rand(i, 5) < 0.2 ? 0.9 : 1);
    count[p]++;
    byMonth[Math.floor(rand(i, 2) * 12)]++;
    guestNights += guests * nights;
  }

  const revenueByIsland: Record<string, number> = Object.fromEntries(ISLANDS.map((x) => [x, 0]));
  const bookingsByPackage: Record<string, number> = {};
  PACKAGES.forEach(([island, pkg], p) => {
    revenueByIsland[island] += revenue[p];
    bookingsByPackage[pkg] = count[p];
  });
  return { records: end - start, revenueByIsland, bookingsByPackage, bookingsByMonth: byMonth, guestNights };
}

// Worker loop: answer every job with its partial totals.
parentPort?.on('message', (job: Job) => {
  parentPort!.postMessage({ id: job.id, result: aggregate(job.start, job.end) });
});
