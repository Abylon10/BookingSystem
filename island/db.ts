/**
 * island/db.ts
 *
 * The island's local database (built-in node:sqlite, one file per island in
 * data/). Everything here is OWNED by this island; central only keeps copies.
 *  - services       : rooms, tours, boats with a daily capacity
 *  - packages       : what customers buy, made of services (package_items)
 *  - inventory      : per service per day: capacity, booked, blocked
 *  - bookings       : online and walk-in, with a short reference (MRP-7F3K2)
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

    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity >= 0)
    );

    CREATE TABLE IF NOT EXISTS packages (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL,
      price_php INTEGER NOT NULL, pricing TEXT NOT NULL CHECK (pricing IN ('per_guest', 'per_package')),
      nights INTEGER NOT NULL, max_guests INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
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

    -- Statuses: HELD (online, waiting for payment) -> CONFIRMED -> CHECKED_IN;
    -- or RELEASED / EXPIRED (hold undone), CANCELLED (units returned).
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
    CREATE TABLE IF NOT EXISTS outbox (
      event_id TEXT PRIMARY KEY, type TEXT NOT NULL, booking_id TEXT,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER
    );
  `);
  return db;
}

// Fills services, packages and inventory from config/seed.json. INSERT OR
// IGNORE never overwrites existing rows (or units already sold), so this runs
// safely on every start and only adds missing days.
export function seedIsland(db: Db, seed: Seed, island: SeedIsland): void {
  const addService = db.prepare('INSERT OR IGNORE INTO services VALUES (?, ?, ?, ?)');
  const addPackage = db.prepare('INSERT OR IGNORE INTO packages (id, name, location, description, price_php, pricing, nights, max_guests) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const addItem = db.prepare('INSERT OR IGNORE INTO package_items VALUES (?, ?, ?, ?)');
  const addDay = db.prepare('INSERT OR IGNORE INTO inventory (service_id, day, capacity) VALUES (?, ?, ?)');
  const start = today();
  transaction(db, () => {
    for (const s of island.services) {
      addService.run(s.id, s.kind, s.name, s.capacity);
      for (let i = 0; i < seed.inventoryDays; i++) addDay.run(s.id, addDays(start, i), s.capacity);
    }
    for (const p of island.packages) {
      addPackage.run(p.id, p.name, p.location, p.description, p.pricePhp, p.pricing, p.nights, p.maxGuests);
      for (const it of p.items) addItem.run(p.id, it.service, it.qty, it.perGuest ? 1 : 0);
    }
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
