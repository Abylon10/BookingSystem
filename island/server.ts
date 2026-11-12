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
  if (err) {
    // In cloud mode the island link is enough, so a busy port is only a warning;
    // on a LAN central needs this port, so stop with a clear message.
    if (process.env.CENTRAL_URL) return console.warn(`[${island.id}] gRPC not started (${err.message}); using the island link only`);
    throw err;
  }
  console.log(`[${island.id}] gRPC IslandService on :${me.grpcPort}`);
});

// --- Transport 2: island link, for central in the cloud ---------------------

// Base URL of central, e.g. https://biliran-central.onrender.com. When set,
// the island keeps one outgoing WebSocket open to it and answers central's
// calls over that socket; no inbound connection to this laptop is needed.
const CENTRAL_URL = process.env.CENTRAL_URL?.replace(/\/+$/, '');
let link: Peer | null = null;

// Which cloud transport is in use. "ws" = WebSocket link (preferred);
// "poll" = HTTPS long polling, for networks that block WebSockets. The island
// switches to polling by itself after 2 WebSocket attempts that never got
// central's welcome. LINK_MODE=poll starts with polling; LINK_MODE=ws never
// switches.
let linkMode: 'ws' | 'poll' = process.env.LINK_MODE === 'poll' ? 'poll' : 'ws';
let failedWsAttempts = 0;
let pollConnected = false;

// Signed header for polling requests: "<island>.<ms>.<hmac>", the same
// signature the WebSocket hello uses.
function pollAuth(): Record<string, string> {
  const ts = Date.now();
  return { 'Content-Type': 'application/json', 'X-Island-Auth': `${island.id}.${ts}.${helloSignature(secret, island.id, ts)}` };
}

// Polling loop: ask central for calls (it holds the request up to ~20 s until
// one arrives), run them through the same handlers, post the results back.
async function pollLoop(): Promise<void> {
  let backoff = 1000;
  let lastError = '';
  for (;;) {
    try {
      // First poll returns at once (wait=0) so "connected" shows immediately.
      const res = await fetch(`${CENTRAL_URL}/island-poll/next${pollConnected ? '' : '?wait=0'}`, {
        method: 'POST', headers: pollAuth(), body: '{}', signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 401) throw new Error('central rejected the island — is TICKET_SECRET the same as central\'s?');
      if (!res.ok) throw new Error(`central answered HTTP ${res.status}`);
      const { requests } = await res.json() as { requests: { id: number; m: string; p: unknown }[] };
      if (!pollConnected) {
        pollConnected = true;
        lastError = '';
        console.log(`[${island.id}] connected to central at ${CENTRAL_URL} (HTTPS polling)`);
      }
      backoff = 1000;
      // Run each call and post its reply; calls run concurrently, like on the WebSocket link.
      for (const r of requests) {
        serve(r.m, r.p).then(
          (p) => ({ id: r.id, ok: true, p }),
          (e) => ({ id: r.id, ok: false, e: { code: e.code ?? 'INTERNAL', message: e.message } }),
        ).then((reply) => fetch(`${CENTRAL_URL}/island-poll/reply`, {
          method: 'POST', headers: pollAuth(), body: JSON.stringify(reply),
        })).catch(() => { /* central retries via timeout */ });
      }
    } catch (err) {
      pollConnected = false;
      const text = (err as Error).message;
      if (text !== lastError) {
        lastError = text;
        console.warn(`[${island.id}] polling central failed: ${text} — retrying`);
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

function startPolling(reason: string): void {
  linkMode = 'poll';
  console.warn(`[${island.id}] ${reason}; switching to HTTPS polling`);
  pollLoop();
}

// Opens the link, signs the hello, and reconnects with backoff when it drops
// (Wi-Fi blip, central restarting, cloud host waking up).
let reconnectDelay = 1000;
let lastLinkError = '';
function connectLink(): void {
  if (!CENTRAL_URL) return;
  // handshakeTimeout: if the network silently stalls the connection (some
  // ISPs, proxies or antivirus "web shields" do this with WebSockets), give up
  // after 15 s with an error instead of waiting forever without a message.
  const ws = new WebSocket(`${CENTRAL_URL.replace(/^http/, 'ws')}/island-link`, { handshakeTimeout: 15_000 });
  let welcomed = false;

  // Connected but never welcomed (central did not answer the hello) -> retry.
  const welcomeTimer = setTimeout(() => {
    if (!welcomed) {
      console.warn(`[${island.id}] central did not answer the hello within 30 s — retrying`);
      ws.terminate();
    }
  }, 30_000);
  ws.on('close', () => clearTimeout(welcomeTimer));
  const linkHandlers: Handlers = {};
  for (const method of Object.keys(api)) linkHandlers[method] = (req) => serve(method, req);

  ws.on('open', () => {
    const ts = Date.now();
    ws.send(JSON.stringify({ t: 'hello', island: island.id, ts, sig: helloSignature(secret, island.id, ts) }));
    link = new Peer(ws, linkHandlers);
  });

  // Central pings every 25 s. If no ping arrives for 70 s, this link is dead
  // (Wi-Fi changed, laptop woke from sleep): drop it and reconnect.
  let lastPing = Date.now();
  ws.on('ping', () => { lastPing = Date.now(); });
  const watchdog = setInterval(() => {
    if (welcomed && Date.now() - lastPing > 70_000) {
      console.warn(`[${island.id}] no heartbeat from central for 70 s; reconnecting`);
      ws.terminate();
    }
  }, 10_000);
  ws.on('close', () => clearInterval(watchdog));
  ws.on('message', (data) => {
    const msg = data.toString();
    if (msg.includes('"t":"welcome"')) {
      welcomed = true;
      failedWsAttempts = 0;
      reconnectDelay = 1000;
      lastLinkError = '';
      console.log(`[${island.id}] connected to central at ${CENTRAL_URL}`);
    }
  });
  ws.on('close', (code, reasonBuf) => {
    link = null;
    const reason = reasonBuf.toString() || 'no reason given';
    if (code === 4003) console.error(`[${island.id}] central rejected the link — is TICKET_SECRET the same as central's?`);
    else if (welcomed) console.warn(`[${island.id}] link to central lost (code ${code}); reconnecting…`);
    else {
      // Closed before central welcomed us: report it (once per distinct cause).
      const text = `closed before welcome (code ${code}: ${reason})`;
      if (text !== lastLinkError) {
        lastLinkError = text;
        console.warn(`[${island.id}] link to central ${text} — retrying`);
      }
      // Two WebSocket attempts that never reached central's welcome: this
      // network is probably blocking WebSockets, so use plain HTTPS instead.
      if (++failedWsAttempts >= 2 && process.env.LINK_MODE !== 'ws') {
        startPolling('WebSocket link does not work on this network');
        return;
      }
    }
    setTimeout(connectLink, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  });
  // Connection failures (no internet, wrong URL, blocked by a proxy/firewall,
  // central asleep). Printed once per distinct error so the terminal shows
  // why the island is not linked, without repeating every retry.
  ws.on('error', (err) => {
    const text = err.message || String(err);
    if (text !== lastLinkError) {
      lastLinkError = text;
      console.warn(`[${island.id}] cannot reach central at ${CENTRAL_URL}: ${text} — retrying`);
    }
  });
}
if (CENTRAL_URL) console.log(`[${island.id}] cloud mode: connecting to central at ${CENTRAL_URL}…`);
else console.log(`[${island.id}] LAN mode (no CENTRAL_URL set): central must reach this laptop directly`);
if (CENTRAL_URL && linkMode === 'poll') startPolling('LINK_MODE=poll');
else connectLink();

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
    // Cloud: WebSocket link, or plain HTTPS when polling; LAN: gRPC.
    let ack: { accepted_event_ids: string[] };
    if (link?.open) ack = await link.call('PushEvents', batch, 10_000);
    else if (CENTRAL_URL && linkMode === 'poll') {
      const res = await fetch(`${CENTRAL_URL}/island-poll/events`, {
        method: 'POST', headers: pollAuth(), body: JSON.stringify(batch), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return;
      ack = await res.json() as { accepted_event_ids: string[] };
    } else if (central) ack = await call(central, 'PushEvents', batch, 10_000);
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
  const centralLink = !CENTRAL_URL ? 'lan'
    : link?.open ? 'connected'
      : linkMode === 'poll' ? (pollConnected ? 'polling' : 'connecting') : 'connecting';
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
