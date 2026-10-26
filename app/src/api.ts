/**
 * app/src/api.ts
 *
 * Client for central's HTTP API. Customer screens talk ONLY to central (never
 * to Supabase or the islands directly). Staff mode will talk to the island
 * laptop it stands next to; that client will live in its own file.
 */

// Central's address on the hotspot. Set EXPO_PUBLIC_CENTRAL_URL in app/.env
// to the central laptop's IP (find it with `ipconfig`); the fallback matches
// config/network.hotspot.json.
export const CENTRAL_URL = process.env.EXPO_PUBLIC_CENTRAL_URL ?? 'http://192.168.43.10:4000';

// A resort or tour as returned by GET /api/listings.
export interface Listing {
  id: string;
  island_id: string;
  kind: 'resort' | 'tour';
  name: string;
  location: string;
  description: string;
  price_php: number;
  facilities: string[];
  online_available: number | null; // units left to sell online that day (null = unknown)
  stale?: boolean;                 // true when the island was offline and central used its copy
}

// The full search response: listings plus per-island status and timing.
export interface SearchResult {
  mode: string;
  day: string;
  fanoutMs: number;  // time spent asking the islands
  totalMs: number;   // whole request, including Supabase lookups
  islands: { id: string; status: 'online' | 'offline'; ms: number }[];
  listings: Listing[];
}

// Searches all islands through central. `day` is YYYY-MM-DD; omit for today.
// Throws on a non-2xx response so screens can show an error message.
export async function searchListings(day?: string): Promise<SearchResult> {
  const q = day ? `?day=${day}` : '';
  const res = await fetch(`${CENTRAL_URL}/api/listings${q}`);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}
