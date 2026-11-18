/**
 * island/db.ts
 *
 * The island's local database (built-in node:sqlite, one file per island in
 * data/). Everything here is OWNED by this island; central only keeps copies.
 *  - services       : rooms, tours, boats with a daily capacity and a price
 *  - packages       : what customers buy, made of services (package_items)
 *  - inventory      : per service per day: capacity, booked, blocked
 *  - service_off    : on/off switch per service per day (desk checklist)
 *  - bookings       : online and walk-in, packages or build-your-own trips,
 *                     with a short reference (MRP-7F3K2), duration and refund
 *  - booking_lines  : exactly which units each booking took (to give them back)
 *  - staff          : node admin and receptionist logins (password hashes)
 *  - outbox         : events waiting to be sent to central
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, addDays, today, type Seed, type SeedIsland } from '../shared/config.ts';

export type Db = DatabaseSync;

// Opens (or creates) data/island-<id>-v2.db and makes sure all tables exist.
// The "-v2" file keeps the earlier prototype's database out of the way.
export function openDb(islandId: string): Db {
  const dir = join(ROOT, 'data');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `island-${islandId}-v2.db`));
  db.exec(`
    -- WAL lets the console read while a booking is written; busy_timeout makes
    -- a second writer wait instead of failing.
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    -- price_php: one unit for one day; unit: person | room | trip.
    -- active = 0 hides a service the admin retired (old bookings keep it).
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity >= 0),
      price_php INTEGER NOT NULL DEFAULT 0, unit TEXT NOT NULL DEFAULT 'person', active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL,
      price_php INTEGER NOT NULL, pricing TEXT NOT NULL CHECK (pricing IN ('per_guest', 'per_package')),
      nights INTEGER NOT NULL, max_guests INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      extra_day_php INTEGER NOT NULL DEFAULT 0,
      extra_hour_php INTEGER NOT NULL DEFAULT 50,
      fun_fact TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS package_items (
      package_id TEXT NOT NULL REFERENCES packages (id), service_id TEXT NOT NULL REFERENCES services (id),
      qty INTEGER NOT NULL, per_guest INTEGER NOT NULL,
      PRIMARY KEY (package_id, service_id)
    );

    -- One inventory per service per day, shared by online and walk-in sales.
    -- The CHECK makes overselling impossible even if code is wrong.
    CREATE TABLE IF NOT EXISTS inventory (
      service_id TEXT NOT NULL REFERENCES services (id), day TEXT NOT NULL,
      capacity INTEGER NOT NULL, booked INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
      CHECK (booked >= 0 AND blocked >= 0 AND booked + blocked <= capacity),
      PRIMARY KEY (service_id, day)
    );

    -- On/off checklist: a row means the service is NOT available that day
    -- (boat down, tour closed). Existing bookings stay; new sales skip it.
    CREATE TABLE IF NOT EXISTS service_off (
      service_id TEXT NOT NULL REFERENCES services (id), day TEXT NOT NULL,
      by_user TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
      PRIMARY KEY (service_id, day)
    );

    -- Statuses: HELD (online, waiting for payment) -> CONFIRMED -> CHECKED_IN;
    -- or RELEASED / EXPIRED (hold undone), CANCELLED (units returned, refund).
    -- package_id is 'custom' for build-your-own trips (package_name says what).
    -- days = how many days the services are used; extra_hours = time bought
    -- after the package time (₱ per hour); extra_days = the days that adds.
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      request_id TEXT UNIQUE,
      source TEXT NOT NULL CHECK (source IN ('ONLINE', 'WALKIN')),
      package_id TEXT NOT NULL REFERENCES packages (id),
      day TEXT NOT NULL, nights INTEGER NOT NULL, guests INTEGER NOT NULL,
      guest_name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      id_type TEXT NOT NULL, id_last4 TEXT NOT NULL,
      total_php INTEGER NOT NULL,
      status TEXT NOT NULL,
      package_name TEXT NOT NULL DEFAULT '', end_day TEXT NOT NULL DEFAULT '',
      days INTEGER NOT NULL DEFAULT 1, extra_days INTEGER NOT NULL DEFAULT 0, extra_hours INTEGER NOT NULL DEFAULT 0,
      refund_php INTEGER NOT NULL DEFAULT 0,
      hold_expires_at INTEGER,
      created_by TEXT NOT NULL DEFAULT 'online',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, checked_in_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS bookings_day_idx ON bookings (day);

    CREATE TABLE IF NOT EXISTS booking_lines (
      booking_id TEXT NOT NULL REFERENCES bookings (id), service_id TEXT NOT NULL, day TEXT NOT NULL,
      qty INTEGER NOT NULL, PRIMARY KEY (booking_id, service_id, day)
    );

    CREATE TABLE IF NOT EXISTS staff (
      username TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('node_admin', 'receptionist')),
      password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );

    -- Written in the same transaction as the change it describes; drained to central.
    -- One-time catalog changes already applied to this database (see oneTime()).
    CREATE TABLE IF NOT EXISTS applied_changes (
      name TEXT PRIMARY KEY, at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, booking_id TEXT,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER
    );
  `);
  upgrade(db);
  return db;
}

// Adds columns that newer versions introduced to a database created by an
// older version (teammates' laptops keep their data across updates).
function upgrade(db: Db): void {
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  const add: [string, string, string][] = [
    ['services', 'price_php', 'INTEGER NOT NULL DEFAULT 0'],
    ['services', 'unit', "TEXT NOT NULL DEFAULT 'person'"],
    ['services', 'active', 'INTEGER NOT NULL DEFAULT 1'],
    ['packages', 'extra_day_php', 'INTEGER NOT NULL DEFAULT 0'],
    ['packages', 'extra_hour_php', 'INTEGER NOT NULL DEFAULT 50'],
    ['packages', 'fun_fact', "TEXT NOT NULL DEFAULT ''"],
    ['bookings', 'extra_hours', 'INTEGER NOT NULL DEFAULT 0'],
    ['bookings', 'package_name', "TEXT NOT NULL DEFAULT ''"],
    ['bookings', 'end_day', "TEXT NOT NULL DEFAULT ''"],
    ['bookings', 'days', 'INTEGER NOT NULL DEFAULT 1'],
    ['bookings', 'extra_days', 'INTEGER NOT NULL DEFAULT 0'],
    ['bookings', 'refund_php', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, column, type] of add) {
    if (!columns(table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Build-your-own trips are stored with package_id 'custom'; this hidden
  // (inactive) row satisfies the bookings -> packages foreign key.
  db.prepare(`INSERT OR IGNORE INTO packages (id, name, location, description, price_php, pricing, nights, max_guests, active)
              VALUES ('custom', 'Build-your-own trip', '', '', 0, 'per_package', 0, 100, 0)`).run();
}

// Fills services, packages and inventory from config/seed.json. INSERT OR
// IGNORE never overwrites existing rows (or units already sold, or changes the
// node admin made), so this runs safely on every start. Prices that are still
// 0 (databases from before prices existed) are filled in from the seed.
// Finally every service, including ones the admin added, gets inventory rows
// for the next inventoryDays days.
export function seedIsland(db: Db, seed: Seed, island: SeedIsland): void {
  const addService = db.prepare('INSERT OR IGNORE INTO services (id, kind, name, capacity, price_php, unit) VALUES (?, ?, ?, ?, ?, ?)');
  const fillPrice = db.prepare('UPDATE services SET price_php = ?, unit = ? WHERE id = ? AND price_php = 0');
  const addPackage = db.prepare('INSERT OR IGNORE INTO packages (id, name, location, description, price_php, pricing, nights, max_guests, extra_hour_php, fun_fact) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addItem = db.prepare('INSERT OR IGNORE INTO package_items VALUES (?, ?, ?, ?)');
  transaction(db, () => {
    for (const s of island.services) {
      addService.run(s.id, s.kind, s.name, s.capacity, s.pricePhp, s.unit);
      fillPrice.run(s.pricePhp, s.unit, s.id);
    }
    for (const p of island.packages) {
      addPackage.run(p.id, p.name, p.location, p.description, p.pricePhp, p.pricing, p.nights, p.maxGuests, p.extraHourPhp ?? 50, p.funFact ?? '');
      for (const it of p.items) addItem.run(p.id, it.service, it.qty, it.perGuest ? 1 : 0);
    }
  });
  renameOld(db);
  oneTime(db, 'resort-texts-2026-11', () => {
    // Fuller descriptions, locations and a "Did you know?" for the three
    // resorts (from seed.json); later edits by the island admin are kept.
    const set = db.prepare('UPDATE packages SET location = ?, description = ?, fun_fact = ? WHERE id = ?');
    for (const p of island.packages) if (p.funFact) set.run(p.location, p.description, p.funFact, p.id);
  });
  oneTime(db, 'retire-day-trips-2026-11', () => {
    // Only the three resort stays are sold now; the day trips are taken off
    // sale (kept in the database so their past bookings keep their names).
    db.prepare("UPDATE packages SET active = 0 WHERE id IN ('biliran-falls-day', 'maripipi-sambawan-day', 'higatangan-sandbar-day')").run();
  });
  oneTime(db, 'test-prices-zero-2026-11', () => {
    // Booking test: every package, service and extra-hour fee starts at ₱0.
    // Runs once, so prices the island admin sets afterwards are kept.
    db.prepare('UPDATE packages SET price_php = 0, extra_hour_php = 0').run();
    db.prepare('UPDATE services SET price_php = 0').run();
  });
  extendInventory(db, seed.inventoryDays);
}

// Catalog names that changed in seed.json after islands already had a
// database. Each rename only applies while the old name is still there, so a
// name the island admin edited is never overwritten.
const RENAMES: { table: 'services' | 'packages'; id: string; from: Record<string, string>; to: Record<string, string> }[] = [
  { table: 'services', id: 'biliran-lagundi-room', from: { name: 'Lagundi Bay Resort room' }, to: { name: 'Chamorita Beach Resort room' } },
  {
    table: 'packages', id: 'biliran-lagundi-2d1n',
    from: { name: 'Lagundi Bay 2D1N + Falls' },
    to: {
      name: 'Chamorita Beach Resort 2D1N + Falls', location: 'Chamorita Beach Resort, Biliran',
      description: 'One night at Chamorita Beach Resort: swimming pools, beachfront cottages and sunset over the water, plus the falls trek and van transfer.',
    },
  },
];
// Runs a catalog change once per database (recorded in applied_changes), so
// an island admin who later turns something back on is not overruled.
function oneTime(db: Db, name: string, change: () => void): void {
  if (db.prepare('SELECT 1 FROM applied_changes WHERE name = ?').get(name)) return;
  transaction(db, () => {
    change();
    db.prepare('INSERT INTO applied_changes VALUES (?, ?)').run(name, Date.now());
  });
}

function renameOld(db: Db): void {
  for (const r of RENAMES) {
    const sets = Object.keys(r.to).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE ${r.table} SET ${sets} WHERE id = ? AND name = ?`).run(...Object.values(r.to), r.id, r.from.name);
  }
}

// Makes sure every service (or just `serviceId`) has an inventory row for
// today and the following days; new days start at the service's capacity.
export function extendInventory(db: Db, days: number, serviceId?: string): void {
  const addDay = db.prepare('INSERT OR IGNORE INTO inventory (service_id, day, capacity) VALUES (?, ?, ?)');
  const services = (serviceId
    ? db.prepare('SELECT id, capacity FROM services WHERE id = ?').all(serviceId)
    : db.prepare('SELECT id, capacity FROM services').all()) as { id: string; capacity: number }[];
  const start = today();
  transaction(db, () => {
    for (const s of services) for (let i = 0; i < days; i++) addDay.run(s.id, addDays(start, i), s.capacity);
  });
}

// Runs fn inside BEGIN IMMEDIATE and commits, or rolls back if it throws.
// IMMEDIATE takes the write lock up front, so concurrent writers queue up
// instead of interleaving their reads and writes.
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Adds an event to the outbox. Must run inside the same transaction as the
// change it describes (outbox pattern).
export function addOutbox(db: Db, type: string, bookingId: string | null, payload: unknown): void {
  db.prepare('INSERT INTO outbox (event_id, type, booking_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), type, bookingId, JSON.stringify(payload), Date.now());
}
