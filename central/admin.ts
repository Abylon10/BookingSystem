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
import { benchmark } from './reports.ts';

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

// A booking copy from Supabase (fed by the islands' outbox events).
interface Copy {
  reference: string;
  island_id: string;
  source: 'ONLINE' | 'WALKIN';
  package_id: string;
  package_name: string;
  day: string;
  guests: number;
  guest_name: string;
  total_php: number;
  status: string;
  created_at: string;
  received_at: string;
}

const dayOf = (iso: string) => iso.slice(0, 10);
// Bookings that count as sold (not undone holds or cancellations).
const SOLD = new Set(['HELD', 'CONFIRMED', 'CHECKED_IN']);

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

  // Parallel report benchmark (worker threads 1/2/4/8) on this server.
  // One at a time: a second request waits for the running one.
  let running: Promise<unknown> | null = null;
  app.get('/api/admin/report-bench', requireAdmin, async (req, res) => {
    const records = Math.min(Math.max(Number(req.query.records) || 2_000_000, 100_000), 20_000_000);
    try {
      while (running) await running;
      running = benchmark(records, [1, 2, 4, 8], 3);
      res.json(await running);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    } finally {
      running = null;
    }
  });

  // Everything the dashboard shows, computed from the live island fan-out
  // plus central's Supabase copies of online bookings and island events.
  app.get('/api/admin/summary', requireAdmin, async (_req, res) => {
    const day = today();

    // 1. Live island status and today's packages (same parallel fan-out as search).
    const live = await search('parallel', day);

    // 2. Central's copies of all bookings (online and walk-in) from every island.
    let copies: Copy[] = [];
    if (sb) {
      const { data } = await sb.from('booking_copies').select('*').order('received_at', { ascending: false }).limit(2000);
      copies = (data ?? []) as Copy[];
    }
    const sold = copies.filter((c) => SOLD.has(c.status));

    // 3. KPI cards.
    const madeToday = sold.filter((c) => dayOf(c.created_at) === day);
    const kpis = {
      islandsOnline: live.islands.filter((i: { status: string }) => i.status === 'online').length,
      islandsTotal: live.islands.length,
      bookingsToday: madeToday.length,
      onlineToday: madeToday.filter((c) => c.source === 'ONLINE').length,
      walkinToday: madeToday.filter((c) => c.source === 'WALKIN').length,
      checkedInToday: copies.filter((c) => c.status === 'CHECKED_IN' && c.day === day).length,
      packagesAvailable: live.packages.filter((p: { available: boolean }) => p.available).length,
      packagesTotal: live.packages.length,
      revenuePhp: sold.reduce((n, c) => n + c.total_php, 0),
    };

    // 4. Bookings per island (online vs walk-in) and per package.
    const byIsland: Record<string, { online: number; walkin: number }> = {};
    const byPackage: Record<string, { name: string; count: number }> = {};
    for (const c of sold) {
      byIsland[c.island_id] ??= { online: 0, walkin: 0 };
      byIsland[c.island_id][c.source === 'ONLINE' ? 'online' : 'walkin']++;
      byPackage[c.package_id] ??= { name: c.package_name, count: 0 };
      byPackage[c.package_id].count++;
    }

    // 5. Last 7 days, online vs walk-in (by booking date).
    const daily = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(day, i - 6);
      const that = sold.filter((c) => dayOf(c.created_at) === d);
      return { day: d, online: that.filter((c) => c.source === 'ONLINE').length, walkin: that.filter((c) => c.source === 'WALKIN').length };
    });

    // 6. Activity feed: newest changes first.
    const kindOf = (c: Copy) => c.status === 'CHECKED_IN' ? 'REDEEMED'
      : ['CANCELLED', 'RELEASED', 'EXPIRED'].includes(c.status) ? 'CANCELLED'
        : c.source === 'ONLINE' ? 'ONLINE_BOOKED' : 'WALKIN_BOOKED';
    const label: Record<string, string> = { REDEEMED: 'Checked in', CANCELLED: 'Cancelled', ONLINE_BOOKED: 'Online booking', WALKIN_BOOKED: 'Walk-in' };
    const activity = copies.slice(0, 12).map((c) => ({
      at: c.received_at,
      kind: kindOf(c),
      island: c.island_id,
      text: `${c.status === 'HELD' ? 'Online hold' : c.status === 'EXPIRED' ? 'Hold expired' : label[kindOf(c)]} ${c.reference} · ${c.package_name}`,
    }));

    // 7. Upcoming arrivals: confirmed bookings from today on.
    const arrivals = copies
      .filter((c) => c.status === 'CONFIRMED' && c.day >= day)
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .slice(0, 6)
      .map((c) => ({ day: c.day, guest: c.guest_name, listing: c.package_name, island: c.island_id, qty: c.guests, code: c.reference }));

    res.json({
      generatedAt: new Date().toISOString(),
      supabase: Boolean(sb),
      lastSyncAt: copies[0]?.received_at ?? null,
      islands: live.islands,
      fanoutMs: live.fanoutMs,
      kpis,
      byIsland,
      byListing: Object.entries(byPackage).map(([id, v]) => ({ id, name: v.name, count: v.count })).sort((a, b) => b.count - a.count),
      daily,
      activity,
      arrivals,
    });
  });
}
