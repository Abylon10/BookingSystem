import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Endpoint {
  host: string;
  httpPort: number;
  grpcPort: number;
}
export interface IslandEndpoint extends Endpoint {
  id: string;
}
export interface NetworkConfig {
  central: Endpoint;
  islands: IslandEndpoint[];
}

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
export interface SeedIsland {
  id: string;
  name: string;
  listings: SeedListing[];
}
export interface Seed {
  inventoryDays: number;
  onlineShare: number;
  islands: SeedIsland[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// NETWORK=hotspot picks config/network.hotspot.json; default is all-on-localhost.
export function loadNetwork(): NetworkConfig {
  const name = process.env.NETWORK ?? 'local';
  return readJson<NetworkConfig>(join(ROOT, 'config', `network.${name}.json`));
}

export function loadSeed(): Seed {
  return readJson<Seed>(join(ROOT, 'config', 'seed.json'));
}

// Capacity is split once into two pools with one owner each, so online and
// walk-in sales never compete for the same unit.
export function splitCapacity(capacity: number, onlineShare: number) {
  const online = Math.round(capacity * onlineShare);
  return { online, walkin: capacity - online };
}

export function ticketSecret(): string {
  const secret = process.env.TICKET_SECRET;
  if (!secret) throw new Error('TICKET_SECRET is not set (see .env.example)');
  return secret;
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
