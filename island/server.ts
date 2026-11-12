/**
 * island/server.ts
 *
 * Entry point of an island node (runs on Laptops 2-4). One process serves:
 *  - IslandService      : answers central (catalog, availability, hold /
 *                         confirm / release / cancel online bookings, lookup)
 *                         over whichever transport works:
 *                           - island link: we connect OUT to CENTRAL_URL over a
 *                             WebSocket, or HTTPS polling where WebSockets are
 *                             blocked (works from any internet connection)
 *                           - gRPC server: central calls our IP (same LAN only)
 *  - HTTP API + console : front desk (login, arrivals, walk-ins, blocking,
 *                         staff accounts) on this laptop
 *  - outbox sender      : pushes local events to central every 2 seconds
 *
 * Start with:  node island/server.ts <islandId>   (or npm run island:<id>)
 * Cloud mode:  set CENTRAL_URL=https://<central host> and NETWORK=cloud in .env
 */
import express from 'express';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ROOT, loadNetwork, loadSeed, ticketSecret, today } from '../shared/config.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
import { LinkError, Peer, helloSignature, type Handlers } from '../shared/link.ts';
import { openDb, seedIsland } from './db.ts';
import { BookingError, createEngine, type ReserveRequest } from './engine.ts';

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
// create the booking engine. Unpaid online holds expire after holdMinutes.
const secret = ticketSecret();
const db = openDb(island.id);
seedIsland(db, seed, island);
const engine = createEngine(db, island, seed.holdMinutes);
setInterval(() => engine.expireHolds(), 30_000);

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
  // Catalog: this island's active packages and their services.
  GetCatalog: () => ({ island_id: island.id, packages: engine.catalog() }),

  // Search fan-out: packages bookable for a date and guest count. Central
  // calls every island at the same time and merges the answers.
  SearchAvailability: (req) => ({
    island_id: island.id, island_name: island.name,
    packages: engine.availability(req.day ?? today(), Math.max(1, Number(req.guests) || 1)),
  }),

  // Online booking, step 1: reserve the units (HELD, expires if unpaid).
  // The same engine call as a walk-in, on the same inventory rows.
  HoldBooking: (req: ReserveRequest) => engine.reserve(req, 'ONLINE', 'online'),
  // Step 2a: payment went through.
  ConfirmBooking: (req) => engine.confirm(req.reference),
  // Step 2b (compensation): payment failed or abandoned -> give units back.
  ReleaseHold: (req) => engine.release(req.reference),
  // Customer cancels from the app (e-mail must match the booking).
  CancelBooking: (req) => {
    const b = engine.get(req.reference);
    if (!b || b.email.toLowerCase() !== String(req.email ?? '').toLowerCase()) throw new BookingError(404, 'Booking not found', 'NOT_FOUND');
    return engine.cancel(req.reference);
  },
  // "My booking" lookup from the app (reference + e-mail).
  GetBooking: (req) => {
    const b = engine.get(req.reference);
    if (!b || b.email.toLowerCase() !== String(req.email ?? '').toLowerCase()) throw new BookingError(404, 'Booking not found', 'NOT_FOUND');
    return b;
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
// Every method travels as Invoke(method, json) so the gRPC contract stays one
// small, stable message while the methods evolve (see proto/booking.proto).
// Errors keep their code in the message as "CODE: text" for central.
const grpcHandlers: Record<string, GrpcHandler> = {
  Invoke: (rpc, cb) => {
    serve(rpc.request.method, JSON.parse(rpc.request.json || '{}')).then(
      (res) => cb(null, { method: rpc.request.method, json: JSON.stringify(res) }),
      (err) => cb({ code: err.code === 'UNAVAILABLE' ? grpc.status.UNAVAILABLE : grpc.status.UNKNOWN, details: `${err.code ?? 'INTERNAL'}: ${err.message}` }),
    );
  },
};
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
    // 4010: central saw our WebSocket calls time out (data held back by the
    // network) and asks us to use HTTPS polling instead.
    if (code === 4010 && process.env.LINK_MODE !== 'ws') {
      startPolling('central reports the WebSocket link is not delivering calls');
      return;
    }
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
  } catch (err) {
    // Central unreachable or refused: keep the events and try again on the
    // next tick. Log each distinct reason once so problems are visible.
    const text = (err as Error).message ?? String(err);
    if (text !== lastOutboxError) {
      lastOutboxError = text;
      console.warn(`[${island.id}] sync to central failed: ${text} — will retry`);
    }
    return;
  }
  lastOutboxError = '';
}
let lastOutboxError = '';
setInterval(drainOutbox, 2000);

// ===========================================================================
// HTTP: front desk console (this laptop)
// ===========================================================================

const app = express();
app.use(express.json());
// Serves island/console/index.html, style.css and app.js at "/".
app.use(express.static(join(ROOT, 'island', 'console')));

// --- Staff sessions ---------------------------------------------------------
// Logins are checked against this island's own staff table, so they work while
// the island is offline. A session token is "<user>.<role>.<expiry>.<hmac>".
const SESSION_HOURS = 12;
const signSession = (user: string, role: string, exp: number) =>
  createHmac('sha256', secret).update(`staff:${island.id}:${user}:${role}:${exp}`).digest('hex');
function newSession(user: string, role: string) {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  return { token: `${user}.${role}.${exp}.${signSession(user, role, exp)}`, user, role };
}
function readSession(req: express.Request): { user: string; role: string } | null {
  const [user, role, expText, sig] = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').split('.');
  const exp = Number(expText);
  if (!user || !sig || !(exp > Date.now())) return null;
  const expected = Buffer.from(signSession(user, role, exp), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? { user, role } : null;
}

// Turns a handler into an Express route that answers JSON and requires a
// signed-in staff member (and the node_admin role when adminOnly).
type Handler = (req: express.Request, staff: { user: string; role: string }) => unknown;
const route = (fn: Handler, adminOnly = false) => (req: express.Request, res: express.Response) => {
  const staff = readSession(req);
  if (!staff) return res.status(401).json({ error: 'Sign in again' });
  if (adminOnly && staff.role !== 'node_admin') return res.status(403).json({ error: 'Node admin only' });
  try {
    res.json(fn(req, staff));
  } catch (err) {
    const status = err instanceof BookingError ? err.status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
};

// First run: no staff yet -> the console asks to create the node admin.
app.get('/api/session', (req, res) => {
  res.json({ island: { id: island.id, name: island.name }, needsSetup: !engine.hasStaff(), staff: readSession(req) });
});
app.post('/api/setup', (req, res) => {
  if (engine.hasStaff()) return res.status(409).json({ error: 'Already set up; sign in instead' });
  try {
    engine.addStaff(req.body.username, req.body.password, 'node_admin');
    res.json(newSession(String(req.body.username).toLowerCase(), 'node_admin'));
  } catch (err) {
    res.status((err as BookingError).status ?? 500).json({ error: (err as Error).message });
  }
});
app.post('/api/login', (req, res) => {
  const role = engine.verifyLogin(req.body.username, req.body.password);
  if (!role) return res.status(401).json({ error: 'Wrong username or password' });
  res.json(newSession(String(req.body.username).toLowerCase(), role));
});

// --- Front desk -------------------------------------------------------------

// Header + availability data: link status, sync backlog, packages for a date
// and guest count, and every service's inventory that day.
app.get('/api/state', route((req) => {
  const day = (req.query.day as string) || today();
  const guests = Math.max(1, Number(req.query.guests) || 1);
  const outboxPending = (db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL').get() as { n: number }).n;
  const centralLink = !CENTRAL_URL ? 'lan'
    : link?.open ? 'connected'
      : linkMode === 'poll' ? (pollConnected ? 'polling' : 'connecting') : 'connecting';
  return {
    island: { id: island.id, name: island.name }, day, guests, partitioned, outboxPending, centralLink,
    packages: engine.availability(day, guests), inventory: engine.inventory(day),
  };
}));

// Today's (or a given day's) arrivals, or a search by reference / name.
app.get('/api/bookings', route((req) => {
  if (req.query.q) return engine.search(String(req.query.q));
  if (req.query.day) return engine.arrivals(String(req.query.day));
  return engine.recent(100);
}));

// Face-to-face booking: paid at the desk, so it is CONFIRMED at once.
app.post('/api/walkin', route((req, staff) => engine.reserve(req.body as ReserveRequest, 'WALKIN', staff.user)));

// Arrival: staff matched the physical ID with the booking -> CHECKED_IN (once only).
app.post('/api/bookings/:ref/checkin', route((req) => engine.checkIn(String(req.params.ref))));
app.post('/api/bookings/:ref/cancel', route((req) => engine.cancel(String(req.params.ref))));

// Mark units unavailable (repairs, weather, boat down) / make them available again.
app.post('/api/blocks', route((req) =>
  engine.block(req.body.serviceId, req.body.day, Math.max(1, Number(req.body.days) || 1), Number(req.body.units) || 0)));
app.post('/api/blocks/release', route((req) => engine.unblock(req.body.serviceId, req.body.day, Number(req.body.units) || 0)));

// Staff accounts: the node admin creates and disables receptionists.
app.get('/api/staff', route(() => engine.listStaff(), true));
app.post('/api/staff', route((req) => {
  engine.addStaff(req.body.username, req.body.password, 'receptionist');
  return engine.listStaff();
}, true));
app.post('/api/staff/:user/active', route((req) => ({ ok: engine.setStaffActive(String(req.params.user), Boolean(req.body.active)) }), true));

// The "Disconnect from Central" switch (demo of an island losing its link).
app.post('/api/partition', route((req) => {
  partitioned = Boolean(req.body.on);
  console.log(`[${island.id}] partition ${partitioned ? 'ON — cut off from central' : 'OFF — reconnected'}`);
  return { partitioned };
}));

// Listen on all interfaces so the staff phone can reach this laptop.
app.listen(me.httpPort, '0.0.0.0', () => {
  console.log(`[${island.id}] staff console on http://localhost:${me.httpPort}`);
});
