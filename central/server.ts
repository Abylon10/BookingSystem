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
import { ROOT, loadNetwork, ticketSecret, today } from '../shared/config.ts';
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
  if (island.client) return call<object, Res>(island.client, method, request, timeoutMs);
  return Promise.reject(new LinkError('UNAVAILABLE', `${island.id} is not connected`));
}

// Which island owns a listing. Listing ids start with the island id by
// convention ("maripipi-sambawan-hopping" -> maripipi).
const islandOf = (listingId: string) => islands.find((i) => listingId.startsWith(`${i.id}-`));

// A booking row as returned by Supabase (the bookings table).
interface Booking {
  id: string;
  listing_id: string;
  day: string;
  nights: number;
  qty: number;
  guest_name: string;
  id_type: string;
  id_last4: string;
  code: string;
  status: string;
}

// ===========================================================================
// Search fan-out (the main parallelism demo on the read path)
// ===========================================================================

// A listing as merged into the search result. Fields come from the island's
// catalog (or Supabase's copy when the island is offline).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListingOut = Record<string, any> & { id: string };

// Asks one island for its catalog and measures how long it took. Never throws:
// an unreachable or partitioned island is reported as "offline" so the search
// can still return everything else.
async function fetchIsland(island: Island) {
  const started = performance.now();
  try {
    const reply = await callIsland<{ listings: ListingOut[] }>(island, 'GetCatalog', {});
    return {
      id: island.id, status: 'online' as const,
      via: !links.get(island.id)?.open ? 'grpc' : links.get(island.id) instanceof PollPeer ? 'poll' : 'link',
      ms: Math.round(performance.now() - started), listings: reply.listings,
    };
  } catch (err) {
    return {
      id: island.id, status: 'offline' as const, ms: Math.round(performance.now() - started),
      error: errorText(err), listings: [] as ListingOut[],
    };
  }
}

// Builds the search result for one day.
//   mode "parallel"   : ask all islands at the same time (total time = slowest island)
//   mode "sequential" : ask one after another (total time = sum of all islands)
// The sequential mode exists only so the benchmark can compare the two.
async function search(mode: 'parallel' | 'sequential', day: string) {
  const started = performance.now();

  // 1. Fan out to the islands.
  let results: Awaited<ReturnType<typeof fetchIsland>>[];
  if (mode === 'parallel') {
    results = await Promise.all(islands.map(fetchIsland));
  } else {
    results = [];
    for (const island of islands) results.push(await fetchIsland(island));
  }
  // Time spent talking to the islands only. This is what the parallel vs
  // sequential benchmark compares; the Supabase lookups below take the same
  // time in both modes and would only blur the difference.
  const fanoutMs = Math.round(performance.now() - started);

  // 2. For islands that did not answer, fall back to central's own copy of their
  //    catalog in Supabase, marked stale, so customers still see them.
  const offline = results.filter((r) => r.status === 'offline').map((r) => r.id);
  let stale: ListingOut[] = [];
  if (offline.length && sb) {
    const { data } = await sb.from('listings').select('*').in('island_id', offline);
    stale = (data ?? []).map((l) => ({ ...l, stale: true }));
  }

  // 3. Add how many units are left in the ONLINE pool for that day. This is
  //    the number the app may sell; the walk-in pool is not shown to customers.
  const onlineLeft = new Map<string, number>();
  if (sb) {
    const { data } = await sb.from('online_inventory').select('listing_id, available').eq('day', day);
    for (const row of data ?? []) onlineLeft.set(row.listing_id, row.available);
  }

  // 4. Merge and report timing per island (useful for the report and the app's status chips).
  const listings = [...results.flatMap((r) => r.listings), ...stale].map((l) => ({
    ...l, online_available: onlineLeft.get(l.id) ?? null,
  }));
  return {
    mode,
    day,
    fanoutMs,
    totalMs: Math.round(performance.now() - started),
    islands: results.map(({ listings: _unused, ...r }) => r),
    listings,
  };
}

// ===========================================================================
// HTTP API for the Expo app
// ===========================================================================

const app = express();
app.use(express.json());

// Central dashboard: static page at "/" plus its login-protected data API.
app.use(express.static(join(ROOT, 'central', 'dashboard')));
mountAdmin(app, { sb, secret, search });
// Island link fallback over plain HTTPS (central/poll.ts).
mountPolling(app, { secret, knownIslands, pollPeerFor, storeEvents });

// Answers 503 and returns true when Supabase is not configured, so booking
// routes can bail out with `if (needSupabase(res)) return;`.
const needSupabase = (res: express.Response) => {
  if (sb) return false;
  res.status(503).json({ error: 'Online booking unavailable: Supabase not configured on central' });
  return true;
};

// Liveness check used by the app, tests, the cloud host, and the islands'
// keep-awake ping. Also lists which islands are connected over a link.
app.get('/health', (_req, res) => res.json({
  ok: true, supabase: Boolean(sb), linkedIslands: [...links].filter(([, p]) => p.open).map(([id]) => id),
}));

// Search: GET /api/listings?day=YYYY-MM-DD[&mode=sequential]
app.get('/api/listings', async (req, res) => {
  const mode = req.query.mode === 'sequential' ? 'sequential' : 'parallel';
  const day = (req.query.day as string) ?? today();
  res.json(await search(mode, day));
});

// Book online: POST /api/bookings with an Idempotency-Key header.
app.post('/api/bookings', async (req, res) => {
  if (needSupabase(res)) return;

  // 1. Validate. The idempotency key lets the app retry safely after a
  //    timeout: the same key always returns the same booking.
  const b = req.body;
  const requestId = req.get('Idempotency-Key') ?? b.requestId;
  if (!requestId) return res.status(400).json({ error: 'Idempotency-Key header required' });
  if (!/^\d{4}$/.test(b.idLast4 ?? '')) return res.status(400).json({ error: 'idLast4 must be 4 digits' });

  // 2. Take units from the online pool and create the booking in one atomic
  //    database call (book_online in the migration). Concurrent buyers for the
  //    last room are serialized by Postgres; the losers get SOLD_OUT.
  const { data, error } = await sb!.rpc('book_online', {
    p_booking_id: randomUUID(), p_request_id: requestId, p_listing_id: b.listingId, p_day: b.day,
    p_nights: b.nights ?? 1, p_qty: b.qty, p_guest_name: b.guestName, p_guest_email: b.guestEmail,
    p_id_type: b.idType, p_id_last4: b.idLast4, p_code: newCode(secret),
  });
  if (error) {
    const status = error.message.includes('SOLD_OUT') ? 409 : error.message.includes('UNKNOWN_LISTING') ? 404 : 500;
    return res.status(status).json({ error: error.message });
  }
  const booking = data as Booking;

  // 3. Sign the QR ticket. The island can verify it offline with the shared secret.
  const qr = signTicket(secret, {
    v: 1, id: booking.id, code: booking.code, listing: booking.listing_id, day: booking.day,
    nights: booking.nights, qty: booking.qty, guest: booking.guest_name, idType: booking.id_type,
    idLast4: booking.id_last4,
  });

  // 4. Tell the owning island, so its desk can find the booking by manual code.
  //    Fire-and-forget: the customer does not wait for it. If the island is
  //    offline, scanning the signed QR at check-in registers it there anyway.
  const island = islandOf(booking.listing_id);
  if (island) {
    callIsland(island, 'RegisterOnlineBooking', {
      booking_id: booking.id, listing_id: booking.listing_id, date: booking.day, nights: booking.nights,
      qty: booking.qty, guest_name: booking.guest_name, id_type: booking.id_type,
      id_last4: booking.id_last4, code: booking.code,
    }).catch((err) => console.warn(`[central] could not register ${booking.code} on ${island.id}: ${errorText(err)}`));
  }

  res.status(201).json({ booking, ticket: { code: booking.code, qr } });
});

// My bookings: GET /api/bookings?email=... (newest first).
app.get('/api/bookings', async (req, res) => {
  if (needSupabase(res)) return;
  const { data, error } = await sb!.from('bookings').select('*')
    .eq('guest_email', String(req.query.email ?? '')).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Cancel (refund): POST /api/bookings/:id/cancel.
// This is the saga's compensating step: undo the booking and give the units
// back to the online pool, then tell the island so the ticket cannot be used.
app.post('/api/bookings/:id/cancel', async (req, res) => {
  if (needSupabase(res)) return;

  // 1. Cancel in Supabase (atomic; only a CONFIRMED booking can be cancelled).
  const { data, error } = await sb!.rpc('cancel_online', { p_booking_id: req.params.id });
  if (error) return res.status(error.message.includes('NOT_CANCELLABLE') ? 409 : 500).json({ error: error.message });
  const booking = data as Booking;

  // 2. Tell the owning island (best effort).
  // TODO(sync): queue and retry if the island is offline, so it cannot check in a cancelled ticket.
  const island = islandOf(booking.listing_id);
  if (island) callIsland(island, 'CancelOnlineBooking', { booking_id: booking.id }).catch(() => {});

  res.json(booking);
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

  // 2. An ONLINE ticket was checked in at an island: mirror the status so the
  //    guest's app shows "checked in". Walk-in events are only stored.
  const redeemed = events.filter((e) => e.type === 'REDEEMED' && JSON.parse(e.payload_json).source === 'ONLINE');
  for (const e of redeemed) {
    await sb.from('bookings').update({ status: 'REDEEMED', updated_at: new Date().toISOString() })
      .eq('id', e.booking_id).eq('status', 'CONFIRMED');
  }

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
