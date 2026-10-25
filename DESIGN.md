# BookingSystem — Design

A parallel & distributed booking system for resorts and tours in **Biliran, Philippines**.
Customers book online from an Expo app; staff on each island sell walk-in (face-to-face)
tickets and confirm guests' IDs at check-in, even when the island loses its link to the mainland.

> Class project (Parallel & Distributed Computing). Due **2026-11-20**.
> Places are real; the resorts and tour operators are fictional.

---

## 1. Physical setup (demo)

All devices join one phone hotspot.

| Device | Role | Runs |
|---|---|---|
| Laptop 1 | **Central** ("mainland cloud") | `central/` — HTTP API for the app, gRPC client to islands, gRPC server for sync, Supabase for storage |
| Laptop 2 | **Island node: Biliran mainland** | `island/` with `ISLAND_ID=biliran` + staff console |
| Laptop 3 | **Island node: Maripipi** | `island/` with `ISLAND_ID=maripipi` + staff console |
| Laptop 4 | **Island node: Higatangan** | `island/` with `ISLAND_ID=higatangan` + staff console |
| Phones ×4 | Customer app / staff scanner | `app/` (Expo Go) |

Every island laptop runs the **same code** with a different `ISLAND_ID`.

## 2. Catalog (3 islands × 1 resort + 1 tour)

| Island | Resort (rooms/night) | Tour (seats/day) |
|---|---|---|
| Biliran mainland | Lagundi Bay Resort, Almeria | Tinago & Ulan-Ulan Falls Trek, Caibiran |
| Maripipi | Dagami Reef Cottages | Sambawan Island Hopping & Snorkel |
| Higatangan | Higatangan Sandbar Inn | Higatangan Rock Formations & Sandbar Tour |

Seed data lives in `config/seed.json` (single source for both island and central).

## 3. Architecture

```
 📱 Expo app ──HTTP/JSON──► Central (Laptop 1) ──► Supabase (online pool, online bookings)
 (customer / staff)            │  ▲
                   gRPC IslandService  gRPC CentralService (outbox sync)
                               ▼  │
        ┌───────────────┬───────┴────────┐
   Island: biliran   Island: maripipi   Island: higatangan
   SQLite (walk-in pool, bookings, outbox, redemptions)
   HTTP: staff console + staff-phone scan API
```

### Ownership rule — one writer per item
- **Island node** owns: catalog, walk-in pool, F2F bookings, **ticket redemption** for its listings.
- **Central** owns: customer accounts, **online pool** (allotment), online bookings, payments (mock).
- Nobody writes another owner's data directly — only through RPC or the sync stream.

## 4. Race conditions and how each is handled

| Race | Where | Fix |
|---|---|---|
| Two online buyers, last seat | Supabase | Postgres function with `UPDATE … WHERE available >= qty` (atomic) |
| Two walk-ins / desk vs desk | Island SQLite | Same conditional update inside `BEGIN IMMEDIATE` transaction |
| Online vs walk-in, last seat | Across nodes | **Allotment**: capacity split into `online` and `walkin` pools, each with a single owner — they never compete |
| Island offline | Partition | Island keeps selling its pool; online keeps selling its pool; no coordination needed |
| RPC retry after timeout | Network | `Idempotency-Key` / `request_id` unique constraint |
| Same QR scanned at two counters | Island | `UPDATE … SET status='REDEEMED' WHERE id=? AND status='CONFIRMED'` succeeds once |
| Event re-delivery during sync | Central | Events deduped by `event_id` |

**Rebalance** (stretch goal): when both sides are connected, move unsold seats between pools
(`TransferAllotment` RPC), e.g. release online seats to the counter 24h before a tour.

**Reconciliation** (stretch goal, "Option C"): compare totals after reconnect; flag oversells.

## 5. Booking lifecycle

```
HELD ──► CONFIRMED ──► REDEEMED
  │          │
EXPIRED   CANCELLED (refund — saga compensation releases inventory)
                       NO_SHOW (batch job after the date passes)
```

Packages (resort + tour) run as a **saga** on central: hold both in parallel → mock charge →
confirm both; any failure → compensate (release holds / refund).

## 6. Tickets and ID confirmation

- Central issues a ticket on confirmation:
  - **QR payload**: `{v, id, listing, date, qty, guest, idType, idLast4}` + HMAC-SHA256 signature.
  - **Manual code**: `BK-XXXX-YYYY` — `XXXX` from the booking id, `YYYY` a short HMAC check value.
- Islands share the `TICKET_SECRET`, so they verify tickets **offline**.
- Only the **last 4 digits** of a guest's ID are stored (privacy).
- Staff scan with the **Expo app in staff mode** (laptops have no webcams) → POST to that island's
  HTTP API on the hotspot → laptop console shows the guest → staff checks the physical ID → **Confirm**.
- Fallback: staff type the manual code into the console.

## 7. Offline / partition demo

Each island console has a **"Disconnect from Central"** toggle: the island refuses central's RPCs and
pauses its outbox, while local staff (console + scanner phone) keep working. Optionally a real
partition: Windows Firewall rule blocking the central laptop's IP.

Sync: every local write also inserts an `outbox` row in the same transaction; a background sender
pushes batches to `CentralService.PushEvents` and marks them sent on ack.

## 8. Parallelism (what we measure)

| Experiment | Compare | Metric |
|---|---|---|
| Search fan-out to 3 islands | sequential vs parallel RPC | latency |
| Last-seat race (N concurrent clients) | unsafe read-then-write vs atomic update | double bookings (must be 0) |
| Load test, mixed online + walk-in | 10 / 50 / 100 clients | throughput, p95 latency, errors |
| Batch job (no-shows / storm cancellation) | 1 / 2 / 4 / 8 worker threads | speedup, efficiency (Amdahl) |
| Double scan of one QR | 2 phones at once | exactly one success |

## 9. Tech

- **TypeScript on Node 26** (runs `.ts` directly; `npm run typecheck` with `tsc`).
- **gRPC** (`@grpc/grpc-js` + `@grpc/proto-loader`), contract in `proto/booking.proto`.
- **Island storage**: built-in `node:sqlite`. **Central storage**: Supabase Postgres.
- **App**: Expo (React Native). Everyone on the team must use the same Expo SDK in Expo Go (mixed iPhone/Android).
- **Staff console**: static web page served by each island.

### Ports

| Service | HTTP | gRPC |
|---|---|---|
| central | 4000 | 50050 |
| island biliran | 8081 | 50051 |
| island maripipi | 8082 | 50052 |
| island higatangan | 8083 | 50053 |

On demo day each runs on its own laptop; `config/network.hotspot.json` holds the laptops' IPs.

## 10. UI

Based on a hotel-booking UI kit found on Pinterest (inspiration only — credit in the report),
recolored with the "Travel Agency" palette:

| Token | Hex | Use |
|---|---|---|
| `ink` | `#12212E` | Text, dark mode background |
| `primary` | `#307082` | Header, tabs, selected chips, primary buttons (white text OK) |
| `secondary` | `#6CA3A2` | Unselected chips, icons, badges |
| `sand` | `#ECE7DC` | Screen background |
| `accent` | `#EA9940` | Prices, highlights — use **ink** text on it, not white |

Screens — customer: Home/Search, Filter, Results, Detail, Select Date, Guest Details (+ ID type, last 4),
Payment (mock), Success, Ticket (QR + code), My Bookings (Ongoing/Completed/Canceled), Cancel, Profile.
Staff: Scan → result (Checked in / Already redeemed / Invalid).
Cut unless time allows: reviews, ratings, map.

## 11. Team split

| Who | Owns |
|---|---|
| Laptop 1 owner | Central, `proto/`, Supabase, search fan-out, sync receiver, integration |
| Teammate A | `island/` server: SQLite, pools, atomic booking, outbox, partition toggle |
| Teammate B | `app/`: customer screens + staff scanner |
| Teammate C | `island/console/`, `loadtest/`, batch job, benchmark charts |

## 12. Timeline

| Dates | Milestone |
|---|---|
| Oct 26 – Nov 1 | Contract, schemas, skeletons, static app screens, **all 8 devices tested on the hotspot** |
| Nov 2 – 8 | Online booking end-to-end, F2F booking, QR ticket, staff scan + confirm |
| Nov 9 – 15 | Partition toggle, outbox sync, cancel/refund saga, load tests + benchmarks |
| Nov 16 – 20 | Report, charts, rehearsal (buffer) |
