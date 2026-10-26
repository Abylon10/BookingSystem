/**
 * central/seed.ts
 *
 * Loads config/seed.json into Supabase:
 *  - listings         : central's copy of every island's catalog (used when an
 *                       island is offline during search)
 *  - online_inventory : the ONLINE pool, units central may sell per day
 *
 * Safe to re-run (npm run central:seed): listings are updated in place and
 * existing inventory rows are left untouched, so sold units are never reset.
 * Re-running on a later date adds the new days at the end of the window.
 */
import { createClient } from '@supabase/supabase-js';
import { addDays, loadSeed, splitCapacity, today } from '../shared/config.ts';

// Connect with the server-side secret key (from central's .env).
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });
const seed = loadSeed();
const start = today();

// 1. Catalog: flatten islands -> listings and convert to the table's column names.
const listings = seed.islands.flatMap((island) => island.listings.map((l) => ({
  id: l.id, island_id: island.id, kind: l.kind, name: l.name, location: l.location,
  description: l.description, price_php: l.pricePhp, facilities: l.facilities, image: l.image,
})));
const { error: listingError } = await sb.from('listings').upsert(listings);
if (listingError) throw listingError;

// 2. Online pool: one row per listing per day, holding only the online share
//    of capacity (the walk-in share is created by each island in its SQLite).
const inventory = seed.islands.flatMap((island) => island.listings.flatMap((l) => {
  const { online } = splitCapacity(l.capacity, seed.onlineShare);
  return Array.from({ length: seed.inventoryDays }, (_, i) => ({
    listing_id: l.id, day: addDays(start, i), available: online,
  }));
}));
const { error: invError } = await sb.from('online_inventory')
  .upsert(inventory, { onConflict: 'listing_id,day', ignoreDuplicates: true });
if (invError) throw invError;

console.log(`Seeded ${listings.length} listings and ${inventory.length} online inventory rows`);
