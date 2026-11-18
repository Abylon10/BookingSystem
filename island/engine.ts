/**
 * island/engine.ts — [PDC: Concurrency control] [PDC: Synchronization]
 *
 * Booking logic of an island node, independent of HTTP / RPC:
 *  - catalog / availability : packages and services for a date, with the
 *                             reason when something is unavailable
 *  - calendar               : per-day status of a package (open / low / full / off)
 *  - reserve                : a package (plus optional extra days) or a
 *                             build-your-own trip; online hold or walk-in;
 *                             atomic over all services and days
 *  - confirm / release / cancel (with refund) / checkIn / expireHolds
 *  - checklist              : on/off switch per service per day
 *  - admin                  : create and edit services and packages with prices
 *  - staff                  : login accounts (scrypt password hashes)
 *
 * Every change writes an event to the outbox in the same transaction, so
 * central's copy follows without ever editing island data.
 *
 * Where the concurrency rules are:
 *   [PDC: Concurrency control]  reserve(): all units in ONE transaction, each
 *                               with the guard booked + blocked + qty <= capacity
 *   [PDC: Idempotency]          reserve(): same request id -> same booking
 *   [PDC: Synchronization]      transition(): a status changes only from the
 *                               expected status, so it can happen only once
 *
 * Pricing rules:
 *  - package: price (per guest or per package) covers the package time (a
 *    day trip 12 hours, an overnight stay 24 hours per night). Each extra
 *    hour after that adds the package's hourly fee (₱50 by default). When the
 *    extra hours run into another day, the services are reserved that day too.
 *  - build-your-own: each service's day price × quantity × days.
 *  - cancellation refund: everything paid if cancelled before the trip date,
 *    half on the trip date itself, nothing for an unpaid hold.
 */
import { randomInt, randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { addDays, today } from '../shared/config.ts';
import { addOutbox, extendInventory, transaction, type Db } from './db.ts';

// An error that carries the HTTP status / RPC code for the caller.
export class BookingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = 'FAILED_PRECONDITION') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface PackageRow {
  id: string; name: string; location: string; description: string;
  price_php: number; pricing: 'per_guest' | 'per_package'; nights: number; max_guests: number; active: number;
  extra_day_php: number;
  extra_hour_php: number;
  fun_fact: string;
}
export interface ServiceRow {
  id: string; kind: string; name: string; capacity: number; price_php: number; unit: 'person' | 'room' | 'trip'; active: number;
}
interface ItemRow { package_id: string; service_id: string; qty: number; per_guest: number; kind: string; service_name: string }
export interface BookingRow {
  id: string; reference: string; request_id: string | null; source: 'ONLINE' | 'WALKIN';
  package_id: string; package_name: string; day: string; end_day: string; nights: number; days: number; extra_days: number; extra_hours: number;
  guests: number; guest_name: string; email: string; phone: string; id_type: string; id_last4: string;
  total_php: number; refund_php: number; status: string; hold_expires_at: number | null; created_by: string;
  created_at: number; updated_at: number; checked_in_at: number | null;
}

// What a booking request carries. Either packageId (+ optional extraHours:
// extra time after the package's hours; extraDays = 24 h each, older apps) or
// items (build-your-own: services and quantities, for `days` days).
export interface ReserveRequest {
  requestId: string;
  packageId?: string;
  extraDays?: number;
  extraHours?: number;
  items?: { serviceId: string; qty: number }[];
  days?: number;
  day: string;
  guests: number;
  guestName: string;
  email?: string;
  phone?: string;
  idType: string;
  idLast4: string;
}

// The units a booking takes, its price and its dates (before it is saved).
interface Plan {
  packageId: string;
  name: string;
  lines: { serviceId: string; day: string; qty: number }[];
  total: number;
  nights: number;
  days: number;
  extraDays: number;
  extraHours: number;
  endDay: string;
}

// Longest stay one booking may cover (keeps a request from locking a season).
const MAX_DAYS = 14;
// Most extra hours an online booking may add to a package (one day).
const MAX_ONLINE_EXTRA_HOURS = 24;

// Extra time asked for, in hours (extraDays from older apps = 24 h each).
const extraHoursOf = (req: { extraHours?: number; extraDays?: number }) =>
  Math.max(0, Math.floor(Number(req.extraHours ?? (Number(req.extraDays) || 0) * 24) || 0));

// Input for creating/editing a service or package (node admin).
export interface ServiceInput { id?: string; name: string; kind: string; capacity: number; pricePhp: number; unit: string; active?: boolean }
export interface PackageInput {
  id?: string; name: string; location: string; description: string; pricePhp: number; pricing: string;
  nights: number; maxGuests: number; extraHourPhp: number; funFact?: string; active?: boolean;
  items: { serviceId: string; qty: number; perGuest: boolean }[];
}

// ---------------------------------------------------------------------------
// Engine (one per island)
// ---------------------------------------------------------------------------

export function createEngine(db: Db, island: { id: string; name: string; prefix: string }, holdMinutes: number, inventoryDays = 60) {
  const getPackage = (id: string) => db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRow | undefined;
  const getService = (id: string) => db.prepare('SELECT * FROM services WHERE id = ?').get(id) as ServiceRow | undefined;
  const itemsOf = (packageId: string) => db.prepare(
    `SELECT pi.*, s.kind, s.name AS service_name FROM package_items pi JOIN services s ON s.id = pi.service_id WHERE pi.package_id = ?`,
  ).all(packageId) as unknown as ItemRow[];
  const getBooking = (ref: string) => db.prepare('SELECT * FROM bookings WHERE reference = ?').get(String(ref).toUpperCase()) as BookingRow | undefined;
  const isOff = db.prepare('SELECT 1 FROM service_off WHERE service_id = ? AND day = ?');
  const freeOf = db.prepare('SELECT capacity - booked - blocked AS free FROM inventory WHERE service_id = ? AND day = ?');

  // ---- Planning: which units, which days, what price -----------------------

  // A package booking with `extraHours` after the package time. The package
  // time is 12 h for a day trip and 24 h per night for a stay; the extra
  // hours decide how many more days the services are reserved (rooms for
  // every night, other services on every day used).
  function planPackage(pkg: PackageRow, day: string, guests: number, extraHours: number): Plan {
    const baseHours = pkg.nights ? 24 * pkg.nights : 12;
    const totalHours = baseHours + extraHours;
    const extraDays = pkg.nights
      ? Math.max(0, Math.ceil(totalHours / 24) - pkg.nights)       // extra nights
      : Math.max(0, Math.ceil(totalHours / 24) - 1);               // extra days of a day trip
    const lines: Plan['lines'] = [];
    for (const it of itemsOf(pkg.id)) {
      const qty = it.qty * (it.per_guest ? guests : 1);
      const n = (it.kind === 'room' ? Math.max(1, pkg.nights) : 1) + extraDays;
      for (let d = 0; d < n; d++) lines.push({ serviceId: it.service_id, day: addDays(day, d), qty });
    }
    const perGuest = pkg.pricing === 'per_guest';
    const base = perGuest ? pkg.price_php * guests : pkg.price_php;
    const extra = extraHours * (pkg.extra_hour_php ?? 50);
    return {
      packageId: pkg.id, name: pkg.name, lines, total: base + extra, nights: pkg.nights,
      days: (pkg.nights || 0) + 1 + extraDays, extraDays, extraHours, endDay: addDays(day, pkg.nights + extraDays),
    };
  }

  // A build-your-own trip: each chosen service for `days` days.
  function planCustom(items: { serviceId: string; qty: number }[], day: string, days: number): Plan {
    if (!items.length) throw new BookingError(400, 'Choose at least one service', 'INVALID_ARGUMENT');
    const lines: Plan['lines'] = [];
    const names: string[] = [];
    let total = 0;
    let hasRoom = false;
    for (const it of items) {
      const s = getService(it.serviceId);
      const qty = Math.floor(Number(it.qty));
      if (!s || !s.active) throw new BookingError(404, `Unknown service ${it.serviceId}`, 'NOT_FOUND');
      if (!(qty >= 1)) throw new BookingError(400, `Quantity for ${s.name} must be at least 1`, 'INVALID_ARGUMENT');
      for (let d = 0; d < days; d++) lines.push({ serviceId: s.id, day: addDays(day, d), qty });
      total += s.price_php * qty * days;
      names.push(s.name);
      if (s.kind === 'room') hasRoom = true;
    }
    return {
      packageId: 'custom', name: `Custom trip: ${names.join(', ')}`, lines, total, nights: hasRoom ? days : 0,
      days, extraDays: 0, extraHours: 0, endDay: addDays(day, hasRoom ? days : days - 1),
    };
  }

  // Services in a plan that are switched off, with the first day they're off.
  function offServices(plan: Plan) {
    const off = new Map<string, string>();
    for (const l of plan.lines) if (!off.has(l.serviceId) && isOff.get(l.serviceId, l.day)) off.set(l.serviceId, l.day);
    return [...off].map(([id, day]) => ({ id, name: getService(id)?.name ?? id, day }));
  }

  // How many bookings like this still fit (the tightest service/day decides).
  function spotsFor(plan: Plan) {
    let spots = Infinity;
    for (const l of plan.lines) {
      const row = freeOf.get(l.serviceId, l.day) as { free: number } | undefined;
      spots = Math.min(spots, row ? Math.floor(row.free / l.qty) : 0);
    }
    return spots === Infinity ? 0 : spots;
  }

  // ---- Snapshots -----------------------------------------------------------

  // The snapshot sent to central and returned to callers. `services` lists
  // what the booking uses (name and quantity per day).
  function snapshot(b: BookingRow) {
    const pkg = b.package_id === 'custom' ? undefined : getPackage(b.package_id);
    const services = db.prepare(
      `SELECT s.name, MAX(l.qty) AS qty, COUNT(*) AS days FROM booking_lines l JOIN services s ON s.id = l.service_id
        WHERE l.booking_id = ? GROUP BY l.service_id ORDER BY s.kind, s.name`,
    ).all(b.id) as { name: string; qty: number; days: number }[];
    return {
      reference: b.reference, island_id: island.id, island_name: island.name, source: b.source,
      package_id: b.package_id, package_name: b.package_name || pkg?.name || b.package_id, location: pkg?.location ?? island.name,
      day: b.day, end_day: b.end_day || addDays(b.day, b.nights), nights: b.nights, days: b.days, extra_days: b.extra_days, extra_hours: b.extra_hours ?? 0,
      guests: b.guests, guest_name: b.guest_name, email: b.email, phone: b.phone,
      id_type: b.id_type, id_last4: b.id_last4, total_php: b.total_php, refund_php: b.refund_php, status: b.status,
      hold_expires_at: b.hold_expires_at, created_at: b.created_at, updated_at: b.updated_at, checked_in_at: b.checked_in_at,
      services,
    };
  }
  const emit = (b: BookingRow) => addOutbox(db, 'BOOKING_UPDATED', b.id, snapshot(b));

  // New reference like "MRP-7F3K2" (unique constraint catches the rare repeat).
  const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const newReference = () => `${island.prefix}-${Array.from({ length: 5 }, () => ALPHA[randomInt(ALPHA.length)]).join('')}`;

  // Puts a booking's units back (release, expiry, cancellation).
  function giveBack(bookingId: string) {
    const back = db.prepare('UPDATE inventory SET booked = booked - ? WHERE service_id = ? AND day = ?');
    for (const l of db.prepare('SELECT * FROM booking_lines WHERE booking_id = ?').all(bookingId) as unknown as { service_id: string; day: string; qty: number }[]) {
      back.run(l.qty, l.service_id, l.day);
    }
  }

  // Refund for a cancellation: unpaid hold 0; paid and cancelled before the
  // trip date: everything; on the trip date: half.
  const refundFor = (b: BookingRow) => (b.status === 'HELD' ? 0 : today() < b.day ? b.total_php : Math.round(b.total_php / 2));

  // Moves a booking from one of `from` statuses to `to`, atomically: the
  // UPDATE only matches the expected status, so two desks (or a desk and the
  // expiry job) can never both apply it.
  // [PDC: Synchronization] Changes a booking's status only if it is still in
  // one of the `from` statuses (checked inside the transaction). Two desks
  // checking in the same guest, or a payment racing the hold expiry: only
  // the first one finds the expected status, the other gets a 409.
  function transition(ref: string, from: string[], to: string, extra: (b: BookingRow) => void = () => {}) {
    return transaction(db, () => {
      const b = getBooking(ref);
      if (!b) throw new BookingError(404, 'Booking not found', 'NOT_FOUND');
      const now = Date.now();
      const { changes } = db.prepare(
        `UPDATE bookings SET status = ?, updated_at = ?, checked_in_at = CASE WHEN ? = 'CHECKED_IN' THEN ? ELSE checked_in_at END
          WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`,
      ).run(to, now, to, now, b.id, ...from);
      if (changes === 0) throw new BookingError(409, `Booking is ${b.status}, cannot change it to ${to}`);
      extra(b);
      const updated = getBooking(ref)!;
      emit(updated);
      return snapshot(updated);
    });
  }

  // Validates and normalises a YYYY-MM-DD date within the bookable window.
  function checkDay(day: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new BookingError(400, 'day must be YYYY-MM-DD', 'INVALID_ARGUMENT');
    if (day < today()) throw new BookingError(400, 'That date has passed', 'INVALID_ARGUMENT');
    return day;
  }

  // Turns a name into an id part: "Kayak rental" -> "kayak-rental".
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

  return {
    snapshot,

    // ---- Catalog and availability -------------------------------------------

    // Catalog: active packages with their services.
    catalog() {
      const pkgs = db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY price_php').all() as unknown as PackageRow[];
      return pkgs.map((p) => ({
        ...p, island_id: island.id, island_name: island.name,
        items: itemsOf(p.id).map((i) => ({ service_id: i.service_id, name: i.service_name, kind: i.kind, qty: i.qty, per_guest: Boolean(i.per_guest) })),
      }));
    },

    // Packages for a date, guest count and extra days. `available` is false
    // when a service is switched off (listed in unavailable_services), sold
    // out, or the group is too big. `spots` is kept for the calendar only.
    availability(day: string, guests: number, extraHours = 0) {
      return this.catalog().map((p) => {
        const plan = planPackage(p, day, guests, extraHours);
        const off = offServices(plan);
        const spots = spotsFor(plan);
        const fits = guests <= p.max_guests;
        const reason = !fits ? `Up to ${p.max_guests} guests` : off.length ? `${off.map((o) => o.name).join(', ')} unavailable` : spots < 1 ? 'Fully booked' : null;
        return {
          ...p, day, guests, extra_hours: extraHours, extra_days: plan.extraDays, end_day: plan.endDay, days: plan.days,
          spots: fits && !off.length ? spots : 0, available: !reason, reason,
          unavailable_services: off, total_php: plan.total,
        };
      });
    },

    // Services for build-your-own: price, unit, and whether each can be
    // booked for `days` days from `day` (switched off / no free units).
    services(day: string, days = 1) {
      const rows = db.prepare('SELECT * FROM services WHERE active = 1 ORDER BY kind, name').all() as unknown as ServiceRow[];
      return rows.map((s) => {
        let free = Infinity;
        let offDay: string | null = null;
        for (let d = 0; d < days; d++) {
          const dd = addDays(day, d);
          const row = freeOf.get(s.id, dd) as { free: number } | undefined;
          free = Math.min(free, row ? row.free : 0);
          if (!offDay && isOff.get(s.id, dd)) offDay = dd;
        }
        const reason = offDay ? `Unavailable on ${offDay}` : free < 1 ? 'Fully booked' : null;
        return {
          id: s.id, name: s.name, kind: s.kind, unit: s.unit, price_php: s.price_php,
          free: free === Infinity ? 0 : free, available: !reason, reason,
        };
      });
    },

    // Calendar of a package for `count` days from `from`: per day "open",
    // "low" (2 or fewer left), "full", or "off" (a service switched off).
    calendar(packageId: string, from: string, count: number, guests: number) {
      const pkg = getPackage(packageId);
      if (!pkg || !pkg.active) throw new BookingError(404, 'Unknown package for this island', 'NOT_FOUND');
      return Array.from({ length: Math.min(Math.max(1, count), 62) }, (_, i) => {
        const day = addDays(from, i);
        const plan = planPackage(pkg, day, guests, 0);
        const off = offServices(plan);
        const spots = spotsFor(plan);
        const status = off.length ? 'off' : spots < 1 ? 'full' : spots <= 2 ? 'low' : 'open';
        return { day, status, note: off.length ? `${off.map((o) => o.name).join(', ')} unavailable` : null };
      });
    },

    // ---- Booking -------------------------------------------------------------

    // Price and dates of a request without booking it (the app's summary).
    quote(req: ReserveRequest) {
      const guests = Math.max(1, Number(req.guests) || 1);
      const plan = req.packageId
        ? planPackage(this.requirePackage(req.packageId), req.day, guests, extraHoursOf(req))
        : planCustom(req.items ?? [], req.day, Math.max(1, Math.floor(Number(req.days) || 1)));
      return { total_php: plan.total, days: plan.days, extra_hours: plan.extraHours, end_day: plan.endDay, name: plan.name, unavailable_services: offServices(plan), spots: spotsFor(plan) };
    },
    requirePackage(id: string) {
      const pkg = getPackage(id);
      if (!pkg || !pkg.active) throw new BookingError(404, 'Unknown package for this island', 'NOT_FOUND');
      return pkg;
    },

    // [PDC: Concurrency control] Reserve a package or a custom trip: HELD (online, expires unless paid)
    // or CONFIRMED (walk-in, paid at the desk). All units for all days are
    // taken in ONE transaction, each with the guard
    // "booked + blocked + qty <= capacity"; if any fails, everything rolls
    // back. Online and walk-in use this same code on the same rows, so the
    // race for the last room is decided here and can never oversell.
    reserve(req: ReserveRequest, source: 'ONLINE' | 'WALKIN', createdBy: string) {
      if (!/^\d{4}$/.test(req.idLast4 ?? '')) throw new BookingError(400, 'idLast4 must be 4 digits', 'INVALID_ARGUMENT');
      const guests = Number(req.guests);
      if (!(guests >= 1)) throw new BookingError(400, 'guests must be at least 1', 'INVALID_ARGUMENT');
      if (typeof req.guestName !== 'string' || !req.guestName.trim()) throw new BookingError(400, 'guest name is required', 'INVALID_ARGUMENT');
      if (typeof req.idType !== 'string' || !req.idType.trim()) throw new BookingError(400, 'ID type is required', 'INVALID_ARGUMENT');
      // Text fields must be plain short text (a bad request gets a clear 400,
      // never a database error).
      for (const [k, v, max] of [['guestName', req.guestName, 120], ['idType', req.idType, 40], ['email', req.email, 200], ['phone', req.phone, 40]] as const) {
        if (v != null && (typeof v !== 'string' || v.length > max)) throw new BookingError(400, `${k} must be text of at most ${max} characters`, 'INVALID_ARGUMENT');
      }
      checkDay(req.day);

      // [PDC: Idempotency] the same request id returns the same booking.
      const existing = db.prepare('SELECT * FROM bookings WHERE request_id = ?').get(req.requestId) as BookingRow | undefined;
      if (existing) return snapshot(existing);

      // Work out units, days and price for a package or a custom trip.
      let plan: Plan;
      if (req.packageId) {
        const pkg = this.requirePackage(req.packageId);
        if (guests > pkg.max_guests) throw new BookingError(400, `This package is for up to ${pkg.max_guests} guests`, 'INVALID_ARGUMENT');
        const extraHours = extraHoursOf(req);
        if (extraHours < 0 || extraHours > MAX_DAYS * 24) throw new BookingError(400, `Extra hours must be 0-${MAX_DAYS * 24}`, 'INVALID_ARGUMENT');
        // Online bookings (the app) may add up to 24 extra hours; longer stays
        // are arranged at the front desk.
        if (source === 'ONLINE' && extraHours > MAX_ONLINE_EXTRA_HOURS) {
          throw new BookingError(400, `Online bookings can add up to ${MAX_ONLINE_EXTRA_HOURS} extra hours`, 'INVALID_ARGUMENT');
        }
        plan = planPackage(pkg, req.day, guests, extraHours);
      } else {
        const days = Math.floor(Number(req.days) || 1);
        if (days < 1 || days > MAX_DAYS) throw new BookingError(400, `Days must be 1-${MAX_DAYS}`, 'INVALID_ARGUMENT');
        plan = planCustom(req.items ?? [], req.day, days);
      }

      // A switched-off service can't be sold (online or at the desk).
      const off = offServices(plan);
      if (off.length) throw new BookingError(409, `${off.map((o) => `${o.name} is unavailable on ${o.day}`).join('; ')}`, 'FAILED_PRECONDITION');

      const take = db.prepare('UPDATE inventory SET booked = booked + ? WHERE service_id = ? AND day = ? AND booked + blocked + ? <= capacity');
      return transaction(db, () => {
        for (const l of plan.lines) {
          if (take.run(l.qty, l.serviceId, l.day, l.qty).changes === 0) {
            throw new BookingError(409, `Sold out on ${l.day}`, 'RESOURCE_EXHAUSTED');
          }
        }
        const now = Date.now();
        const id = randomUUID();
        db.prepare(
          `INSERT INTO bookings (id, reference, request_id, source, package_id, package_name, day, end_day, nights, days, extra_days, extra_hours,
             guests, guest_name, email, phone, id_type, id_last4, total_php, status, hold_expires_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, newReference(), req.requestId, source, plan.packageId, plan.name, req.day, plan.endDay, plan.nights, plan.days, plan.extraDays, plan.extraHours,
          guests, req.guestName.trim(), req.email ?? '', req.phone ?? '', req.idType, req.idLast4, plan.total,
          source === 'ONLINE' ? 'HELD' : 'CONFIRMED', source === 'ONLINE' ? now + holdMinutes * 60_000 : null,
          createdBy, now, now);
        const addLine = db.prepare('INSERT INTO booking_lines VALUES (?, ?, ?, ?)');
        for (const l of plan.lines) addLine.run(id, l.serviceId, l.day, l.qty);
        const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as unknown as BookingRow;
        emit(b);
        return snapshot(b);
      });
    },

    // [PDC: Saga] Payment succeeded: HELD -> CONFIRMED, only if the hold has not expired.
    confirm(ref: string) {
      const b = getBooking(ref);
      if (b?.status === 'HELD' && b.hold_expires_at! < Date.now()) {
        this.expireHolds();
        throw new BookingError(409, 'The hold expired before payment', 'FAILED_PRECONDITION');
      }
      return transition(ref, ['HELD'], 'CONFIRMED');
    },
    // [PDC: Saga] compensation: payment failed or abandoned -> RELEASED, units returned.
    release: (ref: string) => transition(ref, ['HELD'], 'RELEASED', (b) => giveBack(b.id)),
    // Cancellation: HELD/CONFIRMED -> CANCELLED, units returned, refund recorded.
    cancel: (ref: string) => transition(ref, ['HELD', 'CONFIRMED'], 'CANCELLED', (b) => {
      giveBack(b.id);
      db.prepare('UPDATE bookings SET refund_php = ? WHERE id = ?').run(refundFor(b), b.id);
    }),
    // What a cancellation would refund right now (shown before confirming).
    refundPreview(ref: string) {
      const b = getBooking(ref);
      if (!b) throw new BookingError(404, 'Booking not found', 'NOT_FOUND');
      return { reference: b.reference, total_php: b.total_php, refund_php: refundFor(b) };
    },
    // Arrival confirmed after the ID check: CONFIRMED -> CHECKED_IN, once only.
    checkIn: (ref: string) => transition(ref, ['CONFIRMED'], 'CHECKED_IN'),

    // Holds past their expiry -> EXPIRED, units returned (runs every 30 s).
    expireHolds() {
      const old = db.prepare("SELECT reference FROM bookings WHERE status = 'HELD' AND hold_expires_at < ?").all(Date.now()) as { reference: string }[];
      for (const { reference } of old) {
        try { transition(reference, ['HELD'], 'EXPIRED', (b) => giveBack(b.id)); } catch { /* already changed */ }
      }
      return old.length;
    },

    get: (ref: string) => { const b = getBooking(ref); return b ? snapshot(b) : null; },

    // Search by reference or guest name (newest first).
    search(q: string) {
      const like = `%${q.trim()}%`;
      return (db.prepare(`SELECT * FROM bookings WHERE reference = ? OR guest_name LIKE ? ORDER BY created_at DESC LIMIT 50`)
        .all(q.trim().toUpperCase(), like) as unknown as BookingRow[]).map(snapshot);
    },
    recent: (limit = 100) => (db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as BookingRow[]).map(snapshot),
    arrivals: (day: string) => (db.prepare("SELECT * FROM bookings WHERE day = ? AND status IN ('CONFIRMED', 'CHECKED_IN') ORDER BY guest_name").all(day) as unknown as BookingRow[]).map(snapshot),

    // ---- Dashboard numbers ------------------------------------------------------

    // Console dashboard for one date: arrivals, check-ins, walk-ins, online,
    // cancellations, refunds, revenue, services switched off, plus a 7-day
    // trend (the 6 days before `day`, then `day`) for the small charts.
    overview(day: string) {
      const countsFor = (d: string) => {
        const b = db.prepare(
          `SELECT
             SUM(status IN ('CONFIRMED', 'CHECKED_IN'))                                    AS arrivals,
             SUM(status = 'CHECKED_IN')                                                    AS checkedIn,
             SUM(source = 'WALKIN' AND status IN ('CONFIRMED', 'CHECKED_IN'))             AS walkins,
             SUM(source = 'ONLINE' AND status IN ('CONFIRMED', 'CHECKED_IN'))             AS online,
             SUM(status = 'CANCELLED')                                                     AS cancelled,
             SUM(CASE WHEN status IN ('CONFIRMED', 'CHECKED_IN') THEN total_php ELSE 0 END) AS revenue,
             SUM(CASE WHEN status IN ('CONFIRMED', 'CHECKED_IN') AND source = 'ONLINE' THEN total_php ELSE 0 END) AS revenueOnline,
             SUM(CASE WHEN status IN ('CONFIRMED', 'CHECKED_IN') AND source = 'WALKIN' THEN total_php ELSE 0 END) AS revenueWalkin,
             SUM(refund_php)                                                               AS refunds
           FROM bookings WHERE day = ?`,
        ).get(d) as Record<string, number | null>;
        const off = (db.prepare('SELECT COUNT(*) AS n FROM service_off WHERE day = ?').get(d) as { n: number }).n;
        return {
          day: d, arrivals: b.arrivals ?? 0, checkedIn: b.checkedIn ?? 0, walkins: b.walkins ?? 0, online: b.online ?? 0,
          cancelled: b.cancelled ?? 0, revenue: b.revenue ?? 0, revenueOnline: b.revenueOnline ?? 0, revenueWalkin: b.revenueWalkin ?? 0,
          refunds: b.refunds ?? 0, servicesOff: off,
        };
      };
      const trend = Array.from({ length: 7 }, (_, i) => countsFor(addDays(day, i - 6)));
      const servicesTotal = (db.prepare('SELECT COUNT(*) AS n FROM services WHERE active = 1').get() as { n: number }).n;
      return { ...trend[6], servicesTotal, trend };
    },

    // Records for central's Inventory page: money, walk-in vs online, and how
    // much each package and service is used, for bookings whose trip starts
    // between `from` and `to` (inclusive).
    //  - revenue  : paid bookings (CONFIRMED / CHECKED_IN)
    //  - kept     : what the island keeps from paid bookings that were
    //               cancelled (total - refund; half on the trip day)
    //  - refunds  : money given back
    //  - services : times booked, units used (units × days), and direct
    //               revenue from build-your-own trips (day price × units)
    records(from: string, to: string) {
      const PAID = "status IN ('CONFIRMED', 'CHECKED_IN')";
      const inRange = 'day >= ? AND day <= ?';
      const one = (sql: string) => db.prepare(sql).get(from, to) as Record<string, number | null>;
      const n = (v: number | null | undefined) => v ?? 0;

      // Totals and the walk-in / online split.
      const bySource = (source: 'WALKIN' | 'ONLINE') => {
        const r = one(`SELECT COUNT(*) AS bookings, SUM(guests) AS guests, SUM(total_php) AS revenue
                         FROM bookings WHERE ${inRange} AND ${PAID} AND source = '${source}'`);
        return { bookings: n(r.bookings), guests: n(r.guests), revenue: n(r.revenue) };
      };
      const walkin = bySource('WALKIN');
      const online = bySource('ONLINE');
      const c = one(`SELECT COUNT(*) AS cancelled, SUM(refund_php) AS refunds,
                            SUM(CASE WHEN refund_php > 0 THEN total_php - refund_php ELSE 0 END) AS kept
                       FROM bookings WHERE ${inRange} AND status = 'CANCELLED'`);
      const checkedIn = n(one(`SELECT COUNT(*) AS k FROM bookings WHERE ${inRange} AND status = 'CHECKED_IN'`).k);
      const revenue = walkin.revenue + online.revenue;

      // Per package (build-your-own trips grouped together).
      const packages = (db.prepare(
        `SELECT CASE WHEN package_id = 'custom' THEN 'custom' ELSE package_id END AS id,
                MAX(CASE WHEN package_id = 'custom' THEN 'Build your own' ELSE package_name END) AS name,
                COUNT(*) AS bookings, SUM(guests) AS guests, SUM(total_php) AS revenue,
                SUM(source = 'WALKIN') AS walkin, SUM(source = 'ONLINE') AS online
           FROM bookings WHERE ${inRange} AND ${PAID} GROUP BY 1 ORDER BY revenue DESC`,
      ).all(from, to) as Record<string, unknown>[]).map((p) => ({
        ...p, name: p.id === 'custom' ? 'Build your own' : (getPackage(String(p.id))?.name ?? p.name),
      }));

      // Per service: how often and how much it is used.
      const services = db.prepare(
        `SELECT s.id, s.name, s.kind, s.unit, s.price_php,
                COUNT(DISTINCT b.id)                                         AS bookings,
                COALESCE(SUM(l.qty), 0)                                      AS units,
                COUNT(DISTINCT CASE WHEN b.source = 'WALKIN' THEN b.id END) AS walkin,
                COUNT(DISTINCT CASE WHEN b.source = 'ONLINE' THEN b.id END) AS online,
                COALESCE(SUM(CASE WHEN b.package_id = 'custom' THEN l.qty * s.price_php ELSE 0 END), 0) AS direct_revenue
           FROM services s
           LEFT JOIN booking_lines l ON l.service_id = s.id
           LEFT JOIN bookings b ON b.id = l.booking_id AND b.day >= ? AND b.day <= ? AND b.${PAID}
          WHERE s.id <> ''
          GROUP BY s.id ORDER BY units DESC, s.name`,
      ).all(from, to) as Record<string, number | string>[];
      // LEFT JOIN keeps lines of bookings outside the range with b = NULL;
      // count only lines whose booking matched.
      const usage = db.prepare(
        `SELECT l.service_id AS id, SUM(l.qty) AS units FROM booking_lines l JOIN bookings b ON b.id = l.booking_id
          WHERE b.day >= ? AND b.day <= ? AND b.${PAID} GROUP BY l.service_id`,
      ).all(from, to) as { id: string; units: number }[];
      const unitsOf = Object.fromEntries(usage.map((u) => [u.id, u.units]));

      // Revenue per trip day, walk-in vs online (for the chart).
      const daily = db.prepare(
        `SELECT day, SUM(CASE WHEN source = 'WALKIN' THEN total_php ELSE 0 END) AS walkin,
                     SUM(CASE WHEN source = 'ONLINE' THEN total_php ELSE 0 END) AS online
           FROM bookings WHERE ${inRange} AND ${PAID} GROUP BY day ORDER BY day`,
      ).all(from, to);

      return {
        island_id: island.id, island_name: island.name, from, to,
        revenue, refunds: n(c.refunds), kept: n(c.kept), net: revenue + n(c.kept),
        bookings: walkin.bookings + online.bookings, cancelled: n(c.cancelled), checkedIn,
        walkin, online, packages,
        services: services.map((s) => ({ ...s, units: unitsOf[String(s.id)] ?? 0 })),
        daily,
      };
    },

    // Inventory for `days` days from `day`: per service per day capacity,
    // booked, blocked and on/off. Used by the checklist and by central's
    // Inventory page.
    inventory(day: string, days = 1) {
      const rows = db.prepare(
        `SELECT s.id, s.name, s.kind, s.unit, s.price_php, s.active, i.day, i.capacity, i.booked, i.blocked,
                (SELECT 1 FROM service_off o WHERE o.service_id = s.id AND o.day = i.day) AS off
           FROM services s JOIN inventory i ON i.service_id = s.id
          WHERE i.day >= ? AND i.day < ? ORDER BY s.kind, s.name, i.day`,
      ).all(day, addDays(day, Math.max(1, days))) as Record<string, unknown>[];
      return rows.map((r) => ({ ...r, off: Boolean(r.off), free: Number(r.capacity) - Number(r.booked) - Number(r.blocked) }));
    },

    // ---- On/off checklist (desk) ---------------------------------------------

    // Switch a service off (unavailable) or on for `days` days from `day`.
    // Off: new bookings that need it are refused; existing ones are listed so
    // the desk can call those guests.
    setServiceOff(serviceId: string, day: string, off: boolean, user: string, days = 1) {
      const s = getService(serviceId);
      if (!s) throw new BookingError(404, 'Unknown service', 'NOT_FOUND');
      return transaction(db, () => {
        const affected: { reference: string; guest_name: string; day: string }[] = [];
        for (let d = 0; d < Math.max(1, days); d++) {
          const dd = addDays(day, d);
          if (off) {
            db.prepare('INSERT OR REPLACE INTO service_off VALUES (?, ?, ?, ?)').run(serviceId, dd, user, Date.now());
            affected.push(...db.prepare(
              `SELECT DISTINCT b.reference, b.guest_name, l.day FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
                WHERE l.service_id = ? AND l.day = ? AND b.status IN ('HELD', 'CONFIRMED')`,
            ).all(serviceId, dd) as typeof affected);
          } else {
            db.prepare('DELETE FROM service_off WHERE service_id = ? AND day = ?').run(serviceId, dd);
          }
        }
        addOutbox(db, 'SERVICE_TOGGLED', null, { service_id: serviceId, service_name: s.name, day, days, off, by: user });
        return { ok: true, service: s.name, off, affected };
      });
    },

    // ---- Admin: services and packages ------------------------------------------

    // Every service and package, including retired ones (admin pages).
    adminCatalog() {
      const services = db.prepare('SELECT * FROM services ORDER BY active DESC, kind, name').all();
      const packages = (db.prepare("SELECT * FROM packages WHERE id <> 'custom' ORDER BY active DESC, price_php").all() as unknown as PackageRow[]).map((p) => ({
        ...p, items: itemsOf(p.id).map((i) => ({ service_id: i.service_id, name: i.service_name, kind: i.kind, qty: i.qty, per_guest: Boolean(i.per_guest) })),
      }));
      return { services, packages };
    },

    // Creates or edits a service. A new one gets inventory for the coming
    // days. Lowering capacity is refused on days that already sold more.
    saveService(input: ServiceInput, user: string) {
      const name = String(input.name ?? '').trim();
      const capacity = Math.floor(Number(input.capacity));
      const price = Math.round(Number(input.pricePhp));
      if (name.length < 2) throw new BookingError(400, 'Service name is required', 'INVALID_ARGUMENT');
      if (!(capacity >= 0 && capacity <= 10000)) throw new BookingError(400, 'Capacity must be 0-10000', 'INVALID_ARGUMENT');
      if (!(price >= 0)) throw new BookingError(400, 'Price must be 0 or more', 'INVALID_ARGUMENT');
      if (!['room', 'tour', 'boat', 'transfer', 'meal'].includes(input.kind)) throw new BookingError(400, 'Kind must be room, tour, boat, transfer or meal', 'INVALID_ARGUMENT');
      if (!['person', 'room', 'trip'].includes(input.unit)) throw new BookingError(400, 'Unit must be person, room or trip', 'INVALID_ARGUMENT');
      const active = input.active === false ? 0 : 1;

      let id = input.id;
      transaction(db, () => {
        if (id) {
          if (!getService(id)) throw new BookingError(404, 'Unknown service', 'NOT_FOUND');
          const tooMany = db.prepare('SELECT day, booked + blocked AS used FROM inventory WHERE service_id = ? AND day >= ? AND booked + blocked > ? ORDER BY day LIMIT 3')
            .all(id, today(), capacity) as { day: string; used: number }[];
          if (tooMany.length) throw new BookingError(409, `Capacity ${capacity} is below what is already booked on ${tooMany.map((t) => `${t.day} (${t.used})`).join(', ')}`);
          db.prepare('UPDATE services SET name = ?, kind = ?, capacity = ?, price_php = ?, unit = ?, active = ? WHERE id = ?')
            .run(name, input.kind, capacity, price, input.unit, active, id);
          db.prepare('UPDATE inventory SET capacity = ? WHERE service_id = ? AND day >= ?').run(capacity, id, today());
        } else {
          id = `${island.id}-${slug(name)}`;
          if (getService(id)) id = `${id}-${randomInt(100, 999)}`;
          db.prepare('INSERT INTO services (id, kind, name, capacity, price_php, unit, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, input.kind, name, capacity, price, input.unit, active);
        }
        addOutbox(db, 'CATALOG_CHANGED', null, { what: 'service', id, name, by: user });
      });
      extendInventory(db, inventoryDays, id);
      return getService(id!);
    },

    // Creates or edits a package and its services. Existing bookings keep
    // the units and price they were sold with.
    savePackage(input: PackageInput, user: string) {
      const name = String(input.name ?? '').trim();
      const price = Math.round(Number(input.pricePhp));
      const nights = Math.floor(Number(input.nights));
      const maxGuests = Math.floor(Number(input.maxGuests));
      const extra = Math.round(Number(input.extraHourPhp ?? 50));
      if (name.length < 2) throw new BookingError(400, 'Package name is required', 'INVALID_ARGUMENT');
      if (!(price >= 0)) throw new BookingError(400, 'Price must be 0 or more', 'INVALID_ARGUMENT');
      if (!['per_guest', 'per_package'].includes(input.pricing)) throw new BookingError(400, 'Pricing must be per_guest or per_package', 'INVALID_ARGUMENT');
      if (!(nights >= 0 && nights <= MAX_DAYS)) throw new BookingError(400, `Nights must be 0-${MAX_DAYS}`, 'INVALID_ARGUMENT');
      if (!(maxGuests >= 1 && maxGuests <= 100)) throw new BookingError(400, 'Max guests must be 1-100', 'INVALID_ARGUMENT');
      if (!(extra >= 0)) throw new BookingError(400, 'Fee per extra hour must be 0 or more', 'INVALID_ARGUMENT');
      const items = (input.items ?? []).filter((i) => i.serviceId);
      if (!items.length) throw new BookingError(400, 'A package needs at least one service', 'INVALID_ARGUMENT');
      for (const it of items) {
        if (!getService(it.serviceId)) throw new BookingError(404, `Unknown service ${it.serviceId}`, 'NOT_FOUND');
        if (!(Math.floor(Number(it.qty)) >= 1)) throw new BookingError(400, 'Each service needs a quantity of at least 1', 'INVALID_ARGUMENT');
      }
      const active = input.active === false ? 0 : 1;

      let id = input.id;
      transaction(db, () => {
        if (id) {
          if (!getPackage(id)) throw new BookingError(404, 'Unknown package', 'NOT_FOUND');
          db.prepare(`UPDATE packages SET name = ?, location = ?, description = ?, price_php = ?, pricing = ?, nights = ?, max_guests = ?,
                        extra_hour_php = ?, fun_fact = ?, active = ? WHERE id = ?`)
            .run(name, String(input.location ?? '').trim(), String(input.description ?? '').trim(), price, input.pricing, nights, maxGuests, extra,
              String(input.funFact ?? '').trim().slice(0, 400), active, id);
          db.prepare('DELETE FROM package_items WHERE package_id = ?').run(id);
        } else {
          id = `${island.id}-${slug(name)}`;
          if (getPackage(id)) id = `${id}-${randomInt(100, 999)}`;
          db.prepare(`INSERT INTO packages (id, name, location, description, price_php, pricing, nights, max_guests, extra_hour_php, fun_fact, active)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, name, String(input.location ?? '').trim() || island.name, String(input.description ?? '').trim(), price, input.pricing, nights, maxGuests, extra,
              String(input.funFact ?? '').trim().slice(0, 400), active);
        }
        const addItem = db.prepare('INSERT INTO package_items VALUES (?, ?, ?, ?)');
        for (const it of items) addItem.run(id!, it.serviceId, Math.floor(Number(it.qty)), it.perGuest ? 1 : 0);
        addOutbox(db, 'CATALOG_CHANGED', null, { what: 'package', id, name, by: user });
      });
      return this.adminCatalog().packages.find((p) => p.id === id);
    },

    // ---- Staff accounts --------------------------------------------------------
    hasStaff: () => (db.prepare('SELECT COUNT(*) AS n FROM staff').get() as { n: number }).n > 0,
    listStaff: () => db.prepare('SELECT username, role, active, created_at FROM staff ORDER BY role, username').all(),
    addStaff(username: string, password: string, role: 'node_admin' | 'receptionist') {
      if (!/^[a-z0-9._-]{3,32}$/i.test(username ?? '')) throw new BookingError(400, 'Username: 3-32 letters, digits, . _ -', 'INVALID_ARGUMENT');
      if (String(password ?? '').length < 8) throw new BookingError(400, 'Password must be at least 8 characters', 'INVALID_ARGUMENT');
      if (!['node_admin', 'receptionist'].includes(role)) throw new BookingError(400, 'Role must be node_admin or receptionist', 'INVALID_ARGUMENT');
      const salt = randomBytes(16).toString('hex');
      const hash = `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
      try {
        db.prepare('INSERT INTO staff VALUES (?, ?, ?, 1, ?)').run(username.toLowerCase(), role, hash, Date.now());
      } catch {
        throw new BookingError(409, 'That username already exists', 'ALREADY_EXISTS');
      }
      addOutbox(db, 'STAFF_ADDED', null, { username: username.toLowerCase(), role, island: island.id });
      return { username: username.toLowerCase(), role };
    },
    // Enable/disable an account. Receptionists from the island console; node
    // admins only from central (`anyRole`).
    setStaffActive: (username: string, active: boolean, anyRole = false) =>
      db.prepare(`UPDATE staff SET active = ? WHERE username = ?${anyRole ? '' : " AND role = 'receptionist'"}`)
        .run(active ? 1 : 0, String(username).toLowerCase()).changes === 1,
    // Checks a login; returns the role or null.
    verifyLogin(username: string, password: string): string | null {
      const row = db.prepare('SELECT role, password_hash, active FROM staff WHERE username = ?').get(String(username).toLowerCase()) as
        { role: string; password_hash: string; active: number } | undefined;
      if (!row || !row.active) return null;
      const [salt, hex] = row.password_hash.split(':');
      const given = scryptSync(String(password), salt, 32);
      return timingSafeEqual(given, Buffer.from(hex, 'hex')) ? row.role : null;
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
