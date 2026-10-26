/**
 * loadtest/race.ts
 *
 * Last-unit race experiment: fires N walk-in booking requests at ONE island at
 * the same moment, all for the same listing and day.
 *
 * Correct behaviour: the number of successful bookings equals the number of
 * units that were available, never more (no oversell). Every other request
 * gets 409 "sold out". Exit code is 1 if an oversell happened.
 *
 *   npm run test:race -- --island higatangan --listing higatangan-sandbar-inn --clients 30
 */
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadNetwork, today } from '../shared/config.ts';

// Command-line options with sensible defaults.
const { values } = parseArgs({
  options: {
    island: { type: 'string', default: 'biliran' },
    listing: { type: 'string', default: 'biliran-lagundi-bay' },
    day: { type: 'string', default: today() },
    clients: { type: 'string', default: '50' },
  },
});

// Resolve the island's HTTP address from the network config.
const island = loadNetwork().islands.find((i) => i.id === values.island);
if (!island) throw new Error(`Unknown island ${values.island}`);
const base = `http://${island.host}:${island.httpPort}`;
const clients = Number(values.clients);

// Reads how many walk-in units the island says are left for the listing/day.
async function available(): Promise<number> {
  const state = await (await fetch(`${base}/api/state?day=${values.day}`)).json();
  return state.listings.find((l: { id: string }) => l.id === values.listing)?.walkin_available ?? 0;
}

// 1. Snapshot before the race.
const before = await available();

// 2. Fire all requests at once (Promise.all starts them together). Each has its
//    own requestId, so they are genuinely different customers, not retries.
const started = performance.now();
const results = await Promise.all(Array.from({ length: clients }, (_, i) =>
  fetch(`${base}/api/walkin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requestId: randomUUID(), listingId: values.listing, day: values.day, qty: 1,
      guestName: `Load Test ${i}`, idType: 'Test', idLast4: '0000',
    }),
  }).then((r) => r.status)));
const ms = performance.now() - started;

// 3. Snapshot after, then count outcomes by HTTP status.
const after = await available();
const ok = results.filter((s) => s === 200).length;
const soldOut = results.filter((s) => s === 409).length;

// 4. Report. More successes than units available would be an oversell.
console.table({ clients, availableBefore: before, booked: ok, soldOut, otherErrors: clients - ok - soldOut, availableAfter: after, ms: Math.round(ms) });
const oversold = ok > before;
console.log(oversold ? `❌ OVERSOLD by ${ok - before}` : '✅ No oversell');
process.exit(oversold ? 1 : 0);
