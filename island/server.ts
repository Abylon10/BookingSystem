/**
 * island/server.ts
 *
 * Entry point of an island node (runs on Laptops 2-4). One process serves:
 *  - IslandService      : answers central (search, register/cancel online
 *                         bookings, rebalance, ping) over EITHER transport:
 *                           - island link: we connect OUT to CENTRAL_URL
 *                             (works from any internet connection)
 *                           - gRPC server: central calls our IP (same LAN only)
 *  - HTTP API + console : used by staff on this laptop and by the staff
 *                         scanner phone on the hotspot
 *  - outbox sender      : pushes local events to central every 2 seconds
 *
 * Start with:  node island/server.ts <islandId>   (or npm run island:<id>)
 * Cloud mode:  set CENTRAL_URL=https://<central host> and NETWORK=cloud in .env
 */
import express from 'express';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ROOT, addDays, loadNetwork, loadSeed, ticketSecret, today } from '../shared/config.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
import { LinkError, Peer, helloSignature, type Handlers } from '../shared/link.ts';
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
// IslandService handlers (central is the caller)
// ===========================================================================

// The methods central may call, as plain functions. The same map is served
// over the island link and over the LAN gRPC server (both set up below).
const api: Handlers = {
  // Search fan-out: return this island's catalog. Central calls every island
  // at the same time and merges the answers.
  GetCatalog: () => ({
    island_id: island.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listings: (db.prepare('SELECT * FROM listings').all() as any[]).map((l) => ({
      ...l, island_id: island.id, facilities: JSON.parse(l.facilities),
    })),
  }),

  // Walk-in units left for one listing over a range of days.
  GetAvailability: (req) => {
    const rows = db.prepare(
      `SELECT day AS date, available AS walkin_available FROM inventory
        WHERE listing_id = ? AND day >= ? AND day < ? ORDER BY day`,
    ).all(req.listing_id, req.from_date, addDays(req.from_date, req.days || 1));
    return { listing_id: req.listing_id, days: rows };
  },

  // Central sold an online ticket for one of our listings: store it so staff
  // can look it up by its manual code. Idempotent (see registerOnline).
  RegisterOnlineBooking: (req) => {
    registerOnline(db, {
      id: req.booking_id, listing_id: req.listing_id, day: req.date, nights: req.nights || 1,
      qty: req.qty, guest_name: req.guest_name, id_type: req.id_type, id_last4: req.id_last4, code: req.code,
    });
    return { ok: true, message: 'registered' };
  },

  // Central cancelled an online booking (refund): block it from check-in.
  CancelOnlineBooking: (req) => ({ ok: cancelOnline(db, req.booking_id), message: '' }),

  // Rebalance: move units between this island's walk-in pool and central's
  // online pool. "to_walkin" adds units here; "to_online" removes them (only if
  // enough are left). Central adjusts its own pool after a successful reply.
  // TODO(rebalance): store request_id so a retried transfer is not applied twice.
  TransferAllotment: (req) => {
    const delta = req.direction === 'to_walkin' ? req.qty : -req.qty;
    return transaction(db, () => {
      const { changes } = db.prepare(
        'UPDATE inventory SET available = available + ? WHERE listing_id = ? AND day = ? AND available + ? >= 0',
      ).run(delta, req.listing_id, req.date, delta);
      const row = db.prepare('SELECT available FROM inventory WHERE listing_id = ? AND day = ?')
        .get(req.listing_id, req.date) as { available: number } | undefined;
      return { ok: changes === 1, walkin_available: row?.available ?? 0, message: '' };
    });
  },

  // Health check: central uses it to see if the island is reachable.
  Ping: () => ({ island_id: island.id, server_time_ms: Date.now() }),
};

// Applies the cross-cutting rules to every call, whichever transport it came on:
//  1. while partitioned, refuse with UNAVAILABLE (exactly what a dead link
//     looks like to central, so its timeouts/fallbacks get exercised)
//  2. wait LINK_LATENCY_MS before answering (simulated sea link)
async function serve(method: string, req: unknown): Promise<unknown> {
  if (partitioned) throw new LinkError('UNAVAILABLE', `${island.id} is partitioned`);
  if (LINK_LATENCY_MS) await new Promise((r) => setTimeout(r, LINK_LATENCY_MS));
  return api[method](req);
}

// --- Transport 1: gRPC server, for central on the same LAN/hotspot ---------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GrpcHandler = (call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => void;
const grpcHandlers: Record<string, GrpcHandler> = {};
for (const method of Object.keys(api)) {
  grpcHandlers[method] = (rpc, cb) => {
    serve(method, rpc.request).then(
      (res) => cb(null, res),
      (err) => cb({ code: err.code === 'UNAVAILABLE' ? grpc.status.UNAVAILABLE : grpc.status.INTERNAL, details: err.message }),
    );
  };
}
const grpcServer = new grpc.Server();
grpcServer.addService(IslandService.service, grpcHandlers);
grpcServer.bindAsync(`0.0.0.0:${me.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[${island.id}] gRPC IslandService on :${me.grpcPort}`);
});

// --- Transport 2: island link, for central in the cloud ---------------------

// Base URL of central, e.g. https://biliran-central.onrender.com. When set,
// the island keeps one outgoing WebSocket open to it and answers central's
// calls over that socket; no inbound connection to this laptop is needed.
const CENTRAL_URL = process.env.CENTRAL_URL?.replace(/\/+$/, '');
let link: Peer | null = null;

// Opens the link, signs the hello, and reconnects with backoff when it drops
// (Wi-Fi blip, central restarting, cloud host waking up).
let reconnectDelay = 1000;
function connectLink(): void {
  if (!CENTRAL_URL) return;
  const ws = new WebSocket(`${CENTRAL_URL.replace(/^http/, 'ws')}/island-link`);
  const linkHandlers: Handlers = {};
  for (const method of Object.keys(api)) linkHandlers[method] = (req) => serve(method, req);

  ws.on('open', () => {
    const ts = Date.now();
    ws.send(JSON.stringify({ t: 'hello', island: island.id, ts, sig: helloSignature(secret, island.id, ts) }));
    link = new Peer(ws, linkHandlers);
  });
  ws.on('message', (data) => {
    const msg = data.toString();
    if (msg.includes('"t":"welcome"')) {
      reconnectDelay = 1000;
      console.log(`[${island.id}] connected to central at ${CENTRAL_URL}`);
    }
  });
  ws.on('close', (code) => {
    link = null;
    if (code === 4003) console.error(`[${island.id}] central rejected the link — is TICKET_SECRET the same as central's?`);
    setTimeout(connectLink, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  ws.on('error', () => { /* close follows; reconnect happens there */ });
}
connectLink();

// Free cloud hosts sleep when they get no HTTP traffic for a while; a light
// ping every 5 minutes keeps central awake while islands are running.
if (CENTRAL_URL) setInterval(() => { fetch(`${CENTRAL_URL}/health`).catch(() => {}); }, 5 * 60_000);

// ===========================================================================
// Outbox sender (island -> central)
// ===========================================================================

// gRPC client for central's CentralService (LAN mode only; null in the cloud
// config, where events go over the island link instead).
const central = network.central.host
  ? new CentralService(`${network.central.host}:${network.central.grpcPort}`, grpc.credentials.createInsecure())
  : null;

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

  const batch = {
    events: pending.map((e) => ({
      event_id: e.event_id, island_id: island.id, type: e.type, booking_id: e.booking_id ?? '',
      payload_json: e.payload, created_at_ms: e.created_at,
    })),
  };
  try {
    // Prefer the island link (cloud); fall back to gRPC (LAN).
    let ack: { accepted_event_ids: string[] };
    if (link?.open) ack = await link.call('PushEvents', batch, 10_000);
    else if (central) ack = await call(central, 'PushEvents', batch, 10_000);
    else return;
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
  const centralLink = CENTRAL_URL ? (link?.open ? 'connected' : 'connecting') : 'lan';
  return { island: { id: island.id, name: island.name }, day, partitioned, outboxPending, centralLink, listings };
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
