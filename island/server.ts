/**
 * island/server.ts
 *
 * Entry point of an island node (runs on Laptops 2-4). One process serves:
 *  - gRPC IslandService : called by central (search, register/cancel online
 *                         bookings, rebalance, ping)
 *  - HTTP API + console : used by staff on this laptop and by the staff
 *                         scanner phone on the hotspot
 *  - outbox sender      : pushes local events to central every 2 seconds
 *
 * Start with:  node island/server.ts <islandId>   (or npm run island:<id>)
 */
import express from 'express';
import { join } from 'node:path';
import { ROOT, addDays, loadNetwork, loadSeed, ticketSecret, today } from '../shared/config.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
import { openDb, seedIsland, transaction } from './db.ts';
import {
  BookingError, bookWalkin, cancelOnline, redeem, registerOnline, ticketFor, verify, type WalkinRequest,
} from './bookings.ts';

// ===========================================================================
// Startup: work out which island this process is, open its database
// ===========================================================================

// The island id comes from the command line (`node island/server.ts biliran`)
// or the ISLAND_ID environment variable.
const ISLAND_ID = process.argv[2] ?? process.env.ISLAND_ID;

// Find this island's network address and catalog. Stops the process with a
// helpful message if the id is missing or misspelled, so everything below can
// rely on `me` and `island` being defined.
const network = loadNetwork();
const seed = loadSeed();
function findIsland() {
  const me = network.islands.find((i) => i.id === ISLAND_ID);
  const island = seed.islands.find((i) => i.id === ISLAND_ID);
  if (!me || !island) {
    console.error(`Set ISLAND_ID to one of: ${network.islands.map((i) => i.id).join(', ')}`);
    process.exit(1);
  }
  return { me, island };
}
const { me, island } = findIsland();

// Open the local database, add any missing catalog rows / inventory days, and
// remember which listings belong here (used to reject other islands' tickets).
const secret = ticketSecret();
const db = openDb(island.id);
seedIsland(db, seed, island);
const listingIds = new Set(island.listings.map((l) => l.id));

// "Disconnect from Central" switch, toggled from the staff console.
// When true the island behaves as if its link to the mainland is down: it
// refuses central's RPCs and stops sending its outbox. Local staff (console and
// scanner phone) keep working normally. Used to demo partition tolerance.
let partitioned = false;

// Fake delay (ms) added to every RPC, to imitate a slow sea link. Makes the
// parallel-vs-sequential search difference visible when all processes run on
// one laptop. Set LINK_LATENCY_MS in .env; 0 means no delay.
const LINK_LATENCY_MS = Number(process.env.LINK_LATENCY_MS ?? 0);

// ===========================================================================
// gRPC: IslandService (central is the client)
// ===========================================================================

// Signature of a grpc-js unary handler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => void;

// Wraps a plain function as a gRPC handler and adds the cross-cutting rules:
//  1. while partitioned, answer UNAVAILABLE (exactly what a dead link looks like
//     to central, so its timeouts/fallbacks get exercised)
//  2. wait LINK_LATENCY_MS before answering (simulated sea link)
//  3. turn thrown errors into gRPC INTERNAL errors instead of crashing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function guarded(fn: (req: any) => unknown): Handler {
  return (rpc, cb) => {
    if (partitioned) {
      cb({ code: grpc.status.UNAVAILABLE, details: `${island.id} is partitioned` });
      return;
    }
    setTimeout(() => {
      try {
        cb(null, fn(rpc.request));
      } catch (err) {
        cb({ code: grpc.status.INTERNAL, details: (err as Error).message });
      }
    }, LINK_LATENCY_MS);
  };
}

const grpcServer = new grpc.Server();
grpcServer.addService(IslandService.service, {
  // Search fan-out: return this island's catalog. Central calls every island
  // at the same time and merges the answers.
  GetCatalog: guarded(() => ({
    island_id: island.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listings: (db.prepare('SELECT * FROM listings').all() as any[]).map((l) => ({
      ...l, island_id: island.id, facilities: JSON.parse(l.facilities),
    })),
  })),

  // Walk-in units left for one listing over a range of days.
  GetAvailability: guarded((req) => {
    const rows = db.prepare(
      `SELECT day AS date, available AS walkin_available FROM inventory
        WHERE listing_id = ? AND day >= ? AND day < ? ORDER BY day`,
    ).all(req.listing_id, req.from_date, addDays(req.from_date, req.days || 1));
    return { listing_id: req.listing_id, days: rows };
  }),

  // Central sold an online ticket for one of our listings: store it so staff
  // can look it up by its manual code. Idempotent (see registerOnline).
  RegisterOnlineBooking: guarded((req) => {
    registerOnline(db, {
      id: req.booking_id, listing_id: req.listing_id, day: req.date, nights: req.nights || 1,
      qty: req.qty, guest_name: req.guest_name, id_type: req.id_type, id_last4: req.id_last4, code: req.code,
    });
    return { ok: true, message: 'registered' };
  }),

  // Central cancelled an online booking (refund): block it from check-in.
  CancelOnlineBooking: guarded((req) => ({ ok: cancelOnline(db, req.booking_id), message: '' })),

  // Rebalance: move units between this island's walk-in pool and central's
  // online pool. "to_walkin" adds units here; "to_online" removes them (only if
  // enough are left). Central adjusts its own pool after a successful reply.
  // TODO(rebalance): store request_id so a retried transfer is not applied twice.
  TransferAllotment: guarded((req) => {
    const delta = req.direction === 'to_walkin' ? req.qty : -req.qty;
    return transaction(db, () => {
      const { changes } = db.prepare(
        'UPDATE inventory SET available = available + ? WHERE listing_id = ? AND day = ? AND available + ? >= 0',
      ).run(delta, req.listing_id, req.date, delta);
      const row = db.prepare('SELECT available FROM inventory WHERE listing_id = ? AND day = ?')
        .get(req.listing_id, req.date) as { available: number } | undefined;
      return { ok: changes === 1, walkin_available: row?.available ?? 0, message: '' };
    });
  }),

  // Health check: central uses it to see if the island is reachable.
  Ping: guarded(() => ({ island_id: island.id, server_time_ms: Date.now() })),
});

// Listen on all network interfaces so central's laptop can reach us over the hotspot.
grpcServer.bindAsync(`0.0.0.0:${me.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[${island.id}] gRPC IslandService on :${me.grpcPort}`);
});

// ===========================================================================
// Outbox sender (island -> central)
// ===========================================================================

// gRPC client for central's CentralService.
const central = new CentralService(`${network.central.host}:${network.central.grpcPort}`,
  grpc.credentials.createInsecure());

// One row of the outbox table.
interface OutboxRow {
  event_id: string;
  type: string;
  booking_id: string | null;
  payload: string;
  created_at: number;
}

// Sends up to 50 unsent events to central, oldest first, and marks the ones
// central acknowledged as sent. If central is unreachable nothing is marked,
// so the same events are retried on the next tick: nothing is ever lost.
// Central de-duplicates by event_id, so sending an event twice is harmless.
async function drainOutbox() {
  if (partitioned) return;
  const pending = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 50')
    .all() as unknown as OutboxRow[];
  if (pending.length === 0) return;

  try {
    const ack = await call<object, { accepted_event_ids: string[] }>(central, 'PushEvents', {
      events: pending.map((e) => ({
        event_id: e.event_id, island_id: island.id, type: e.type, booking_id: e.booking_id ?? '',
        payload_json: e.payload, created_at_ms: e.created_at,
      })),
    });
    const mark = db.prepare('UPDATE outbox SET sent_at = ? WHERE event_id = ?');
    for (const id of ack.accepted_event_ids) mark.run(Date.now(), id);
  } catch {
    // Central unreachable: keep the events and try again on the next tick.
  }
}
setInterval(drainOutbox, 2000);

// ===========================================================================
// HTTP: staff console (this laptop) + staff scanner phone (hotspot)
// ===========================================================================

const app = express();
app.use(express.json());
// Serves island/console/index.html, style.css and app.js at "/".
app.use(express.static(join(ROOT, 'island', 'console')));

// Turns a handler into an Express route that always answers JSON:
// the return value on success, { error } with the right status on failure.
const wrap = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
  try {
    res.json(fn(req));
  } catch (err) {
    const status = err instanceof BookingError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
};

// Dashboard data for the console: island name, partition switch, number of
// events waiting to sync, and walk-in units left per listing for one day.
app.get('/api/state', wrap((req) => {
  const day = (req.query.day as string) ?? today();
  const listings = db.prepare(
    `SELECT l.id, l.kind, l.name, l.price_php, i.available AS walkin_available
       FROM listings l LEFT JOIN inventory i ON i.listing_id = l.id AND i.day = ?`,
  ).all(day);
  const outboxPending = (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get() as { n: number }).n;
  return { island: { id: island.id, name: island.name }, day, partitioned, outboxPending, listings };
}));

// The 100 most recent bookings (walk-in and online) for the console table.
app.get('/api/bookings', wrap(() =>
  db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 100').all()));

// Face-to-face booking from the console. Returns the booking and its ticket.
app.post('/api/walkin', wrap((req) => {
  const booking = bookWalkin(db, secret, req.body as WalkinRequest);
  return { booking, ticket: ticketFor(secret, booking) };
}));

// Check-in step 1: identify a scanned QR ({ qr }) or typed code ({ code }).
app.post('/api/verify', wrap((req) => verify(db, secret, listingIds, req.body)));

// Check-in step 2: staff confirmed the ID; check the guest in (once only).
app.post('/api/redeem', wrap((req) => redeem(db, req.body.bookingId)));

// The "Disconnect from Central" switch.
app.post('/api/partition', wrap((req) => {
  partitioned = Boolean(req.body.on);
  console.log(`[${island.id}] partition ${partitioned ? 'ON — cut off from central' : 'OFF — reconnected'}`);
  return { partitioned };
}));

// Listen on all interfaces so the staff phone can reach this laptop.
app.listen(me.httpPort, '0.0.0.0', () => {
  console.log(`[${island.id}] staff console on http://localhost:${me.httpPort}`);
});
