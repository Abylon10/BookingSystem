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
// traffic) and the gRPC port (server-to-server traffic). host is null in the
// cloud setup, where islands are not called directly but connect out to
// central over the island link (shared/link.ts).
export interface Endpoint {
  host: string | null;
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

// A bookable resource with a daily capacity: rooms per night, tour seats or
// boat seats per day. One inventory per service, owned by its island (no split
// between online and walk-in).
export interface SeedService {
  id: string;
  kind: 'room' | 'tour' | 'boat' | 'transfer' | 'meal';
  name: string;
  capacity: number;
}

// One service used by a package: `qty` units per booking, or per guest when
// perGuest is true. Rooms are taken for every night of the stay; other
// services on the first day only.
export interface SeedPackageItem {
  service: string;
  qty: number;
  perGuest: boolean;
}

// What customers buy. pricing "per_guest" = price × guests; "per_package" =
// one price for up to maxGuests. nights 0 = day trip.
export interface SeedPackage {
  id: string;
  name: string;
  location: string;
  description: string;
  pricePhp: number;
  pricing: 'per_guest' | 'per_package';
  nights: number;
  maxGuests: number;
  items: SeedPackageItem[];
}

// An island: its services and packages. prefix starts its booking
// references (e.g. MRP-7F3K2), so central knows which island owns a booking.
export interface SeedIsland {
  id: string;
  name: string;
  prefix: string;
  services: SeedService[];
  packages: SeedPackage[];
}

// Root of seed.json.
export interface Seed {
  inventoryDays: number;
  holdMinutes: number;
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
// (real laptop IPs on demo day); NETWORK=cloud picks config/network.cloud.json
// (central on a cloud host, islands anywhere with internet); the default
// "local" runs everything on 127.0.0.1 with different ports so one laptop can
// host the whole system.
export function loadNetwork(): NetworkConfig {
  const name = process.env.NETWORK ?? 'local';
  return readJson<NetworkConfig>(join(ROOT, 'config', `network.${name}.json`));
}

// Loads the catalog (islands, listings, capacities). Central and every island
// read the same file, so both sides agree on ids, prices and pool sizes.
export function loadSeed(): Seed {
  return readJson<Seed>(join(ROOT, 'config', 'seed.json'));
}

// Island that owns a booking reference, from its prefix (MRP-7F3K2 -> maripipi).
export function islandOfReference(seed: Seed, reference: string): SeedIsland | undefined {
  const prefix = String(reference).toUpperCase().split('-')[0];
  return seed.islands.find((i) => i.prefix === prefix);
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
