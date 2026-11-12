/**
 * central/admin.ts
 *
 * Server side of the central dashboard (central/dashboard/):
 *  - POST /api/admin/login   : password -> signed session token (12 h)
 *  - GET  /api/admin/summary : everything the dashboard shows, in one call
 *
 * Central is public on the internet and the dashboard shows guest names, so
 * every admin endpoint needs a token. The password comes from ADMIN_PASSWORD
 * (central's .env, or the Render dashboard); without it the admin API is off.
 */
import type express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, today } from '../shared/config.ts';

// What the admin module needs from server.ts.
interface Deps {
  sb: SupabaseClient | null;
  secret: string;
  // Runs the live island fan-out (same as GET /api/listings).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  search: (mode: 'parallel' | 'sequential', day: string) => Promise<any>;
}

const TOKEN_HOURS = 12;

// ---------------------------------------------------------------------------
// Session tokens: "<expiry ms>.<hmac>" signed with the shared secret
// ---------------------------------------------------------------------------

function sign(secret: string, exp: number): string {
  return createHmac('sha256', secret).update(`admin:${exp}`).digest('hex');
}

function tokenValid(secret: string, token: string): boolean {
  const [expText, sig] = token.split('.');
  const exp = Number(expText);
  if (!exp || !sig || exp < Date.now()) return false;
  const expected = Buffer.from(sign(secret, exp), 'hex');
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Compares two strings in constant time (so the response time does not leak
// how much of the password was right).
function sameText(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

// A booking row from Supabase (online bookings).
interface OnlineBooking {
  id: string;
  listing_id: string;
  day: string;
  qty: number;
  nights: number;
  guest_name: string;
  total_php: number;
  code: string;
  status: string;
  created_at: string;
}

// An island event row from Supabase (synced from an island's outbox).
interface EventRow {
  event_id: string;
  island_id: string;
  type: string;
  booking_id: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
  created_at: string;
  received_at: string;
}

const islandOfListing = (listingId: string) => listingId.split('-')[0];
const dayOf = (iso: string) => iso.slice(0, 10);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountAdmin(app: express.Express, { sb, secret, search }: Deps): void {
  const password = process.env.ADMIN_PASSWORD ?? '';

  // Login: returns a token the dashboard sends as "Authorization: Bearer ...".
  app.post('/api/admin/login', (req, res) => {
    if (!password) return res.status(503).json({ error: 'Set ADMIN_PASSWORD on central to enable the dashboard' });
    if (!sameText(String(req.body?.password ?? ''), password)) return res.status(401).json({ error: 'Wrong password' });
    const exp = Date.now() + TOKEN_HOURS * 3600_000;
    res.json({ token: `${exp}.${sign(secret, exp)}`, expiresAt: exp });
  });

  // Guard for every other admin route.
  const requireAdmin: express.RequestHandler = (req, res, next) => {
    const token = (req.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!password || !tokenValid(secret, token)) return res.status(401).json({ error: 'Sign in again' });
    next();
  };

  // Everything the dashboard shows, computed from the live island fan-out
  // plus central's Supabase copies of online bookings and island events.
  app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
    const day = today();

    // 1. Live island status and listings (same parallel fan-out as search).
    const live = await search('parallel', day);

    // 2. Central's copies: online bookings and the latest island events.
    let bookings: OnlineBooking[] = [];
    let events: EventRow[] = [];
    if (sb) {
      const [b, e] = await Promise.all([
        sb.from('bookings').select('*').order('created_at', { ascending: false }).limit(1000),
        sb.from('island_events').select('*').order('received_at', { ascending: false }).limit(1000),
      ]);
      bookings = (b.data ?? []) as OnlineBooking[];
      events = (e.data ?? []) as EventRow[];
    }
    const walkins = events.filter((e) => e.type === 'WALKIN_BOOKED');
    const checkins = events.filter((e) => e.type === 'REDEEMED');

    // 3. KPI cards.
    const onlineToday = bookings.filter((b) => dayOf(b.created_at) === day && b.status !== 'CANCELLED').length;
    const walkinToday = walkins.filter((e) => dayOf(e.created_at) === day).length;
    const onlineSeats = live.listings.reduce((n: number, l: { online_available: number | null }) => n + (l.online_available ?? 0), 0);
    const kpis = {
      islandsOnline: live.islands.filter((i: { status: string }) => i.status === 'online').length,
      islandsTotal: live.islands.length,
      bookingsToday: onlineToday + walkinToday,
      onlineToday,
      walkinToday,
      checkedInToday: checkins.filter((e) => dayOf(e.created_at) === day).length,
      onlineSeatsToday: onlineSeats,
    };

    // 4. Bookings per island and per listing (all time, online + walk-in).
    const names = new Map<string, string>(live.listings.map((l: { id: string; name: string }) => [l.id, l.name]));
    const byIsland: Record<string, { online: number; walkin: number }> = {};
    const byListing: Record<string, number> = {};
    const count = (listing: string, kind: 'online' | 'walkin') => {
      const island = islandOfListing(listing);
      byIsland[island] ??= { online: 0, walkin: 0 };
      byIsland[island][kind]++;
      byListing[listing] = (byListing[listing] ?? 0) + 1;
    };
    for (const b of bookings) if (b.status !== 'CANCELLED') count(b.listing_id, 'online');
    for (const e of walkins) if (e.payload?.listing_id) count(e.payload.listing_id, 'walkin');

    // 5. Last 7 days, online vs walk-in.
    const daily = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(day, i - 6);
      return {
        day: d,
        online: bookings.filter((b) => dayOf(b.created_at) === d).length,
        walkin: walkins.filter((e) => dayOf(e.created_at) === d).length,
      };
    });

    // 6. Activity feed: newest island events and online bookings, merged.
    const activity = [
      ...events.slice(0, 30).map((e) => ({
        at: e.received_at,
        kind: e.type,
        island: e.island_id,
        text: e.type === 'WALKIN_BOOKED'
          ? `Walk-in ${e.payload?.code ?? ''} · ${names.get(e.payload?.listing_id) ?? e.payload?.listing_id ?? ''}`
          : e.type === 'REDEEMED' ? `Guest checked in (${e.payload?.source === 'ONLINE' ? 'online booking' : 'walk-in'})` : e.type,
      })),
      ...bookings.slice(0, 30).map((b) => ({
        at: b.created_at,
        kind: b.status === 'CANCELLED' ? 'CANCELLED' : 'ONLINE_BOOKED',
        island: islandOfListing(b.listing_id),
        text: `${b.status === 'CANCELLED' ? 'Cancelled' : 'Online booking'} ${b.code} · ${names.get(b.listing_id) ?? b.listing_id}`,
      })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);

    // 7. Upcoming arrivals: confirmed online bookings from today on.
    const arrivals = bookings
      .filter((b) => b.day >= day && b.status === 'CONFIRMED')
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .slice(0, 6)
      .map((b) => ({ day: b.day, guest: b.guest_name, listing: names.get(b.listing_id) ?? b.listing_id, island: islandOfListing(b.listing_id), qty: b.qty, code: b.code }));

    res.json({
      generatedAt: new Date().toISOString(),
      supabase: Boolean(sb),
      lastSyncAt: events[0]?.received_at ?? null,
      islands: live.islands,
      fanoutMs: live.fanoutMs,
      kpis,
      byIsland,
      byListing: Object.entries(byListing).map(([id, n]) => ({ id, name: names.get(id) ?? id, count: n }))
        .sort((a, b) => b.count - a.count),
      daily,
      activity,
      arrivals,
    });
  });
}
