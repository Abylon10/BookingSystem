import express from 'express';
import { join } from 'node:path';
import { ROOT, addDays, loadNetwork, loadSeed, ticketSecret } from '../shared/config.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
import { openDb, seedIsland, transaction } from './db.ts';
import { BookingError, bookWalkin, cancelOnline, redeem, registerOnline, ticketFor, verify } from './bookings.ts';

// `node island/server.ts biliran` or ISLAND_ID=biliran
const ISLAND_ID = process.argv[2] ?? process.env.ISLAND_ID;
const network = loadNetwork();
const seed = loadSeed();
const me = network.islands.find((i) => i.id === ISLAND_ID);
const island = seed.islands.find((i) => i.id === ISLAND_ID);
if (!me || !island) {
  console.error(`Set ISLAND_ID to one of: ${network.islands.map((i) => i.id).join(', ')}`);
  process.exit(1);
}
const secret = ticketSecret();
const db = openDb(island.id);
seedIsland(db, seed, island);
const listingIds = new Set(island.listings.map((l) => l.id));

// "Disconnect from Central" toggle: simulates this island losing its mainland link.
// Local staff (console + scanner phone) keep working; only central traffic stops.
let partitioned = false;

// Fake island-to-mainland link latency (ms) so the parallel vs sequential search
// difference is visible even when everything runs on one laptop.
const LINK_LATENCY_MS = Number(process.env.LINK_LATENCY_MS ?? 0);

// ---------- gRPC: IslandService (central is the client) ----------

type Handler = (call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => void;

function guarded(fn: (req: any) => unknown): Handler {
  return (rpc, cb) => {
    if (partitioned) {
      cb({ code: grpc.status.UNAVAILABLE, details: `${island!.id} is partitioned` });
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
  GetCatalog: guarded(() => ({
    island_id: island.id,
    listings: (db.prepare('SELECT * FROM listings').all() as any[]).map((l) => ({
      ...l, island_id: island.id, facilities: JSON.parse(l.facilities),
    })),
  })),
  GetAvailability: guarded((req) => {
    const rows = db.prepare(
      'SELECT day AS date, available AS walkin_available FROM inventory WHERE listing_id = ? AND day >= ? AND day < ? ORDER BY day',
    ).all(req.listing_id, req.from_date, addDays(req.from_date, req.days || 1));
    return { listing_id: req.listing_id, days: rows };
  }),
  RegisterOnlineBooking: guarded((req) => {
    registerOnline(db, {
      id: req.booking_id, listing_id: req.listing_id, day: req.date, nights: req.nights || 1,
      qty: req.qty, guest_name: req.guest_name, id_type: req.id_type, id_last4: req.id_last4, code: req.code,
    });
    return { ok: true, message: 'registered' };
  }),
  CancelOnlineBooking: guarded((req) => ({ ok: cancelOnline(db, req.booking_id), message: '' })),
  TransferAllotment: guarded((req) => {
    // TODO(rebalance): record request_id for idempotency and move units to/from the online pool.
    const sign = req.direction === 'to_walkin' ? 1 : -1;
    return transaction(db, () => {
      const { changes } = db.prepare(
        'UPDATE inventory SET available = available + ? WHERE listing_id = ? AND day = ? AND available + ? >= 0',
      ).run(sign * req.qty, req.listing_id, req.date, sign * req.qty);
      const row = db.prepare('SELECT available FROM inventory WHERE listing_id = ? AND day = ?')
        .get(req.listing_id, req.date) as { available: number } | undefined;
      return { ok: changes === 1, walkin_available: row?.available ?? 0, message: '' };
    });
  }),
  Ping: guarded(() => ({ island_id: island.id, server_time_ms: Date.now() })),
});

grpcServer.bindAsync(`0.0.0.0:${me.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[${island.id}] gRPC IslandService on :${me.grpcPort}`);
});

// ---------- Outbox sender (island -> central) ----------

const central = new CentralService(`${network.central.host}:${network.central.grpcPort}`,
  grpc.credentials.createInsecure());

async function drainOutbox() {
  if (partitioned) return;
  const pending = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 50').all() as any[];
  if (pending.length === 0) return;
  try {
    const ack = await call<any, { accepted_event_ids: string[] }>(central, 'PushEvents', {
      events: pending.map((e) => ({
        event_id: e.event_id, island_id: island!.id, type: e.type, booking_id: e.booking_id ?? '',
        payload_json: e.payload, created_at_ms: e.created_at,
      })),
    });
    const mark = db.prepare('UPDATE outbox SET sent_at = ? WHERE event_id = ?');
    for (const id of ack.accepted_event_ids) mark.run(Date.now(), id);
  } catch {
    // Central unreachable: keep the events, try again next tick.
  }
}
setInterval(drainOutbox, 2000);

// ---------- HTTP: staff console + staff phone scanner ----------

const app = express();
app.use(express.json());
app.use(express.static(join(ROOT, 'island', 'console')));

const wrap = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
  try {
    res.json(fn(req));
  } catch (err) {
    const status = err instanceof BookingError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
};

app.get('/api/state', wrap((req) => {
  const day = (req.query.day as string) ?? new Date().toISOString().slice(0, 10);
  const listings = db.prepare(
    `SELECT l.id, l.kind, l.name, l.price_php, i.available AS walkin_available
       FROM listings l LEFT JOIN inventory i ON i.listing_id = l.id AND i.day = ?`,
  ).all(day);
  const outboxPending = (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get() as { n: number }).n;
  return { island: { id: island.id, name: island.name }, day, partitioned, outboxPending, listings };
}));

app.get('/api/bookings', wrap(() =>
  db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 100').all()));

app.post('/api/walkin', wrap((req) => {
  const booking = bookWalkin(db, secret, req.body);
  return { booking, ticket: ticketFor(secret, booking as any) };
}));

app.post('/api/verify', wrap((req) => verify(db, secret, listingIds, req.body)));
app.post('/api/redeem', wrap((req) => redeem(db, req.body.bookingId)));

app.post('/api/partition', wrap((req) => {
  partitioned = Boolean(req.body.on);
  console.log(`[${island.id}] partition ${partitioned ? 'ON — cut off from central' : 'OFF — reconnected'}`);
  return { partitioned };
}));

app.listen(me.httpPort, '0.0.0.0', () => {
  console.log(`[${island.id}] staff console on http://localhost:${me.httpPort}`);
});
