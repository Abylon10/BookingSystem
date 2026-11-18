/**
 * central/server.ts — [PDC: Client-server] [PDC: RPC client] [PDC: Parallel]
 *
 * The "mainland" server (cloud host, or Laptop 1 on a LAN). One process serves:
 *  - HTTP API for the guest app : search, quote, book, pay, cancel, my trips
 *  - calls to the islands        : parallel search fan-out and the online
 *                                  booking saga (hold -> pay -> confirm)
 *  - island events (outbox sync) : received from every island, stored in Supabase
 *
 * Three ways to reach an island, chosen per call in callIsland():
 *  - island link (WebSocket, /island-link): the island connected OUT to us.
 *    Works across the internet, through home routers and mobile-data NAT.
 *  - HTTPS polling (central/poll.ts): for networks that block WebSockets.
 *  - direct gRPC to the island's IP: only on a shared LAN / hotspot.
 *
 * Central owns NO rooms: every island is the only writer of its own
 * inventory and bookings. Central keeps read-only copies (Supabase) for the
 * dashboard and for lookups while an island is offline.
 *
 * Where to find each part in this file:
 *   [PDC: RPC client]        callIsland(): one call to one island, any transport
 *   [PDC: Parallel]          search(): all islands asked at the same time
 *   [PDC: Saga]              POST /api/bookings (hold) and /pay (confirm/release)
 *   [PDC: Idempotency]       Idempotency-Key on POST /api/bookings
 *   [PDC: Replication]       storeEvents(): island outbox -> central copies
 *   [PDC: RPC over WebSocket] the /island-link WebSocket server (bottom)
 * Marshalling of every call and reply: shared/marshal.ts.
 */
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ROOT, loadNetwork, loadSeed, ticketSecret, today } from '../shared/config.ts';
import { mountAdmin } from './admin.ts';
import { PollPeer, mountPolling } from './poll.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
import { Peer, LinkError, errorText, verifyHello } from '../shared/link.ts';
import { errorFromGrpc, frame, fromInvocation, marshal, parseFrame, toInvocation, unmarshal, type Invocation } from '../shared/marshal.ts';

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

// One entry per island: the three built-in ones (config/seed.json and the
// network config) plus islands the central admin registered later (Supabase
// table registered_islands). `client` is a direct gRPC client, only when the
// island's address is known (LAN/hotspot config); otherwise the island is
// reached through its link.
type Island = { id: string; name: string; prefix: string; builtIn: boolean; client: InstanceType<typeof IslandService> | null };
const seedIslands = loadSeed().islands;
const islands: Island[] = network.islands.map((i) => {
  const s = seedIslands.find((x) => x.id === i.id);
  return {
    id: i.id, name: s?.name ?? i.id, prefix: s?.prefix ?? i.id.slice(0, 3).toUpperCase(), builtIn: true,
    client: i.host ? new IslandService(`${i.host}:${i.grpcPort}`, grpc.credentials.createInsecure()) : null,
  };
});
const knownIslands = new Set(islands.map((i) => i.id));

// Adds a registered island to the live list (links, search, accounts…).
function addIsland(i: { id: string; name: string; prefix: string }) {
  if (knownIslands.has(i.id)) return;
  islands.push({ ...i, builtIn: false, client: null });
  knownIslands.add(i.id);
}
// Registered islands are loaded from Supabase when central starts.
if (sb) {
  sb.from('registered_islands').select('id, name, prefix').then(({ data, error }) => {
    if (error) return console.warn(`[central] registered islands not loaded: ${error.message}`);
    for (const i of data ?? []) addIsland(i);
    if (data?.length) console.log(`[central] registered islands: ${data.map((i) => i.id).join(', ')}`);
  });
}

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

// [PDC: RPC client] Calls one method on one island over whichever transport
// that island is reachable on, with a deadline. All three transports return
// the same reply shape and the same error codes (shared/marshal.ts).
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
    // [PDC: Marshalling] request -> Invocation -> protobuf (by gRPC), and back.
    return call<Invocation, Invocation>(island.client, 'Invoke', toInvocation(method, request), timeoutMs).then(
      (r) => fromInvocation<Res>(r),
      (err) => { throw errorFromGrpc(err); },
    );
  }
  return Promise.reject(new LinkError('UNAVAILABLE', `${island.id} is not connected`));
}

// Seed: island names and booking-reference prefixes (MRP-… -> maripipi).
const seed = loadSeed();
const islandById = (id: string) => islands.find((i) => i.id === id);
// Owner of a booking reference, by its prefix ("MRP-7F3K2" -> maripipi).
const ownerOf = (reference: string) => islands.find((i) => i.prefix === String(reference).toUpperCase().split('-')[0]);
const nameOf = (id: string) => islandById(id)?.name ?? id;

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

// Asks one island which packages fit the date and guest count (and its
// services checklist for build-your-own trips), and measures how long it
// took. Never throws: an unreachable or partitioned island is reported as
// "offline" so the search can still return everything else.
async function fetchIsland(island: Island, day: string, guests: number, extraHours = 0, days = 1) {
  const started = performance.now();
  try {
    const reply = await callIsland<{ packages: PackageOut[]; services?: PackageOut[] }>(island, 'SearchAvailability', { day, guests, extraHours, days });
    const name = island.name;
    return {
      id: island.id, status: 'online' as const,
      via: !links.get(island.id)?.open ? 'grpc' : links.get(island.id) instanceof PollPeer ? 'poll' : 'link',
      ms: Math.round(performance.now() - started), packages: reply.packages,
      services: (reply.services ?? []).map((s) => ({ ...s, island_id: island.id, island_name: name })),
    };
  } catch (err) {
    return {
      id: island.id, status: 'offline' as const, ms: Math.round(performance.now() - started),
      error: errorText(err), packages: [] as PackageOut[], services: [] as PackageOut[],
    };
  }
}

// Builds the search result for a date and guest count.
//   mode "parallel"   : ask all islands at the same time (total time = slowest island)
//   mode "sequential" : ask one after another (total time = sum of all islands)
// The sequential mode exists only so the benchmark can compare the two.
// An offline island's packages are left out: only the owning island can
// confirm a booking, so central never sells what it cannot confirm.
// [PDC: Parallel] [PDC: Distributed search]
async function search(mode: 'parallel' | 'sequential', day: string, guests = 1, extraHours = 0, days = 1) {
  const started = performance.now();
  let results: Awaited<ReturnType<typeof fetchIsland>>[];
  if (mode === 'parallel') {
    results = await Promise.all(islands.map((i) => fetchIsland(i, day, guests, extraHours, days)));
  } else {
    results = [];
    for (const island of islands) results.push(await fetchIsland(island, day, guests, extraHours, days));
  }
  const fanoutMs = Math.round(performance.now() - started);
  return {
    mode, day, guests, fanoutMs,
    totalMs: Math.round(performance.now() - started),
    islands: results.map(({ packages: _p, services: _s, ...r }) => ({ ...r, name: nameOf(r.id) })),
    packages: results.flatMap((r) => r.packages),
    // Services checklist per island, for build-your-own trips.
    services: results.flatMap((r) => r.services),
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
app.use(['/api/packages', '/api/listings', '/api/bookings', '/api/quote', '/api/me'], (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Central dashboard: static page at "/" plus its login-protected data API.
app.use(express.static(join(ROOT, 'central', 'dashboard')));
mountAdmin(app, {
  sb, secret, search,
  // Lets the admin pages call any island (accounts, inventory).
  ask: (islandId, method, request, timeoutMs) => {
    const island = islandById(islandId);
    return island ? callIsland(island, method, request, timeoutMs) : Promise.reject(new LinkError('NOT_FOUND', 'Unknown island'));
  },
  islandList: () => islands.map((i) => ({ id: i.id, name: i.name, prefix: i.prefix, builtIn: i.builtIn, linked: Boolean(links.get(i.id)?.open) })),
  // Registers a new island (central admin): saved in Supabase, live at once.
  registerIsland: async (i: { id: string; name: string; prefix: string }) => {
    if (knownIslands.has(i.id)) throw new LinkError('ALREADY_EXISTS', 'An island with that id already exists');
    if (islands.some((x) => x.prefix === i.prefix)) throw new LinkError('ALREADY_EXISTS', `Prefix ${i.prefix} is already used`);
    if (!sb) throw new LinkError('UNAVAILABLE', 'Registering islands needs Supabase on central');
    const { error } = await sb.from('registered_islands').insert(i);
    if (error) throw new LinkError('INTERNAL', error.message);
    addIsland(i);
    console.log(`[central] registered island ${i.id} (${i.name}, ${i.prefix})`);
  },
});
// Island link fallback over plain HTTPS (central/poll.ts).
mountPolling(app, { secret, knownIslands, pollPeerFor, storeEvents });

// Public island info, used by a newly registered island node at start-up to
// learn its name and booking prefix: GET /api/islands/<id>.
app.get('/api/islands/:id', (req, res) => {
  const i = islandById(req.params.id);
  if (!i) return res.status(404).json({ error: 'Island not registered on central' });
  res.json({ id: i.id, name: i.name, prefix: i.prefix });
});

// Liveness check used by the app, tests, the cloud host, and the islands'
// keep-awake ping. Also lists which islands are connected over a link.
// A browser gets the designed page (central/dashboard/health.html); programs
// (islands' keep-awake ping, tests) and ?format=json get the JSON.
app.get('/health', (req, res) => {
  if (req.query.format !== 'json' && req.accepts(['json', 'html']) === 'html') {
    return res.sendFile(join(ROOT, 'central', 'dashboard', 'health.html'));
  }
  res.json({
    ok: true, supabase: Boolean(sb), linkedIslands: [...links].filter(([, p]) => p.open).map(([id]) => id),
    islands: islands.map((i) => ({ id: i.id, name: i.name, prefix: i.prefix, builtIn: i.builtIn, linked: Boolean(links.get(i.id)?.open) })),
    uptimeSeconds: Math.round(process.uptime()), serverTime: new Date().toISOString(),
  });
});

// Search: GET /api/packages?day=YYYY-MM-DD&guests=2[&extraHours=3][&days=2][&mode=sequential]
const searchRoute: express.RequestHandler = async (req, res) => {
  const mode = req.query.mode === 'sequential' ? 'sequential' : 'parallel';
  const day = (req.query.day as string) || today();
  const guests = Math.max(1, Number(req.query.guests) || 1);
  // extraHours (or extraDays = 24 h each, from older apps).
  const extraHours = Math.max(0, Number(req.query.extraHours ?? (Number(req.query.extraDays) || 0) * 24) || 0);
  const days = Math.max(1, Number(req.query.days) || 1);
  res.json(await search(mode, day, guests, extraHours, days));
};
app.get('/api/packages', searchRoute);
app.get('/api/listings', searchRoute); // older name, same result

// The island that owns a package ("maripipi-sambawan-day" -> maripipi), or
// the island named in the request (build-your-own trips).
const islandFor = (b: { packageId?: string; islandId?: string }) =>
  islandById(b.packageId ? String(b.packageId).split('-')[0] : String(b.islandId ?? ''));

// Availability calendar of one package: GET /api/packages/:id/calendar?from&count&guests
app.get('/api/packages/:id/calendar', async (req, res) => {
  const island = islandFor({ packageId: req.params.id });
  if (!island) return res.status(404).json({ error: 'Unknown package' });
  try {
    res.json(await callIsland(island, 'PackageCalendar', {
      packageId: req.params.id, from: (req.query.from as string) || today(),
      count: Number(req.query.count) || 42, guests: Math.max(1, Number(req.query.guests) || 1),
    }, 5000));
  } catch (err) {
    res.status(httpStatus(err)).json({ error: errorText(err) });
  }
});

// Price and end date before booking: POST /api/quote { packageId, extraHours }
// or { islandId, items: [{serviceId, qty}], days } (build-your-own).
app.post('/api/quote', async (req, res) => {
  const b = req.body ?? {};
  const island = islandFor(b);
  if (!island) return res.status(404).json({ error: 'Unknown package or island' });
  try {
    res.json(await callIsland(island, 'Quote', b, 5000));
  } catch (err) {
    res.status(httpStatus(err)).json({ error: errorText(err) });
  }
});

// The signed-in guest's bookings (Google sign-in through Supabase Auth):
// GET /api/me/bookings with "Authorization: Bearer <Supabase access token>".
// Central checks the token with Supabase and returns the copies whose
// e-mail matches the account's verified e-mail.
app.get('/api/me/bookings', async (req, res) => {
  if (!sb) return res.status(503).json({ error: 'Accounts need Supabase on central' });
  const jwt = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null }, error: null };
  const email = data.user?.email;
  if (error || !email) return res.status(401).json({ error: 'Sign in again' });
  const { data: rows, error: qErr } = await sb.from('booking_copies').select('*').ilike('email', email).order('day', { ascending: false }).limit(100);
  if (qErr) return res.status(500).json({ error: qErr.message });
  res.json({ email, bookings: rows ?? [] });
});

// Delete my account: POST /api/me/delete with the guest's Supabase token.
// Removes the sign-in account (Google link, settings). Bookings stay with the
// islands: they are the resorts' records and can still be looked up with the
// reference and e-mail.
app.post('/api/me/delete', async (req, res) => {
  if (!sb) return res.status(503).json({ error: 'Accounts need Supabase on central' });
  const jwt = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data, error } = jwt ? await sb.auth.getUser(jwt) : { data: { user: null }, error: null };
  if (error || !data.user) return res.status(401).json({ error: 'Sign in again' });
  const { error: delErr } = await sb.auth.admin.deleteUser(data.user.id);
  if (delErr) return res.status(500).json({ error: delErr.message });
  res.json({ deleted: true });
});

// [PDC: Saga] [PDC: Idempotency] Online booking, step 1 — HOLD. The owning island reserves every service
// (every day, for longer stays) in one atomic transaction (same code and rows as a walk-in) and
// returns a HELD booking that expires if unpaid. Idempotency-Key makes a retry
// after a timeout return the same booking instead of a second one.
app.post('/api/bookings', async (req, res) => {
  const b = req.body ?? {};
  const requestId = req.get('Idempotency-Key') ?? b.requestId;
  if (!requestId) return res.status(400).json({ error: 'Idempotency-Key header required' });
  const island = islandFor(b);
  if (!island) return res.status(404).json({ error: 'Unknown package or island' });
  try {
    // A package (+ extraHours), or build-your-own: items + days on islandId.
    const booking = await callIsland(island, 'HoldBooking', {
      requestId, packageId: b.packageId, extraHours: b.extraHours, extraDays: b.extraDays, items: b.items, days: b.days,
      day: b.day, guests: b.guests, guestName: b.guestName,
      email: b.email, phone: b.phone, idType: b.idType, idLast4: b.idLast4,
    }, 8000);
    res.status(201).json(booking);
  } catch (err) {
    res.status(httpStatus(err)).json({ error: errorText(err) });
  }
});

// [PDC: Saga] Step 2 — PAY (simulated), then CONFIRM or RELEASE. This is the saga:
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

// Cancel: POST /api/bookings/:ref/cancel { email } — the island returns the
// units and the answer says how much is refunded (refund_php).
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
// [PDC: Replication] [PDC: Idempotency] (duplicate events are ignored)
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
    payload: unmarshal(e.payload_json), created_at: new Date(Number(e.created_at_ms)).toISOString(),
  })), { onConflict: 'event_id', ignoreDuplicates: true });
  if (error) throw new LinkError('INTERNAL', error.message);

  // 2. Booking snapshots -> central's read-only copy (dashboard, reports, and
  //    "my booking" while the owning island is offline). Only a newer snapshot
  //    replaces an older one, so events arriving out of order cannot roll a
  //    booking back to an earlier status.
  const latest = new Map<string, Record<string, unknown>>();
  for (const e of events.filter((x) => x.type === 'BOOKING_UPDATED')) {
    const b = unmarshal<Record<string, unknown> & { reference: string; updated_at: number }>(e.payload_json);
    const prev = latest.get(b.reference) as { updated_at: number } | undefined;
    if (!prev || prev.updated_at <= b.updated_at) latest.set(b.reference, b);
  }
  // One upsert per booking, all sent at once (Supabase is a network hop away).
  const results = await Promise.all([...latest.values()].map((b) => sb.rpc('upsert_booking_copy', {
    p: {
      reference: b.reference, island_id: b.island_id, source: b.source, package_id: b.package_id,
      package_name: b.package_name, day: b.day, end_day: b.end_day ?? '', nights: b.nights, days: b.days ?? 1,
      extra_days: b.extra_days ?? 0, guests: b.guests, guest_name: b.guest_name,
      email: b.email ?? '', total_php: b.total_php, refund_php: b.refund_php ?? 0, status: b.status,
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
    // [PDC: Security] first frame must be a signed hello (shared/link.ts).
    const hello = parseFrame(data.toString());
    if (!hello) return ws.close(4002, 'bad hello');
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
    ws.send(marshal(frame.welcome(islandId)));
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
