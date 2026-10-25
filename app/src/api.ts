// Central's address on the hotspot. Customers talk only to central; staff mode
// talks to the island laptop it is standing next to.
export const CENTRAL_URL = process.env.EXPO_PUBLIC_CENTRAL_URL ?? 'http://192.168.43.10:4000';

export interface Listing {
  id: string;
  island_id: string;
  kind: 'resort' | 'tour';
  name: string;
  location: string;
  description: string;
  price_php: number;
  facilities: string[];
  online_available: number | null;
  stale?: boolean;
}

export interface SearchResult {
  mode: string;
  day: string;
  totalMs: number;
  islands: { id: string; status: 'online' | 'offline'; ms: number }[];
  listings: Listing[];
}

export async function searchListings(day?: string): Promise<SearchResult> {
  const q = day ? `?day=${day}` : '';
  const res = await fetch(`${CENTRAL_URL}/api/listings${q}`);
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}
