import express from 'express';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadNetwork, ticketSecret } from '../shared/config.ts';
import { CentralService, IslandService, call, grpc } from '../shared/rpc.ts';
import { newCode, signTicket } from '../shared/ticket.ts';

const network = loadNetwork();
const secret = ticketSecret();

// Supabase is optional while developing: without it, search still works (live
// from the islands) but online booking is disabled.
const sb: SupabaseClient | null = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;
if (!sb) console.warn('[central] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — online booking disabled');

const islands = network.islands.map((i) => ({
  id: i.id,
  client: new IslandService(`${i.host}:${i.grpcPort}`, grpc.credentials.createInsecure()),
}));
const islandOf = (listingId: string) => islands.find((i) => listingId.startsWith(`${i.id}-`));

// ---------- Search fan-out (the main parallelism demo on the read path) ----------

async function fetchIsland(island: (typeof islands)[number]) {
  const started = performance.now();
  try {
    const reply = await call<object, { listings: any[] }>(island.client, 'GetCatalog', {});
    return { id: island.id, status: 'online', ms: Math.round(performance.now() - started), listings: reply.listings };
  } catch (err) {
    return { id: island.id, status: 'offline', ms: Math.round(performance.now() - started),
      error: (err as grpc.ServiceError).details, listings: [] as any[] };
  }
}

async function search(mode: 'parallel' | 'sequential', day: string) {
  const started = performance.now();
  let results;
  if (mode === 'parallel') {
    results = await Promise.all(islands.map(fetchIsland));
  } else {
    results = [];
    for (const island of islands) results.push(await fetchIsland(island));
  }

  // Offline islands: fall back to central's (possibly stale) catalog copy.
  const offline = results.filter((r) => r.status === 'offline').map((r) => r.id);
  let stale: any[] = [];
  if (offline.length && sb) {
    const { data } = await sb.from('listings').select('*').in('island_id', offline);
    stale = (data ?? []).map((l) => ({ ...l, stale: true }));
  }

  // Online pool for the requested day (what the app is allowed to sell).
  const onlineLeft = new Map<string, number>();
  if (sb) {
    const { data } = await sb.from('online_inventory').select('listing_id, available').eq('day', day);
    for (const row of data ?? []) onlineLeft.set(row.listing_id, row.available);
  }

  const listings = [...results.flatMap((r) => r.listings), ...stale].map((l) => ({
    ...l, online_available: onlineLeft.get(l.id) ?? null,
  }));
  return {
    mode,
    day,
    totalMs: Math.round(performance.now() - started),
    islands: results.map(({ listings: _l, ...r }) => r),
    listings,
  };
}

// ---------- HTTP API for the Expo app ----------

const app = express();
app.use(express.json());

const needSupabase = (res: express.Response) => {
  if (sb) return false;
  res.status(503).json({ error: 'Online booking unavailable: Supabase not configured on central' });
  return true;
};

app.get('/health', (_req, res) => res.json({ ok: true, supabase: Boolean(sb) }));

app.get('/api/listings', async (req, res) => {
  const mode = req.query.mode === 'sequential' ? 'sequential' : 'parallel';
  const day = (req.query.day as string) ?? new Date().toISOString().slice(0, 10);
  res.json(await search(mode, day));
});

app.post('/api/bookings', async (req, res) => {
  if (needSupabase(res)) return;
  const b = req.body;
  const requestId = req.get('Idempotency-Key') ?? b.requestId;
  if (!requestId) return res.status(400).json({ error: 'Idempotency-Key header required' });
  if (!/^\d{4}$/.test(b.idLast4 ?? '')) return res.status(400).json({ error: 'idLast4 must be 4 digits' });

  const { data, error } = await sb!.rpc('book_online', {
    p_booking_id: randomUUID(), p_request_id: requestId, p_listing_id: b.listingId, p_day: b.day,
    p_nights: b.nights ?? 1, p_qty: b.qty, p_guest_name: b.guestName, p_guest_email: b.guestEmail,
    p_id_type: b.idType, p_id_last4: b.idLast4, p_code: newCode(secret),
  });
  if (error) {
    const status = error.message.includes('SOLD_OUT') ? 409 : error.message.includes('UNKNOWN_LISTING') ? 404 : 500;
    return res.status(status).json({ error: error.message });
  }

  const booking = data as any;
  const qr = signTicket(secret, {
    v: 1, id: booking.id, code: booking.code, listing: booking.listing_id, day: booking.day,
    nights: booking.nights, qty: booking.qty, guest: booking.guest_name, idType: booking.id_type,
    idLast4: booking.id_last4,
  });

  // Tell the owning island so its desk can look the code up. Best effort: if the
  // island is offline, the signed QR still lets it verify at check-in.
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

app.get('/api/bookings', async (req, res) => {
  if (needSupabase(res)) return;
  const { data, error } = await sb!.from('bookings').select('*')
    .eq('guest_email', String(req.query.email ?? '')).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/bookings/:id/cancel', async (req, res) => {
  if (needSupabase(res)) return;
  const { data, error } = await sb!.rpc('cancel_online', { p_booking_id: req.params.id });
  if (error) return res.status(error.message.includes('NOT_CANCELLABLE') ? 409 : 500).json({ error: error.message });
  const island = islandOf((data as any).listing_id);
  // TODO(sync): queue and retry if the island is offline, so it cannot check in a cancelled ticket.
  island?.client && call(island.client, 'CancelOnlineBooking', { booking_id: req.params.id }).catch(() => {});
  res.json(data);
});

app.listen(network.central.httpPort, '0.0.0.0', () => {
  console.log(`[central] HTTP API on http://localhost:${network.central.httpPort}`);
});

// ---------- gRPC: CentralService (islands push their outbox here) ----------

const grpcServer = new grpc.Server();
grpcServer.addService(CentralService.service, {
  PushEvents: async (rpc: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => {
    const events = rpc.request.events as any[];
    if (!sb) {
      // Nowhere to store them yet: log and accept so the demo still shows sync.
      for (const e of events) console.log(`[central] event ${e.type} from ${e.island_id} (${e.booking_id})`);
      return cb(null, { accepted_event_ids: events.map((e) => e.event_id) });
    }
    const { error } = await sb.from('island_events').upsert(events.map((e) => ({
      event_id: e.event_id, island_id: e.island_id, type: e.type, booking_id: e.booking_id || null,
      payload: JSON.parse(e.payload_json || '{}'), created_at: new Date(Number(e.created_at_ms)).toISOString(),
    })), { onConflict: 'event_id', ignoreDuplicates: true });
    if (error) return cb({ code: grpc.status.INTERNAL, details: error.message });

    // Online tickets checked in at an island: mirror the status so the app shows it.
    const redeemed = events.filter((e) => e.type === 'REDEEMED' && JSON.parse(e.payload_json).source === 'ONLINE');
    for (const e of redeemed) {
      await sb.from('bookings').update({ status: 'REDEEMED', updated_at: new Date().toISOString() })
        .eq('id', e.booking_id).eq('status', 'CONFIRMED');
    }
    cb(null, { accepted_event_ids: events.map((e) => e.event_id) });
  },
});
grpcServer.bindAsync(`0.0.0.0:${network.central.grpcPort}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) throw err;
  console.log(`[central] gRPC CentralService on :${network.central.grpcPort}`);
});
