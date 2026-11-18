/**
 * central/admin.ts
 *
 * Server side of the central dashboard (central/dashboard/):
 *  - POST /api/admin/login   : password -> signed session token (12 h)
 *  - GET  /api/admin/summary   : the Dashboard page (summary of everything)
 *  - GET/POST /api/admin/islands : Islands page (list, register a new island)
 *  - GET  /api/admin/bookings  : Bookings page (all islands, filterable)
 *  - GET/POST /api/admin/accounts : Accounts page (island admin accounts)
 *  - GET  /api/admin/records   : Inventory page (revenue, walk-in vs online, usage)
 *  - GET  /api/admin/inventory : capacity used per island (Dashboard summary)
 *  - GET  /api/admin/report-bench : Reports page (parallel worker benchmark)
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
  // Calls one island's method (over its link or LAN gRPC).
  ask: <T = unknown>(islandId: string, method: string, request: object, timeoutMs?: number) => Promise<T>;
  // Every island with its name and whether it is linked right now.
  islandList: () => { id: string; name: string; prefix: string; builtIn: boolean; linked: boolean }[];
  // Registers a new island (saved in Supabase, live at once).
  registerIsland: (i: { id: string; name: string; prefix: string }) => Promise<void>;
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
  refund_php?: number;   // v3: money given back on cancellation
  extra_days?: number;   // v3: days beyond the package length
}

const dayOf = (iso: string) => iso.slice(0, 10);
// Bookings that count as sold (not undone holds or cancellations).
const SOLD = new Set(['HELD', 'CONFIRMED', 'CHECKED_IN']);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function mountAdmin(app: express.Express, { sb, secret, search, ask, islandList, registerIsland }: Deps): void {
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
      refundsPhp: copies.reduce((n, c) => n + (c.refund_php ?? 0), 0),
    });
  });

  // -------------------------------------------------------------------------
  // Islands page: list every island and register a new one. A new island
  // gets an id (its node runs as `npm run island -- <id>`), a name, and a
  // 3-letter prefix for its booking references.
  // -------------------------------------------------------------------------
  app.get('/api/admin/islands', requireAdmin, (_req, res) => res.json({ islands: islandList() }));
  app.post('/api/admin/islands', requireAdmin, async (req, res) => {
    const id = String(req.body?.id ?? '').trim().toLowerCase();
    const name = String(req.body?.name ?? '').trim();
    const prefix = String(req.body?.prefix ?? '').trim().toUpperCase();
    // Letters/digits only in the id: package ids are "<island id>-<name>".
    if (!/^[a-z][a-z0-9]{1,30}$/.test(id)) return res.status(400).json({ error: 'Island id: 2-31 lowercase letters or digits, starting with a letter (e.g. palompon)' });
    if (name.length < 2) return res.status(400).json({ error: 'Island name is required' });
    if (!/^[A-Z]{3}$/.test(prefix)) return res.status(400).json({ error: 'Prefix: exactly 3 letters (e.g. PAL)' });
    try {
      await registerIsland({ id, name, prefix });
      res.json({ id, name, prefix });
    } catch (err) {
      const code = (err as { code?: string }).code;
      res.status(code === 'ALREADY_EXISTS' ? 409 : code === 'UNAVAILABLE' ? 503 : 500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // Bookings page: every island's bookings (central's copies), filterable
  // -------------------------------------------------------------------------
  app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
    if (!sb) return res.json({ bookings: [] });
    let q = sb.from('booking_copies').select('*').order('received_at', { ascending: false }).limit(500);
    if (req.query.island) q = q.eq('island_id', String(req.query.island));
    if (req.query.status) q = q.eq('status', String(req.query.status));
    if (req.query.q) {
      const text = String(req.query.q).replace(/[%,()]/g, ' ').trim();
      q = q.or(`reference.ilike.%${text}%,guest_name.ilike.%${text}%,email.ilike.%${text}%`);
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ bookings: data ?? [] });
  });

  // -------------------------------------------------------------------------
  // Accounts page: island admin (and receptionist) accounts, created by the
  // central admin and stored on each island (logins work offline there)
  // -------------------------------------------------------------------------
  app.get('/api/admin/accounts', requireAdmin, async (_req, res) => {
    const list = await Promise.all(islandList().map(async (i) => {
      try {
        const r = await ask<{ staff: unknown[] }>(i.id, 'ListStaff', {}, 5000);
        return { ...i, online: true, staff: r.staff };
      } catch (err) {
        return { ...i, online: false, error: (err as Error).message, staff: [] };
      }
    }));
    res.json({ islands: list });
  });
  app.post('/api/admin/accounts', requireAdmin, async (req, res) => {
    const { islandId, username, password, role } = req.body ?? {};
    try {
      res.json(await ask(String(islandId), 'CreateStaff', { username, password, role: role === 'receptionist' ? 'receptionist' : 'node_admin' }, 8000));
    } catch (err) {
      const code = (err as { code?: string }).code;
      res.status(code === 'UNAVAILABLE' ? 503 : code === 'ALREADY_EXISTS' ? 409 : code === 'INVALID_ARGUMENT' ? 400 : 500)
        .json({ error: code === 'UNAVAILABLE' ? 'That island is offline; try again when it is connected' : (err as Error).message });
    }
  });
  app.post('/api/admin/accounts/active', requireAdmin, async (req, res) => {
    const { islandId, username, active } = req.body ?? {};
    try {
      res.json(await ask(String(islandId), 'SetStaffActive', { username, active: Boolean(active) }, 8000));
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // Inventory page (records): per island revenue, refunds and net, walk-in
  // vs online, and how much each package and service is used, for trips
  // from `from` to `to`. Asked of all islands in parallel (each island owns
  // its records). An offline island is summarised from central's booking
  // copies instead (money and walk-in/online only; no per-service usage).
  // -------------------------------------------------------------------------
  app.get('/api/admin/records', requireAdmin, async (req, res) => {
    const to = (req.query.to as string) || today();
    const from = (req.query.from as string) || addDays(to, -29);
    const PAID = new Set(['CONFIRMED', 'CHECKED_IN']);

    const islands = await Promise.all(islandList().map(async (i) => {
      try {
        return { ...(await ask<Record<string, unknown>>(i.id, 'GetRecords', { from, to }, 8000)), id: i.id, name: i.name, live: true };
      } catch {
        // Offline: summarise central's copies of this island's bookings.
        let copies: Copy[] = [];
        if (sb) {
          const { data } = await sb.from('booking_copies').select('*').eq('island_id', i.id).gte('day', from).lte('day', to).limit(5000);
          copies = (data ?? []) as Copy[];
        }
        const paid = copies.filter((c) => PAID.has(c.status));
        const side = (s: string) => {
          const x = paid.filter((c) => c.source === s);
          return { bookings: x.length, guests: x.reduce((n, c) => n + c.guests, 0), revenue: x.reduce((n, c) => n + c.total_php, 0) };
        };
        const cancelled = copies.filter((c) => c.status === 'CANCELLED');
        const kept = cancelled.reduce((n, c) => n + ((c.refund_php ?? 0) > 0 ? c.total_php - (c.refund_php ?? 0) : 0), 0);
        const walkin = side('WALKIN');
        const online = side('ONLINE');
        const byPkg = new Map<string, { id: string; name: string; bookings: number; guests: number; revenue: number; walkin: number; online: number }>();
        for (const c of paid) {
          const id = c.package_id === 'custom' ? 'custom' : c.package_id;
          const p = byPkg.get(id) ?? { id, name: id === 'custom' ? 'Build your own' : c.package_name, bookings: 0, guests: 0, revenue: 0, walkin: 0, online: 0 };
          p.bookings++; p.guests += c.guests; p.revenue += c.total_php; p[c.source === 'WALKIN' ? 'walkin' : 'online']++;
          byPkg.set(id, p);
        }
        const daily = new Map<string, { day: string; walkin: number; online: number }>();
        for (const c of paid) {
          const d = daily.get(c.day) ?? { day: c.day, walkin: 0, online: 0 };
          d[c.source === 'WALKIN' ? 'walkin' : 'online'] += c.total_php;
          daily.set(c.day, d);
        }
        return {
          id: i.id, name: i.name, live: false, from, to,
          revenue: walkin.revenue + online.revenue, refunds: copies.reduce((n, c) => n + (c.refund_php ?? 0), 0), kept,
          net: walkin.revenue + online.revenue + kept, bookings: paid.length, cancelled: cancelled.length,
          checkedIn: copies.filter((c) => c.status === 'CHECKED_IN').length, walkin, online,
          packages: [...byPkg.values()].sort((a, b) => b.revenue - a.revenue), services: [],
          daily: [...daily.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        };
      }
    }));
    res.json({ from, to, islands });
  });

  // -------------------------------------------------------------------------
  // Capacity (kept for the Dashboard summary): each island's inventory for a
  // date range, read live from the islands in parallel and copied to
  // Supabase (inventory_copies), plus
  // activity statistics per island from the booking copies. An offline
  // island shows its last copy, marked stale.
  // -------------------------------------------------------------------------
  app.get('/api/admin/inventory', requireAdmin, async (req, res) => {
    const day = (req.query.day as string) || today();
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 7));
    const end = addDays(day, days);

    // 1. Live inventory from every island at once.
    type Row = { id: string; name: string; kind: string; price_php: number; day: string; capacity: number; booked: number; blocked: number; off: boolean };
    const live = await Promise.all(islandList().map(async (i) => {
      try {
        const r = await ask<{ inventory: Row[]; overview: Record<string, unknown> }>(i.id, 'GetInventory', { day, days }, 8000);
        return { island: i, rows: r.inventory, overview: r.overview, stale: false, syncedAt: new Date().toISOString() };
      } catch {
        return { island: i, rows: null as Row[] | null, overview: null, stale: true, syncedAt: null as string | null };
      }
    }));

    // 2. Keep central's copy current; read the copy for offline islands.
    if (sb) {
      const fresh = live.filter((l) => l.rows).flatMap((l) => l.rows!.map((r) => ({
        island_id: l.island.id, service_id: r.id, day: r.day, service_name: r.name, kind: r.kind,
        capacity: r.capacity, booked: r.booked, blocked: r.blocked, off: r.off, price_php: r.price_php, synced_at: new Date().toISOString(),
      })));
      if (fresh.length) {
        const { error } = await sb.from('inventory_copies').upsert(fresh, { onConflict: 'island_id,service_id,day' });
        if (error) console.warn(`[central] inventory copy not saved: ${error.message}`);
      }
      for (const l of live.filter((x) => !x.rows)) {
        const { data } = await sb.from('inventory_copies').select('*').eq('island_id', l.island.id).gte('day', day).lt('day', end);
        l.rows = (data ?? []).map((c) => ({ id: c.service_id, name: c.service_name, kind: c.kind, price_php: c.price_php, day: c.day, capacity: c.capacity, booked: c.booked, blocked: c.blocked, off: c.off }));
        l.syncedAt = data?.[0]?.synced_at ?? null;
      }
    }

    // 3. Activity statistics per island from central's booking copies.
    let copies: Copy[] = [];
    if (sb) {
      const { data } = await sb.from('booking_copies').select('*').gte('day', addDays(day, -30)).lt('day', end).limit(5000);
      copies = (data ?? []) as Copy[];
    }

    // 4. Per island: utilisation, per-service table, per-day series, activity.
    const islandsOut = live.map((l) => {
      const rows = l.rows ?? [];
      const services = new Map<string, { id: string; name: string; kind: string; price_php: number; capacity: number; booked: number; offDays: number; days: number }>();
      const perDay = new Map<string, { day: string; capacity: number; booked: number }>();
      for (const r of rows) {
        const s = services.get(r.id) ?? { id: r.id, name: r.name, kind: r.kind, price_php: r.price_php, capacity: 0, booked: 0, offDays: 0, days: 0 };
        s.capacity += r.capacity; s.booked += r.booked; s.days += 1; if (r.off) s.offDays += 1;
        services.set(r.id, s);
        const d = perDay.get(r.day) ?? { day: r.day, capacity: 0, booked: 0 };
        d.capacity += r.capacity; d.booked += r.booked;
        perDay.set(r.day, d);
      }
      const cap = rows.reduce((n, r) => n + r.capacity, 0);
      const booked = rows.reduce((n, r) => n + r.booked, 0);
      const mine = copies.filter((c) => c.island_id === l.island.id);
      const sold = mine.filter((c) => SOLD.has(c.status));
      return {
        id: l.island.id, name: l.island.name, online: !l.stale, syncedAt: l.syncedAt,
        utilisation: cap ? Math.round((booked / cap) * 1000) / 10 : 0,
        unitsBooked: booked, unitsCapacity: cap,
        servicesOffToday: rows.filter((r) => r.day === day && r.off).length,
        services: [...services.values()].map((s) => ({ ...s, utilisation: s.capacity ? Math.round((s.booked / s.capacity) * 1000) / 10 : 0 })),
        perDay: [...perDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
        activity: {
          bookings: sold.length,
          online: sold.filter((c) => c.source === 'ONLINE').length,
          walkin: sold.filter((c) => c.source === 'WALKIN').length,
          checkedIn: mine.filter((c) => c.status === 'CHECKED_IN').length,
          cancelled: mine.filter((c) => c.status === 'CANCELLED').length,
          revenuePhp: sold.reduce((n, c) => n + c.total_php, 0),
          refundsPhp: mine.reduce((n, c) => n + (c.refund_php ?? 0), 0),
          extraDays: sold.reduce((n, c) => n + (c.extra_days ?? 0), 0),
          custom: sold.filter((c) => c.package_id === 'custom').length,
        },
      };
    });
    res.json({ day, days, islands: islandsOut });
  });
}
