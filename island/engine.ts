/**
 * island/engine.ts
 *
 * Booking logic of an island node, independent of HTTP / RPC:
 *  - availability   : which packages fit a date and guest count
 *  - reserve        : online hold or walk-in booking, atomic over all services
 *  - confirm / release / cancel / checkIn / expireHolds : status changes
 *  - block / unblock: receptionist marks units unavailable
 *  - staff          : login accounts (scrypt password hashes)
 *
 * Every change writes a BOOKING_UPDATED event to the outbox in the same
 * transaction, so central's copy follows without ever editing island data.
 */
import { randomInt, randomUUID, scryptSync, timingSafeEqual, randomBytes } from 'node:crypto';
import { addDays } from '../shared/config.ts';
import { addOutbox, transaction, type Db } from './db.ts';

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
}
interface ItemRow { package_id: string; service_id: string; qty: number; per_guest: number; kind: string; service_name: string }
export interface BookingRow {
  id: string; reference: string; request_id: string | null; source: 'ONLINE' | 'WALKIN';
  package_id: string; day: string; nights: number; guests: number;
  guest_name: string; email: string; phone: string; id_type: string; id_last4: string;
  total_php: number; status: string; hold_expires_at: number | null; created_by: string;
  created_at: number; updated_at: number; checked_in_at: number | null;
}

export interface ReserveRequest {
  requestId: string;
  packageId: string;
  day: string;
  guests: number;
  guestName: string;
  email?: string;
  phone?: string;
  idType: string;
  idLast4: string;
}

// ---------------------------------------------------------------------------
// Engine (one per island)
// ---------------------------------------------------------------------------

export function createEngine(db: Db, island: { id: string; name: string; prefix: string }, holdMinutes: number) {
  const getPackage = (id: string) => db.prepare('SELECT * FROM packages WHERE id = ?').get(id) as PackageRow | undefined;
  const itemsOf = (packageId: string) => db.prepare(
    `SELECT pi.*, s.kind, s.name AS service_name FROM package_items pi JOIN services s ON s.id = pi.service_id WHERE pi.package_id = ?`,
  ).all(packageId) as unknown as ItemRow[];
  const getBooking = (ref: string) => db.prepare('SELECT * FROM bookings WHERE reference = ?').get(String(ref).toUpperCase()) as BookingRow | undefined;

  // Units a package takes: rooms for every night, other services on day 1.
  function linesFor(pkg: PackageRow, day: string, guests: number) {
    const lines: { serviceId: string; day: string; qty: number }[] = [];
    for (const it of itemsOf(pkg.id)) {
      const qty = it.qty * (it.per_guest ? guests : 1);
      const days = it.kind === 'room' ? Math.max(1, pkg.nights) : 1;
      for (let d = 0; d < days; d++) lines.push({ serviceId: it.service_id, day: addDays(day, d), qty });
    }
    return lines;
  }

  // Price of a booking.
  const priceOf = (pkg: PackageRow, guests: number) => (pkg.pricing === 'per_guest' ? pkg.price_php * guests : pkg.price_php);

  // The snapshot sent to central and returned to callers.
  function snapshot(b: BookingRow) {
    const pkg = getPackage(b.package_id);
    return {
      reference: b.reference, island_id: island.id, island_name: island.name, source: b.source,
      package_id: b.package_id, package_name: pkg?.name ?? b.package_id, location: pkg?.location ?? '',
      day: b.day, nights: b.nights, guests: b.guests, guest_name: b.guest_name, email: b.email, phone: b.phone,
      id_type: b.id_type, id_last4: b.id_last4, total_php: b.total_php, status: b.status,
      hold_expires_at: b.hold_expires_at, created_at: b.created_at, updated_at: b.updated_at, checked_in_at: b.checked_in_at,
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

  // Moves a booking from one of `from` statuses to `to`, atomically: the
  // UPDATE only matches the expected status, so two desks (or a desk and the
  // expiry job) can never both apply it.
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

  return {
    snapshot,

    // Catalog: active packages with their services.
    catalog() {
      const pkgs = db.prepare('SELECT * FROM packages WHERE active = 1 ORDER BY price_php').all() as unknown as PackageRow[];
      return pkgs.map((p) => ({
        ...p, island_id: island.id, island_name: island.name,
        items: itemsOf(p.id).map((i) => ({ service_id: i.service_id, name: i.service_name, kind: i.kind, qty: i.qty, per_guest: Boolean(i.per_guest) })),
      }));
    },

    // Packages bookable for a date and guest count. `spots` = how many such
    // bookings still fit (the tightest service decides).
    availability(day: string, guests: number) {
      const free = db.prepare('SELECT capacity - booked - blocked AS free FROM inventory WHERE service_id = ? AND day = ?');
      return this.catalog().map((p) => {
        let spots = Infinity;
        for (const l of linesFor(p, day, guests)) {
          const row = free.get(l.serviceId, l.day) as { free: number } | undefined;
          spots = Math.min(spots, row ? Math.floor(row.free / l.qty) : 0);
        }
        const fits = guests <= p.max_guests;
        return { ...p, day, guests, spots: fits ? spots : 0, available: fits && spots > 0, total_php: priceOf(p, guests) };
      });
    },

    // Reserve a package: HELD (online, expires) or CONFIRMED (walk-in, paid at
    // the desk). All units are taken in ONE transaction, each with the guard
    // "booked + blocked + qty <= capacity"; if any fails, everything rolls back.
    // Online and walk-in use this same code on the same rows, so the race for
    // the last room is decided here and can never oversell.
    reserve(req: ReserveRequest, source: 'ONLINE' | 'WALKIN', createdBy: string) {
      if (!/^\d{4}$/.test(req.idLast4 ?? '')) throw new BookingError(400, 'idLast4 must be 4 digits', 'INVALID_ARGUMENT');
      const guests = Number(req.guests);
      if (!(guests >= 1)) throw new BookingError(400, 'guests must be at least 1', 'INVALID_ARGUMENT');
      if (!req.guestName?.trim()) throw new BookingError(400, 'guest name is required', 'INVALID_ARGUMENT');

      // Idempotency: the same request id returns the same booking.
      const existing = db.prepare('SELECT * FROM bookings WHERE request_id = ?').get(req.requestId) as BookingRow | undefined;
      if (existing) return snapshot(existing);

      const pkg = getPackage(req.packageId);
      if (!pkg || !pkg.active) throw new BookingError(404, 'Unknown package for this island', 'NOT_FOUND');
      if (guests > pkg.max_guests) throw new BookingError(400, `This package is for up to ${pkg.max_guests} guests`, 'INVALID_ARGUMENT');

      const take = db.prepare('UPDATE inventory SET booked = booked + ? WHERE service_id = ? AND day = ? AND booked + blocked + ? <= capacity');
      return transaction(db, () => {
        const lines = linesFor(pkg, req.day, guests);
        for (const l of lines) {
          if (take.run(l.qty, l.serviceId, l.day, l.qty).changes === 0) {
            throw new BookingError(409, 'Sold out for that date', 'RESOURCE_EXHAUSTED');
          }
        }
        const now = Date.now();
        const id = randomUUID();
        db.prepare(
          `INSERT INTO bookings (id, reference, request_id, source, package_id, day, nights, guests, guest_name, email, phone,
             id_type, id_last4, total_php, status, hold_expires_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, newReference(), req.requestId, source, pkg.id, req.day, pkg.nights, guests, req.guestName.trim(),
          req.email ?? '', req.phone ?? '', req.idType, req.idLast4, priceOf(pkg, guests),
          source === 'ONLINE' ? 'HELD' : 'CONFIRMED', source === 'ONLINE' ? now + holdMinutes * 60_000 : null,
          createdBy, now, now);
        const addLine = db.prepare('INSERT INTO booking_lines VALUES (?, ?, ?, ?)');
        for (const l of lines) addLine.run(id, l.serviceId, l.day, l.qty);
        const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as unknown as BookingRow;
        emit(b);
        return snapshot(b);
      });
    },

    // Payment succeeded: HELD -> CONFIRMED, only if the hold has not expired.
    confirm(ref: string) {
      const b = getBooking(ref);
      if (b?.status === 'HELD' && b.hold_expires_at! < Date.now()) {
        this.expireHolds();
        throw new BookingError(409, 'The hold expired before payment', 'FAILED_PRECONDITION');
      }
      return transition(ref, ['HELD'], 'CONFIRMED');
    },
    // Payment failed or abandoned: HELD -> RELEASED, units returned.
    release: (ref: string) => transition(ref, ['HELD'], 'RELEASED', (b) => giveBack(b.id)),
    // Cancellation: HELD/CONFIRMED -> CANCELLED, units returned.
    cancel: (ref: string) => transition(ref, ['HELD', 'CONFIRMED'], 'CANCELLED', (b) => giveBack(b.id)),
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

    // Console overview for one date: the four KPI cards plus a 7-day trend
    // (the 6 days before `day`, then `day`) for the small bar charts.
    overview(day: string) {
      // Counts for one date: expected arrivals, checked in, walk-ins, online,
      // cancelled, and units marked unavailable out of total capacity.
      const countsFor = (d: string) => {
        const b = db.prepare(
          `SELECT
             SUM(status IN ('CONFIRMED', 'CHECKED_IN'))                         AS arrivals,
             SUM(status = 'CHECKED_IN')                                         AS checkedIn,
             SUM(source = 'WALKIN' AND status IN ('CONFIRMED', 'CHECKED_IN'))  AS walkins,
             SUM(source = 'ONLINE' AND status IN ('CONFIRMED', 'CHECKED_IN'))  AS online,
             SUM(status = 'CANCELLED')                                          AS cancelled
           FROM bookings WHERE day = ?`,
        ).get(d) as Record<string, number | null>;
        const inv = db.prepare('SELECT SUM(blocked) AS blocked, SUM(capacity) AS capacity FROM inventory WHERE day = ?').get(d) as Record<string, number | null>;
        return {
          day: d, arrivals: b.arrivals ?? 0, checkedIn: b.checkedIn ?? 0, walkins: b.walkins ?? 0, online: b.online ?? 0,
          cancelled: b.cancelled ?? 0, blocked: inv.blocked ?? 0, capacity: inv.capacity ?? 0,
        };
      };
      const trend = Array.from({ length: 7 }, (_, i) => countsFor(addDays(day, i - 6)));
      return { ...trend[6], trend };
    },

    // Inventory of all services for one day (console "Availability" tab).
    inventory(day: string) {
      return db.prepare(
        `SELECT s.id, s.name, s.kind, i.capacity, i.booked, i.blocked, i.capacity - i.booked - i.blocked AS free
           FROM services s LEFT JOIN inventory i ON i.service_id = s.id AND i.day = ? ORDER BY s.kind, s.name`,
      ).all(day);
    },

    // Mark units unavailable for `days` days from `day` (repairs, weather,
    // boat not running). Guarded like a booking: only free units can be blocked.
    // If a day lacks free units, nothing changes and the affected bookings are listed.
    block(serviceId: string, day: string, days: number, units: number) {
      return transaction(db, () => {
        for (let d = 0; d < days; d++) {
          const dd = addDays(day, d);
          const row = db.prepare('SELECT capacity, booked, blocked FROM inventory WHERE service_id = ? AND day = ?').get(serviceId, dd) as
            { capacity: number; booked: number; blocked: number } | undefined;
          if (!row) throw new BookingError(404, `No inventory for ${dd}`, 'NOT_FOUND');
          const n = units > 0 ? units : row.capacity - row.booked - row.blocked; // 0 = block all free units
          const { changes } = db.prepare('UPDATE inventory SET blocked = blocked + ? WHERE service_id = ? AND day = ? AND booked + blocked + ? <= capacity')
            .run(n, serviceId, dd, n);
          if (changes === 0) {
            const affected = db.prepare(
              `SELECT b.reference, b.guest_name FROM bookings b JOIN booking_lines l ON l.booking_id = b.id
                WHERE l.service_id = ? AND l.day = ? AND b.status IN ('HELD', 'CONFIRMED')`,
            ).all(serviceId, dd) as { reference: string; guest_name: string }[];
            throw new BookingError(409, `Only ${row.capacity - row.booked - row.blocked} unit(s) free on ${dd}; booked by: ${affected.map((a) => `${a.reference} (${a.guest_name})`).join(', ') || 'none'}`);
          }
        }
        addOutbox(db, 'SERVICE_BLOCKED', null, { service_id: serviceId, day, days, units });
        return { ok: true };
      });
    },
    unblock(serviceId: string, day: string, units: number) {
      const { changes } = db.prepare('UPDATE inventory SET blocked = MAX(0, blocked - ?) WHERE service_id = ? AND day = ?')
        .run(units > 0 ? units : 1e9, serviceId, day);
      if (!changes) throw new BookingError(404, 'No inventory for that day', 'NOT_FOUND');
      return { ok: true };
    },

    // --- Staff accounts -----------------------------------------------------
    hasStaff: () => (db.prepare('SELECT COUNT(*) AS n FROM staff').get() as { n: number }).n > 0,
    listStaff: () => db.prepare('SELECT username, role, active, created_at FROM staff ORDER BY role, username').all(),
    addStaff(username: string, password: string, role: 'node_admin' | 'receptionist') {
      if (!/^[a-z0-9._-]{3,32}$/i.test(username)) throw new BookingError(400, 'Username: 3-32 letters, digits, . _ -', 'INVALID_ARGUMENT');
      if (String(password).length < 8) throw new BookingError(400, 'Password must be at least 8 characters', 'INVALID_ARGUMENT');
      const salt = randomBytes(16).toString('hex');
      const hash = `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
      try {
        db.prepare('INSERT INTO staff VALUES (?, ?, ?, 1, ?)').run(username.toLowerCase(), role, hash, Date.now());
      } catch {
        throw new BookingError(409, 'That username already exists', 'ALREADY_EXISTS');
      }
      addOutbox(db, 'STAFF_ADDED', null, { username: username.toLowerCase(), role, island: island.id });
    },
    setStaffActive: (username: string, active: boolean) =>
      db.prepare("UPDATE staff SET active = ? WHERE username = ? AND role = 'receptionist'").run(active ? 1 : 0, username.toLowerCase()).changes === 1,
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
