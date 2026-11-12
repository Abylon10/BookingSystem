/**
 * loadtest/race.ts
 *
 * Last-room race, v2: online buyers (through central: hold + pay) and walk-in
 * guests (at the island's front desk) all try to book the SAME package on the
 * SAME date at the same moment. Both channels use one inventory on the island.
 *
 * Correct behaviour: confirmed bookings never exceed what was free, and the
 * island's inventory never goes over capacity (no oversell). Exit code 1 if it does.
 *
 *   npm run test:race -- --island maripipi --package maripipi-sambawan-overnight --clients 30
 *   (add --central https://… for a cloud central; --user/--pass for the island console)
 */
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { addDays, loadNetwork, today } from '../shared/config.ts';

const { values } = parseArgs({
  options: {
    island: { type: 'string', default: 'maripipi' },
    package: { type: 'string', default: 'maripipi-sambawan-overnight' },
    day: { type: 'string', default: addDays(today(), 7) },
    clients: { type: 'string', default: '30' },
    guests: { type: 'string', default: '2' },
    central: { type: 'string' },
    user: { type: 'string' },
    pass: { type: 'string' },
    // Each client starts after a random 0..jitter ms, like real customers who
    // do not all click in the same millisecond (0 = all at exactly once).
    jitter: { type: 'string', default: '1000' },
  },
});
const jitter = Number(values.jitter);
const net = loadNetwork();
const island = net.islands.find((i) => i.id === values.island);
if (!island) throw new Error(`Unknown island ${values.island}`);
const islandUrl = `http://${island.host ?? '127.0.0.1'}:${island.httpPort}`;
const centralUrl = values.central ?? process.env.CENTRAL_URL ?? `http://${net.central.host ?? '127.0.0.1'}:${net.central.httpPort}`;
const clients = Number(values.clients);
const guests = Number(values.guests);
const json = { 'Content-Type': 'application/json' };

// 1. Sign in to the island console (or create a test admin on a fresh island).
const session = await (await fetch(`${islandUrl}/api/session`)).json();
let login;
if (session.needsSetup) {
  login = await (await fetch(`${islandUrl}/api/setup`, { method: 'POST', headers: json, body: JSON.stringify({ username: 'loadtest', password: randomUUID() }) })).json();
} else {
  if (!values.user || !values.pass) throw new Error('This island has staff accounts: pass --user and --pass');
  login = await (await fetch(`${islandUrl}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ username: values.user, password: values.pass }) })).json();
}
if (!login.token) throw new Error(`Could not sign in to the island console: ${login.error ?? 'unknown error'}`);
const desk = { ...json, Authorization: `Bearer ${login.token}` };

// Inventory of the services this package uses, for the date.
async function inventory() {
  const s = await (await fetch(`${islandUrl}/api/state?day=${values.day}&guests=${guests}`, { headers: desk })).json();
  const pkg = s.packages.find((p: { id: string }) => p.id === values.package);
  return { spots: pkg.spots as number, services: s.inventory as { id: string; capacity: number; booked: number; blocked: number }[] };
}

const before = await inventory();

// 2. Fire every client at once: even = online (hold, then pay), odd = walk-in.
const started = performance.now();
const results = await Promise.all(Array.from({ length: clients }, async (_, i) => {
  if (jitter) await new Promise((r) => setTimeout(r, Math.random() * jitter));
  if (i % 2 === 0) {
    const hold = await fetch(`${centralUrl}/api/bookings`, {
      method: 'POST', headers: { ...json, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ packageId: values.package, day: values.day, guests, guestName: `Online ${i}`, email: `online${i}@example.com`, idType: 'Passport', idLast4: '0000' }),
    });
    if (hold.status !== 201) return { channel: 'online', ok: false, status: hold.status };
    const b = await hold.json();
    const pay = await fetch(`${centralUrl}/api/bookings/${b.reference}/pay`, { method: 'POST', headers: json, body: JSON.stringify({ method: 'gcash' }) });
    return { channel: 'online', ok: pay.ok, status: pay.status };
  }
  const w = await fetch(`${islandUrl}/api/walkin`, {
    method: 'POST', headers: desk,
    body: JSON.stringify({ requestId: randomUUID(), packageId: values.package, day: values.day, guests, guestName: `Walk-in ${i}`, idType: 'PhilSys ID', idLast4: '1111' }),
  });
  return { channel: 'walk-in', ok: w.ok, status: w.status };
}));
const ms = Math.round(performance.now() - started);
const after = await inventory();

// 3. Report.
const online = results.filter((r) => r.channel === 'online');
const walkin = results.filter((r) => r.channel === 'walk-in');
const booked = results.filter((r) => r.ok).length;
const overCapacity = after.services.filter((s) => s.booked + s.blocked > s.capacity);
console.table({
  clients, 'free before (bookings)': before.spots,
  'online confirmed': online.filter((r) => r.ok).length, 'walk-in confirmed': walkin.filter((r) => r.ok).length,
  'sold out (409)': results.filter((r) => r.status === 409).length,
  'other errors': results.filter((r) => !r.ok && r.status !== 409).length,
  'free after': after.spots, ms,
});
const oversold = booked > before.spots || overCapacity.length > 0;
console.log(oversold ? `❌ OVERSOLD (${booked} booked, ${before.spots} were free)` : `✅ No oversell: ${booked} booked out of ${before.spots} free, across online + walk-in`);
process.exit(oversold ? 1 : 0);
