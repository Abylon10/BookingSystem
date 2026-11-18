/**
 * island/create-admin.ts
 *
 * Creates an island account straight in the island's database. Normally the
 * central admin creates island admins from the central dashboard (Accounts
 * page); this is the fallback for an island that has no link to central yet
 * (first setup on a LAN, demos, tests). Works for the built-in islands and
 * for islands registered on central.
 *
 *   npm run island:admin -- maripipi --user maria --pass "a long password"
 *   (add --role receptionist for a receptionist account)
 *
 * Safe to run while the island is running (SQLite WAL allows it).
 */
import { parseArgs } from 'node:util';
import { loadSeed } from '../shared/config.ts';
import { openDb, seedIsland } from './db.ts';
import { createEngine } from './engine.ts';

// Command line: island id, then --user, --pass, optional --role.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { user: { type: 'string' }, pass: { type: 'string' }, role: { type: 'string', default: 'node_admin' } },
});
const seed = loadSeed();
// A built-in island from seed.json, or an island registered on central (only
// its id is needed to open its database here).
const id = positionals[0] ?? '';
const island = seed.islands.find((i) => i.id === id)
  ?? (/^[a-z][a-z0-9]{1,30}$/.test(id) ? { id, name: id, prefix: id.slice(0, 3).toUpperCase(), services: [], packages: [] } : undefined);
if (!island || !values.user || !values.pass) {
  console.error(`Usage: npm run island:admin -- <${seed.islands.map((i) => i.id).join('|')}|registered island id> --user NAME --pass PASSWORD [--role receptionist]`);
  process.exit(1);
}

// Open (and if needed create) the island database, then add the account.
const db = openDb(island.id);
seedIsland(db, seed, island);
const engine = createEngine(db, island, seed.holdMinutes, seed.inventoryDays);
try {
  const made = engine.addStaff(values.user, values.pass, values.role === 'receptionist' ? 'receptionist' : 'node_admin');
  console.log(`Created ${made.role === 'node_admin' ? 'node admin' : 'receptionist'} "${made.username}" on ${island.name}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
