/**
 * central/server.ts
 *
 * The "mainland" server (Laptop 1 on a LAN, or a cloud host). One process serves:
 *  - HTTP API for the Expo app : search, book, list, cancel
 *  - calls to the islands       : parallel search fan-out, register/cancel
 *                                 online tickets on the owning island
 *  - island events (outbox sync): received from every island
 *
 * Two ways to reach an island, chosen per call:
 *  - island link (WebSocket, /island-link): the island connected OUT to us.
 *    Works across the internet, through home routers and mobile-data NAT.
 *  - direct gRPC to the island's IP: only on a shared LAN / hotspot.
 *
 * Storage is Supabase (Postgres). Central owns the ONLINE pool; each island
 * owns its WALK-IN pool. Neither writes the other's data directly.
 */
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ROOT, islandOfReference, loadNetwork, loadSeed, ticketSecret, today } from '../shared/config.ts';
import { mountAdmin } from './admin.ts';
import { PollPeer, mountPolling } from './poll.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
import { Peer, LinkError, errorText, verifyHello } from '../shared/link.ts';
import { newCode, signTicket } from '../shared/ticket.ts';

// ===========================================================================
// Startup
// ===========================================================================

const network = loadNetwork();
const secret = ticketSecret();

// Supabase client using the server-side secret key (bypasses row level
// security, so it must never leave this laptop). Supabase is optional while
// developing: without it, search still works live from the islands and the
// booking endpoints answer 503.
const sb: SupabaseClient | null = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;
if (!sb) console.warn('[central] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — online booking disabled');

// One entry per island. `client` is a direct gRPC client, only when the
// island's address is known (LAN/hotspot config); in the cloud config the
// host is null and the island is reached through its link instead.
const islands = network.islands.map((i) => ({
  id: i.id,
  client: i.host ? new IslandService(`${i.host}:${i.grpcPort}`, grpc.credentials.createInsecure()) : null,
}));
type Island = (typeof islands)[number];
const knownIslands = new Set(islands.map((i) => i.id));

// Islands currently connected, by island id: over a WebSocket link (Peer) or,
// on networks that block WebSockets, over HTTPS long polling (PollPeer).
const links = new Map<string, Peer | PollPeer>();

// Returns the island's poll peer, replacing a WebSocket link if it had one
// (an island that polls has decided its WebSocket does not work).
function pollPeerFor(islandId: string): PollPeer {
  const current = links.get(islandId);
  if (current instanceof PollPeer) return current;
  current?.close();
  const peer = new PollPeer();
  links.set(islandId, peer);
  console.log(`[central] ${islandId} connected over HTTPS polling`);
  return peer;
}

// Calls a method on one island, preferring its link (works across the
// internet) and falling back to direct gRPC (LAN). Throws when neither is
// available, which callers treat as "island offline".
// Consecutive timed-out calls per island over a WebSocket link. Some networks
// (proxies, antivirus "web shields") let a WebSocket open and even answer
// heartbeats, yet hold back the data, so every call times out. After 3 such
// timeouts in a row central closes the link with code 4010, which tells the
// island to switch to HTTPS polling.
const wsTimeouts = new Map<string, number>();

function callIsland<Res>(island: Island, method: string, request: object, timeoutMs = 1500): Promise<Res> {
  const link = links.get(island.id);
  if (link instanceof Peer && link.open) {
    return link.call<Res>(method, request, timeoutMs).then(
      (res) => { wsTimeouts.delete(island.id); return res; },
      (err) => {
        if (err.code === 'DEADLINE_EXCEEDED') {
          const n = (wsTimeouts.get(island.id) ?? 0) + 1;
          wsTimeouts.set(island.id, n);
          if (n >= 3) {
            console.log(`[central] ${island.id}: WebSocket calls keep timing out; telling it to use HTTPS polling`);
            wsTimeouts.delete(island.id);
            link.close(4010, 'calls timing out; use polling');
          }
        }
        throw err;
      },
    );
  }
  if (link?.open) return link.call<Res>(method, request, timeoutMs);
  if (island.client) {
    // LAN gRPC: every method travels as Invoke(method, json). Errors come back
    // as "CODE: message" and are turned into the same LinkError as the link.
    return call<object, { json: string }>(island.client, 'Invoke', { method, json: JSON.stringify(request) }, timeoutMs).then(
      (r) => JSON.parse(r.json) as Res,
      (err) => {
        const m = /^([A-Z_]+): (.*)$/.exec(errorText(err));
        throw m ? new LinkError(m[1], m[2]) : err;
      },
    );
  }
  return Promise.reject(new LinkError('UNAVAILABLE', `${island.id} is not connected`));
}

// Seed: island names and booking-reference prefixes (MRP-… -> maripipi).
const seed = loadSeed();
const islandById = (id: string) => islands.find((i) => i.id === id);
const ownerOf = (reference: string) => islandById(islandOfReference(seed, reference)?.id ?? '');

// Turns an island/link error into an HTTP status for the app.
function httpStatus(err: unknown): number {
  const code = (err as LinkError).code ?? errorText(err).split(':')[0];
  return ({
    INVALID_ARGUMENT: 400, NOT_FOUND: 404, RESOURCE_EXHAUSTED: 409, FAILED_PRECONDITION: 409, ALREADY_EXISTS: 409,
    UNAVAILABLE: 503, DEADLINE_EXCEEDED: 504,
  } as Record<string, number>)[code] ?? 500;
}

// ===========================================================================
// Search fan-out (the main parallelism demo on the read path)
// ===========================================================================

// A package as returned by an island's SearchAvailability.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PackageOut = Record<string, any> & { id: string };

// Asks one island which packages fit the date and guest count, and measures
// how long it took. Never throws: an unreachable or partitioned island is
// reported as "offline" so the search can still return everything else.
async function fetchIsland(island: Island, day: string, guests: number) {
  const started = performance.now();
  try {
    const reply = await callIsland<{ packages: PackageOut[] }>(island, 'SearchAvailability', { day, guests });
    return {
      id: island.id, status: 'online' as const,
      via: !links.get(island.id)?.open ? 'grpc' : links.get(island.id) instanceof PollPeer ? 'poll' : 'link',
      ms: Math.round(performance.now() - started), packages: reply.packages,
    };
  } catch (err) {
    return {
      id: island.id, status: 'offline' as const, ms: Math.round(performance.now() - started),
      error: errorText(err), packages: [] as PackageOut[],
    };
  }
}

// Builds the search result for a date and guest count.
//   mode "parallel"   : ask all islands at the same time (total time = slowest island)
//   mode "sequential" : ask one after another (total time = sum of all islands)
// The sequential mode exists only so the benchmark can compare the two.
// An offline island's packages are left out: only the owning island can
// confirm a booking, so central never sells what it cannot confirm.
async function search(mode: 'parallel' | 'sequential', day: string, guests = 1) {
  const started = performance.now();
  let results: Awaited<ReturnType<typeof fetchIsland>>[];
  if (mode === 'parallel') {
    results = await Promise.all(islands.map((i) => fetchIsland(i, day, guests)));
  } else {
    results = [];
    for (const island of islands) results.push(await fetchIsland(island, day, guests));
  }
  const fanoutMs = Math.round(performance.now() - started);
  return {
    mode, day, guests, fanoutMs,
    totalMs: Math.round(performance.now() - started),
    islands: results.map(({ packages: _unused, ...r }) => ({ ...r, name: seed.islands.find((s) => s.id === r.id)?.name })),
    packages: results.flatMap((r) => r.packages),
    // Kept for the earlier dashboard/benchmark code that counted "listings".
    listings: results.flatMap((r) => r.packages),
  };
}

// ===========================================================================
// HTTP API for the Expo app
// ===========================================================================

const app = express();
app.use(express.json());

// CORS for the public guest API only (/api/packages, /api/bookings…), so the
// app also works as a web page (Expo web). Phones don't need it. The admin
// and island-link routes stay same-origin.
app.use(['/api/packages', '/api/listings', '/api/bookings'], (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Central dashboard: static page at "/" plus its login-protected data API.
app.use(express.static(join(ROOT, 'central', 'dashboard')));
mountAdmin(app, { sb, secret, search });
// Island link fallback over plain HTTPS (central/poll.ts).
mountPolling(app, { secret, knownIslands, pollPeerFor, storeEvents });

// Liveness check used by the app, tests, the cloud host, and the islands'
// keep-awake ping. Also lists which islands are connected over a link.
app.get('/health', (_req, res) => res.json({
  ok: true, supabase: Boolean(sb), linkedIslands: [...links].filter(([, p]) => p.open).map(([id]) => id),
}));

// Search: GET /api/packages?day=YYYY-MM-DD&guests=2[&mode=sequential]
const searchRoute: express.RequestHandler = async (req, res) => {
  const mode = req.query.mode === 'sequential' ? 'sequential' : 'parallel';
  const day = (req.query.day as string) || today();
  const guests = Math.max(1, Number(req.query.guests) || 1);
  res.json(await search(mode, day, guests));
};
app.get('/api/packages', searchRoute);
app.get('/api/listings', searchRoute); // older name, same result

// Online booking, step 1 — HOLD. The owning island reserves every service of
// the package in one atomic transaction (same code and rows as a walk-in) and
// returns a HELD booking that expires if unpaid. Idempotency-Key makes a retry
// after a timeout return the same booking instead of a second one.
app.post('/api/bookings', async (req, res) => {
  const b = req.body ?? {};
  const requestId = req.get('Idempotency-Key') ?? b.requestId;
  if (!requestId) return res.status(400).json({ error: 'Idempotency-Key header required' });
  const island = islandById(String(b.packageId ?? '').split('-')[0]);
  if (!island) return res.status(404).json({ error: 'Unknown package' });
  try {
    const booking = await callIsland(island, 'HoldBooking', {
      requestId, packageId: b.packageId, day: b.day, guests: b.guests, guestName: b.guestName,
      email: b.email, phone: b.phone, idType: b.idType, idLast4: b.idLast4,
    }, 8000);
    res.status(201).json(booking);
  } catch (err) {
    res.status(httpStatus(err)).json({ error: errorText(err) });
  }
});

// Step 2 — PAY (simulated), then CONFIRM or RELEASE. This is the saga:
// hold -> pay -> confirm; if payment fails, the compensating step releases
// the hold so the units go back on sale at once.
app.post('/api/bookings/:ref/pay', async (req, res) => {
  const island = ownerOf(req.params.ref);
  if (!island) return res.status(404).json({ error: 'Unknown booking reference' });
  const method = String(req.body?.method ?? 'card');
  const paymentOk = req.body?.simulate !== 'fail';
  try {
    if (!paymentOk) {
      const released = await callIsland(island, 'ReleaseHold', { reference: req.params.ref }, 8000);
      return res.status(402).json({ error: `Payment with ${method} was declined; the hold was released`, booking: released });
    }
    const confirmed = await callIsland(island, 'ConfirmBooking', { reference: req.params.ref, payment: method }, 8000);
    res.json({ ...(confirmed as object), payment: { method, ref: `PAY-${Date.now().toString(36).toUpperCase()}` } });
  } catch (err) {
    res.status(httpStatus(err)).json({ error: errorText(err) });
  }
});

// My booking: GET /api/bookings/:ref?email=… — live from the owning island,
// or from central's copy when that island is offline.
app.get('/api/bookings/:ref', async (req, res) => {
  const island = ownerOf(req.params.ref);
  const email = String(req.query.email ?? '');
  if (!island) return res.status(404).json({ error: 'Booking not found' });
  try {
    res.json(await callIsland(island, 'GetBooking', { reference: req.params.ref, email }, 5000));
  } catch (err) {
    if (httpStatus(err) === 404) return res.status(404).json({ error: 'Booking not found' });
    const copy = sb ? (await sb.from('booking_copies').select('*').eq('reference', req.params.ref.toUpperCase()).maybeSingle()).data : null;
    if (copy && copy.email.toLowerCase() === email.toLowerCase()) return res.json({ ...copy, stale: true });
    res.status(httpStatus(err)).json({ error: errorText(err) });
  }
});

// Cancel: POST /api/bookings/:ref/cancel { email } — the island returns the units.
app.post('/api/bookings/:ref/cancel', async (req, res) => {
  const island = ownerOf(req.params.ref);
  if (!island) return res.status(404).json({ error: 'Booking not found' });
  try {
    res.json(await callIsland(island, 'CancelBooking', { reference: req.params.ref, email: req.body?.email }, 8000));
  } catch (err) {
    res.status(httpStatus(err)).json({ error: errorText(err) });
  }
});

// ===========================================================================
// Island events (outbox sync) — shared by the link and gRPC transports
// ===========================================================================

// One event as sent by an island (see Event in booking.proto).
interface IslandEvent {
  event_id: string;
  island_id: string;
  type: string;
  booking_id: string;
  payload_json: string;
  created_at_ms: number;
}

// Stores a batch of island events and returns the ids it accepted. Called for
// PushEvents over either transport.
async function storeEvents(events: IslandEvent[]): Promise<string[]> {
  // Without Supabase there is nowhere to store events: log and acknowledge
  // them anyway so the sync can still be demonstrated.
  if (!sb) {
    for (const e of events) console.log(`[central] event ${e.type} from ${e.island_id} (${e.booking_id})`);
    return events.map((e) => e.event_id);
  }

  // 1. Store the events. ignoreDuplicates + the event_id primary key make
  //    re-delivery harmless (an island resends if it missed our ack).
  const { error } = await sb.from('island_events').upsert(events.map((e) => ({
    event_id: e.event_id, island_id: e.island_id, type: e.type, booking_id: e.booking_id || null,
    payload: JSON.parse(e.payload_json || '{}'), created_at: new Date(Number(e.created_at_ms)).toISOString(),
  })), { onConflict: 'event_id', ignoreDuplicates: true });
  if (error) throw new LinkError('INTERNAL', error.message);

  // 2. Booking snapshots -> central's read-only copy (dashboard, reports, and
  //    "my booking" while the owning island is offline). Only a newer snapshot
  //    replaces an older one, so events arriving out of order cannot roll a
  //    booking back to an earlier status.
  const latest = new Map<string, Record<string, unknown>>();
  for (const e of events.filter((x) => x.type === 'BOOKING_UPDATED')) {
    const b = JSON.parse(e.payload_json);
    const prev = latest.get(b.reference) as { updated_at: number } | undefined;
    if (!prev || prev.updated_at <= b.updated_at) latest.set(b.reference, b);
  }
  // One upsert per booking, all sent at once (Supabase is a network hop away).
  const results = await Promise.all([...latest.values()].map((b) => sb.rpc('upsert_booking_copy', {
    p: {
      reference: b.reference, island_id: b.island_id, source: b.source, package_id: b.package_id,
      package_name: b.package_name, day: b.day, nights: b.nights, guests: b.guests, guest_name: b.guest_name,
      email: b.email ?? '', total_php: b.total_php, status: b.status,
      created_at: new Date(Number(b.created_at)).toISOString(), updated_at_ms: b.updated_at,
    },
  })));
  const failed = results.find((r) => r.error);
  if (failed) throw new LinkError('INTERNAL', failed.error!.message);

  // 3. Acknowledge: the island marks these events as sent.
  return events.map((e) => e.event_id);
}

// ===========================================================================
// Start: HTTP API + island links on one port, plus the LAN gRPC service
// ===========================================================================

// One HTTP server for both the app's API and the island links, because a
// cloud host exposes a single HTTPS port. PORT is set by the cloud host;
// on a laptop the port comes from the network config.
const httpServer = createServer(app);
const PORT = Number(process.env.PORT ?? network.central.httpPort);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[central] HTTP API on http://localhost:${PORT} (island links on /island-link)`);
});

// Island links: each island connects here and sends a signed hello first.
// Anything that does not authenticate within 5 seconds is disconnected.
const wss = new WebSocketServer({ server: httpServer, path: '/island-link' });
wss.on('connection', (ws) => {
  const helloTimer = setTimeout(() => ws.close(4001, 'no hello'), 5000);

  ws.once('message', (data) => {
    clearTimeout(helloTimer);
    let hello;
    try {
      hello = JSON.parse(data.toString());
    } catch {
      return ws.close(4002, 'bad hello');
    }
    if (hello.t !== 'hello' || !knownIslands.has(hello.island) || !verifyHello(secret, hello.island, hello.ts, hello.sig)) {
      console.warn('[central] rejected an island link (bad island id or signature)');
      return ws.close(4003, 'not authorized');
    }

    // Accepted: a newer link from the same island replaces the old one
    // (e.g. the island reconnected before the old socket timed out).
    const islandId = hello.island as string;
    links.get(islandId)?.close();
    const peer = new Peer(ws, {
      PushEvents: async (req: { events: IslandEvent[] }) => ({ accepted_event_ids: await storeEvents(req.events) }),
    });
    links.set(islandId, peer);
    ws.send(JSON.stringify({ t: 'welcome', island: islandId }));
    console.log(`[central] ${islandId} connected over island link`);

    // Heartbeat every 25 s: keeps the connection alive through cloud proxies
    // that drop idle sockets, and detects dead links (laptop asleep, Wi-Fi
    // gone without a proper close). No pong since the last ping -> the link is
    // dead: drop it so the island shows offline at once and can reconnect.
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) {
        console.log(`[central] ${islandId} stopped answering heartbeats; dropping its link`);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 25_000);
    ws.on('close', () => {
      clearInterval(heartbeat);
      if (links.get(islandId) === peer) links.delete(islandId);
      console.log(`[central] ${islandId} link closed`);
    });
  });
});

// gRPC CentralService for islands on the same LAN/hotspot (direct mode).
const grpcServer = new grpc.Server();
grpcServer.addService(CentralService.service, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PushEvents: async (rpc: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => {
    try {
      cb(null, { accepted_event_ids: await storeEvents(rpc.request.events as IslandEvent[]) });
    } catch (err) {
      cb({ code: grpc.status.INTERNAL, details: errorText(err) });
    }
  },
});
grpcServer.bindAsync(`0.0.0.0:${network.central.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) return console.warn(`[central] gRPC not started (${err.message}); island links still work`);
  console.log(`[central] gRPC CentralService on :${network.central.grpcPort}`);
});
