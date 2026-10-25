// Last-unit race: N parallel walk-in requests for the same listing and day.
// Correct result: successes == units that were available, never more.
//
//   node loadtest/race.ts --island biliran --listing biliran-lagundi-bay --clients 50
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { loadNetwork, today } from '../shared/config.ts';

const { values } = parseArgs({
  options: {
    island: { type: 'string', default: 'biliran' },
    listing: { type: 'string', default: 'biliran-lagundi-bay' },
    day: { type: 'string', default: today() },
    clients: { type: 'string', default: '50' },
  },
});
const island = loadNetwork().islands.find((i) => i.id === values.island);
if (!island) throw new Error(`Unknown island ${values.island}`);
const base = `http://${island.host}:${island.httpPort}`;
const clients = Number(values.clients);

async function available(): Promise<number> {
  const state = await (await fetch(`${base}/api/state?day=${values.day}`)).json();
  return state.listings.find((l: any) => l.id === values.listing)?.walkin_available ?? 0;
}

const before = await available();
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
const after = await available();

const ok = results.filter((s) => s === 200).length;
const soldOut = results.filter((s) => s === 409).length;
console.table({ clients, availableBefore: before, booked: ok, soldOut, otherErrors: clients - ok - soldOut, availableAfter: after, ms: Math.round(ms) });
const oversold = ok > before;
console.log(oversold ? `❌ OVERSOLD by ${ok - before}` : '✅ No oversell');
process.exit(oversold ? 1 : 0);
