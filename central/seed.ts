// Loads config/seed.json into Supabase: catalog copy + the ONLINE pool.
// Safe to re-run: existing inventory rows are left as they are.
import { createClient } from '@supabase/supabase-js';
import { addDays, loadSeed, splitCapacity, today } from '../shared/config.ts';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });
const seed = loadSeed();
const start = today();

const listings = seed.islands.flatMap((island) => island.listings.map((l) => ({
  id: l.id, island_id: island.id, kind: l.kind, name: l.name, location: l.location,
  description: l.description, price_php: l.pricePhp, facilities: l.facilities, image: l.image,
})));
const { error: listingError } = await sb.from('listings').upsert(listings);
if (listingError) throw listingError;

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
