# Biliran Booking System

Parallel & distributed booking for resorts and tours in Biliran, Philippines.
Online bookings from an Expo app, walk-in bookings and ID check-in at each island's front desk —
and each island keeps working when it loses its link to the mainland.

See **[DESIGN.md](DESIGN.md)** for the architecture, race-condition handling, and team plan.

```
app/        Expo app (customer + staff scanner)            → phones
central/    HTTP API for the app, gRPC client, Supabase    → Laptop 1
island/     gRPC node + SQLite + staff console             → Laptops 2–4
proto/      gRPC contract (booking.proto)
shared/     config, gRPC helpers, ticket signing
loadtest/   race + search benchmarks
config/     seed data and network addresses
```

## Setup (every laptop)

Requires **Node 24+** (runs TypeScript directly).

```bash
npm install
cp .env.example .env    # then set TICKET_SECRET — same value on every laptop
```

## Run everything on one laptop

Open four terminals:

```bash
npm run island:biliran
npm run island:maripipi
npm run island:higatangan
npm run central
```

- Staff consoles: http://localhost:8081, :8082, :8083
- Central API: http://localhost:4000/api/listings

## Run on the hotspot (demo day)

1. Everyone joins the hotspot; note each laptop's IP (`ipconfig`).
2. Put the IPs in `config/network.hotspot.json` and set `NETWORK=hotspot` in `.env`.
3. Laptop 1: `npm run central`. Laptops 2–4: `npm run island:<id>`.
4. Allow Node through Windows Firewall on **private** networks when prompted.

## Central + Supabase

1. Apply `central/supabase/migrations/0001_init.sql` to the Supabase project.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in central's `.env` (never in the app).
3. `npm run central:seed` loads listings and the online pool.

Without Supabase, central still serves search (live from the islands); online booking returns 503.

## Expo app

Uses **Expo SDK 58**: every phone needs an Expo Go build that supports SDK 58 (iPhone and Android).

```bash
cd app
npm install
cp .env.example .env    # EXPO_PUBLIC_CENTRAL_URL = central laptop's hotspot IP
npx expo start          # scan the QR with Expo Go (phone must be on the same hotspot)
```

Add packages with `npx expo install <pkg>` (not `npm install`) so versions match the SDK.

## Experiments

```bash
# N parallel walk-ins for the same room: must never oversell
npm run test:race -- --island higatangan --listing higatangan-sandbar-inn --clients 30

# sequential vs parallel fan-out search (set LINK_LATENCY_MS=150 on islands to simulate the sea link)
npm run test:search -- --runs 20
```

## Team checks

```bash
npm run typecheck
```

UI inspired by a hotel-booking UI kit found on Pinterest; palette "Travel Agency"
(`#12212E #307082 #6CA3A2 #ECE7DC #EA9940`). Resorts and operators are fictional.
