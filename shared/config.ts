/**
 * shared/config.ts
 *
 * Configuration helpers used by every process (central, islands, load tests):
 *  - where each machine lives on the network (config/network.<name>.json)
 *  - the catalog and capacities (config/seed.json)
 *  - how capacity is split between the online and walk-in pools
 *  - small date helpers (all dates are plain "YYYY-MM-DD" strings in UTC)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Absolute path of the repository root. Computed from this file's location
// (shared/ is one level below the root) so scripts work no matter which folder
// they are started from.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Types describing config/network.*.json
// ---------------------------------------------------------------------------

// One machine on the network: its IP/hostname, the HTTP port (browser/app
// traffic) and the gRPC port (server-to-server traffic).
export interface Endpoint {
  host: string;
  httpPort: number;
  grpcPort: number;
}

// An island node is an endpoint plus the island id it serves ("biliran", ...).
export interface IslandEndpoint extends Endpoint {
  id: string;
}

// The whole network: one central server and N island nodes.
export interface NetworkConfig {
  central: Endpoint;
  islands: IslandEndpoint[];
}

// ---------------------------------------------------------------------------
// Types describing config/seed.json
// ---------------------------------------------------------------------------

// A resort or tour as written in seed.json. `capacity` is rooms per night for a
// resort and seats per day for a tour; it is split into the two pools below.
export interface SeedListing {
  id: string;
  kind: 'resort' | 'tour';
  name: string;
  location: string;
  description: string;
  pricePhp: number;
  capacity: number;
  facilities: string[];
  image: string;
}

// An island and the listings it owns.
export interface SeedIsland {
  id: string;
  name: string;
  listings: SeedListing[];
}

// Root of seed.json: how many days of inventory to create, what fraction of
// each listing's capacity is sold online, and the islands.
export interface Seed {
  inventoryDays: number;
  onlineShare: number;
  islands: SeedIsland[];
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

// Reads and parses a JSON file. Kept private: callers use the typed loaders.
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// Loads the network layout. NETWORK=hotspot picks config/network.hotspot.json
// (real laptop IPs on demo day); the default "local" runs everything on
// 127.0.0.1 with different ports so one laptop can host the whole system.
export function loadNetwork(): NetworkConfig {
  const name = process.env.NETWORK ?? 'local';
  return readJson<NetworkConfig>(join(ROOT, 'config', `network.${name}.json`));
}

// Loads the catalog (islands, listings, capacities). Central and every island
// read the same file, so both sides agree on ids, prices and pool sizes.
export function loadSeed(): Seed {
  return readJson<Seed>(join(ROOT, 'config', 'seed.json'));
}

// ---------------------------------------------------------------------------
// Inventory split (the core idea that removes online-vs-walk-in races)
// ---------------------------------------------------------------------------

// Splits a listing's capacity into two pools, each with exactly one owner:
//   online -> owned by central (sold through the app)
//   walkin -> owned by the island (sold at the front desk)
// Because no unit belongs to both pools, an online buyer and a walk-in guest can
// never fight over the same room, even while the island is offline.
// Example: capacity 10, share 0.3 -> { online: 3, walkin: 7 }.
export function splitCapacity(capacity: number, onlineShare: number) {
  const online = Math.round(capacity * onlineShare);
  return { online, walkin: capacity - online };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// Returns the HMAC secret used to sign and verify tickets. Central signs online
// tickets, islands sign walk-in tickets and verify every ticket, so all
// machines must have the same TICKET_SECRET in their .env. Fails fast when it is
// missing so a misconfigured laptop is noticed at startup, not at check-in.
export function ticketSecret(): string {
  const secret = process.env.TICKET_SECRET;
  if (!secret) throw new Error('TICKET_SECRET is not set (see .env.example)');
  return secret;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

// Adds n days to a "YYYY-MM-DD" date. Works in UTC so the result never shifts
// because of the laptop's time zone or daylight-saving changes.
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Today's date as "YYYY-MM-DD" (UTC).
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
