/**
 * central/server.ts
 *
 * The "mainland" server (runs on Laptop 1). One process serves:
 *  - HTTP API for the Expo app : search, book, list, cancel
 *  - gRPC client to the islands: parallel search fan-out, register/cancel
 *                                online tickets on the owning island
 *  - gRPC CentralService       : receives the islands' outbox events
 *
 * Storage is Supabase (Postgres). Central owns the ONLINE pool; each island
 * owns its WALK-IN pool. Neither writes the other's data directly.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadNetwork, ticketSecret, today } from '../shared/config.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
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

// One gRPC client per island, created once and reused for every call.
const islands = network.islands.map((i) => ({
  id: i.id,
  client: new IslandService(`${i.host}:${i.grpcPort}`, grpc.credentials.createInsecure()),
}));
type Island = (typeof islands)[number];

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
    const reply = await call<object, { listings: ListingOut[] }>(island.client, 'GetCatalog', {});
    return { id: island.id, status: 'online' as const, ms: Math.round(performance.now() - started), listings: reply.listings };
  } catch (err) {
    return {
      id: island.id, status: 'offline' as const, ms: Math.round(performance.now() - started),
      error: (err as grpc.ServiceError).details, listings: [] as ListingOut[],
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

// Answers 503 and returns true when Supabase is not configured, so booking
// routes can bail out with `if (needSupabase(res)) return;`.
const needSupabase = (res: express.Response) => {
  if (sb) return false;
  res.status(503).json({ error: 'Online booking unavailable: Supabase not configured on central' });
  return true;
};

// Liveness check used by the app and tests.
app.get('/health', (_req, res) => res.json({ ok: true, supabase: Boolean(sb) }));

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
    call(island.client, 'RegisterOnlineBooking', {
      booking_id: booking.id, listing_id: booking.listing_id, date: booking.day, nights: booking.nights,
      qty: booking.qty, guest_name: booking.guest_name, id_type: booking.id_type,
      id_last4: booking.id_last4, code: booking.code,
    }).catch((err) => console.warn(`[central] could not register ${booking.code} on ${island.id}: ${err.details}`));
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
  if (island) call(island.client, 'CancelOnlineBooking', { booking_id: booking.id }).catch(() => {});

  res.json(booking);
});

// Listen on all interfaces so phones on the hotspot can reach this laptop.
app.listen(network.central.httpPort, '0.0.0.0', () => {
  console.log(`[central] HTTP API on http://localhost:${network.central.httpPort}`);
});

// ===========================================================================
// gRPC: CentralService (islands push their outbox here)
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

const grpcServer = new grpc.Server();
grpcServer.addService(CentralService.service, {
  // Receives a batch of island events and acknowledges the ones it stored.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  PushEvents: async (rpc: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => {
    const events = rpc.request.events as IslandEvent[];

    // Without Supabase there is nowhere to store events: log and acknowledge
    // them anyway so the sync can still be demonstrated.
    if (!sb) {
      for (const e of events) console.log(`[central] event ${e.type} from ${e.island_id} (${e.booking_id})`);
      return cb(null, { accepted_event_ids: events.map((e) => e.event_id) });
    }

    // 1. Store the events. ignoreDuplicates + the event_id primary key make
    //    re-delivery harmless (an island resends if it missed our ack).
    const { error } = await sb.from('island_events').upsert(events.map((e) => ({
      event_id: e.event_id, island_id: e.island_id, type: e.type, booking_id: e.booking_id || null,
      payload: JSON.parse(e.payload_json || '{}'), created_at: new Date(Number(e.created_at_ms)).toISOString(),
    })), { onConflict: 'event_id', ignoreDuplicates: true });
    if (error) return cb({ code: grpc.status.INTERNAL, details: error.message });

    // 2. An ONLINE ticket was checked in at an island: mirror the status so the
    //    guest's app shows "checked in". Walk-in events are only stored.
    const redeemed = events.filter((e) => e.type === 'REDEEMED' && JSON.parse(e.payload_json).source === 'ONLINE');
    for (const e of redeemed) {
      await sb.from('bookings').update({ status: 'REDEEMED', updated_at: new Date().toISOString() })
        .eq('id', e.booking_id).eq('status', 'CONFIRMED');
    }

    // 3. Acknowledge: the island marks these events as sent.
    cb(null, { accepted_event_ids: events.map((e) => e.event_id) });
  },
});
grpcServer.bindAsync(`0.0.0.0:${network.central.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[central] gRPC CentralService on :${network.central.grpcPort}`);
});
