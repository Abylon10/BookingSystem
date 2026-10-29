# BookingSystem — Design (v2)

A parallel & distributed booking system for resort and tour **packages** in **Biliran, Philippines**.
Customers book and pay online in an Expo app; each island runs its own node where staff sell
walk-in packages, confirm arriving guests, and manage their own services — even while the island
is cut off from the mainland.

> Class project (Parallel & Distributed Computing). Due **2026-11-20**.
> Places are real; the resorts and tour operators are fictional.
>
> **v2 (2026-10-29), adviser changes:** no inventory split; receptionists mark services unavailable
> by hand; no tickets (guests show their payment confirmation); customers book packages;
> admins on every node plus a central admin. See §14 for what was removed.

---

## 1. Physical setup (demo)

All devices join one phone hotspot.

| Device | Role | Runs |
|---|---|---|
| Laptop 1 | **Central** ("mainland") | `central/` — API for the app, central admin panel, Supabase storage |
| Laptop 2 | **Island node: Biliran mainland** | `island/` with `biliran` — node console (node admin + receptionist) |
| Laptop 3 | **Island node: Maripipi** | `island/` with `maripipi` |
| Laptop 4 | **Island node: Higatangan** | `island/` with `higatangan` |
| Phones ×4 | Customers | `app/` (Expo Go) |

Every island laptop runs the **same code** with a different island id.

## 2. Roles

| Role | Where they work | What they can do |
|---|---|---|
| **Central admin** | Central admin panel (Laptop 1) | Register islands/resorts; create and disable **node admin** accounts; view **all bookings** and **reports** across islands |
| **Node admin** | Their island's node console | Manage **their own** services, packages and prices; create and disable **receptionist** accounts for their island; everything a receptionist can do |
| **Receptionist** | Their island's node console | Walk-in bookings; confirm arriving guests (look up booking, check ID); **mark a service unavailable** for given dates |
| **Customer** | Expo app | Browse packages, book and pay online, view their booking confirmation, cancel |

Customers do not need an account: a booking is looked up by **reference + email**.

## 3. Data ownership — one writer per piece of data

| Data | Owner (only writer) | Copy kept by | How the copy is updated |
|---|---|---|---|
| Island registration (id, name, address) | Central | Island | Island pulls from central |
| Central admin + node admin accounts | Central | Island | Island pulls from central |
| Receptionist accounts | **That island** | Central | Island outbox → central |
| Services, packages, prices | **That island** | Central | Island outbox → central |
| Inventory and unavailable dates | **That island** | — | Never copied; always asked live |
| Bookings (online and walk-in) | **That island** | Central | Island outbox → central |

Because every item has exactly one writer, two sides can never make conflicting edits:
central cannot change Maripipi's prices, and Maripipi cannot change a node admin account.

## 4. Architecture

```
 📱 Expo app ──HTTP──► Central (Laptop 1) ──► Supabase
                        │   central admin panel (web)
                        │   copies: catalog, bookings, receptionists, events
                        │   owns:   islands, central/node admin accounts
            gRPC IslandService ▼   ▲ gRPC CentralService
        ┌──────────────────┬───┴──────────────┐
   Island: biliran    Island: maripipi    Island: higatangan
   SQLite: services, packages, inventory, bookings, receptionists, outbox
   Node console (web): login → node admin pages / receptionist pages
```

## 5. Catalog: services and packages

- A **service** is one bookable resource with a daily capacity:
  `room` (units per night), `tour` (seats per day), `boat` (seats per trip/day), `meal` (servings per day).
- A **package** is what customers buy. It belongs to one island and lists the services it uses:

  | Package (example) | Price | Nights | Max guests | Uses |
  |---|---|---|---|---|
  | Sambawan Overnight | ₱3,500 | 1 | 2 | 1 cottage × 1 night, island hopping × guests, boat × guests |
  | Falls Day Trek | ₱950 | 0 | 1 | falls trek × guests |

- Each package item says how much it takes: a **fixed** amount per booking (e.g. 1 room) or
  **per guest** (e.g. 1 tour seat per person). Rooms are taken for every night of the stay.
- Packages never span islands, so **one node owns the whole booking** and no cross-island
  transaction is needed.

### Inventory

Per service per day: `capacity`, `booked`, `blocked`, with the rule `booked + blocked <= capacity`.

- **Booking** a package increases `booked` on every service/day it uses, in **one transaction**,
  each step guarded by `WHERE booked + blocked + qty <= capacity`. If any step fails, everything rolls back.
- **Mark unavailable** (receptionist) increases `blocked`, e.g. "2 rooms under repair" or
  "boat not running on Nov 12" (block all). Units that are already booked cannot be blocked;
  the console shows the affected bookings so staff can contact those guests.
- A package is **available** on a date if every service it uses has enough free units.

## 6. Flows

### 6.1 Online booking (customer → central → island)

1. **Search:** the app asks central; central asks **all islands in parallel** for available packages
   for the date and guest count. An island that does not answer is shown as **unavailable** (§8).
2. **Hold:** the customer picks a package; central calls `HoldBooking` on the owning island. The island
   reserves every service in one atomic transaction and returns a booking in state `HELD` (expires in 10 min).
3. **Pay:** mock payment on central.
4. **Confirm:** central calls `ConfirmBooking`; the booking becomes `CONFIRMED`.
   If payment fails, is cancelled, or the hold expires → `ReleaseHold` / expiry returns the units.
   *(This is a small saga: hold → pay → confirm, with release as the compensating step.)*
5. **Confirmation info:** the app shows the reference (e.g. `MRP-7F3K2`), guest name, package, dates,
   guests and amount paid. This screen is what the guest shows at the island.

### 6.2 Walk-in booking (receptionist)

The receptionist picks a package, date and guests on the node console, takes payment at the desk, and the
booking is created `CONFIRMED` directly from the **same inventory** as online bookings.

### 6.3 Arrival / confirmation (no tickets)

The guest shows the confirmation info from the app. The receptionist searches by **reference or name**,
sees the booking, checks the guest's physical ID against the name (and ID type + last 4 digits, if
given), then clicks **Confirm arrival** → `CHECKED_IN`. The update only succeeds from `CONFIRMED`, so a
booking can be checked in exactly once even from two desks at the same time.

### 6.4 Node admin changes services

Node admin edits a service, package or price on their console → saved in the island database
**immediately** (works offline) → outbox event → central updates its copy → visible to the app.

### 6.5 Central admin registers an island

Central admin registers "Maripipi Island" (id, name, address) and creates its first node admin
account. When the Maripipi node starts (or reconnects) it calls `PullDirectory` and receives its
registration and the admin accounts for its island. From then on the node admin manages everything local.

### 6.6 Accounts and login

- Passwords are stored as **scrypt hashes**, never in plain text.
- Node admins create receptionists on their node; the account syncs to central for the central
  admin's overview.
- Logins are checked **on the node itself** against its local copy of accounts, so staff can log in
  while the island is offline. Central admins log in to the central panel.

### 6.7 Booking lifecycle

```
online:  HELD ──pay──► CONFIRMED ──arrival──► CHECKED_IN
           │               │
        EXPIRED /       CANCELLED (customer, refund)
        RELEASED        NO_SHOW (batch job after the date)
walk-in:           CONFIRMED ──arrival──► CHECKED_IN
```

## 7. Race conditions and how each is handled

| Race | Where | Fix |
|---|---|---|
| Online buyer vs walk-in guest, last room | Island | Both go through the island; one atomic guarded update per service/day decides |
| Two online buyers, last seats | Island | Same guarded update; the loser gets "sold out" before paying |
| Receptionist blocks a room while it is being booked | Island | Both use the same guard (`booked + blocked <= capacity`); whichever commits second fails |
| Hold expires while the customer pays | Island | Confirm only succeeds on a `HELD` booking that has not expired; otherwise payment is refunded |
| App retries after a timeout | Central + island | Idempotency key (`request_id` unique) — same request, same booking |
| Two desks confirm the same arrival | Island | `UPDATE … WHERE status='CONFIRMED'` succeeds once |
| Same event delivered twice during sync | Central | Events de-duplicated by `event_id` |
| Central admin and node admin edit the same data | — | Impossible: every item has one owner (§3) |

## 8. Island offline (partition)

Each node console has a **Disconnect from Central** switch for the demo (or a real firewall rule).

| While an island is offline | Behaviour |
|---|---|
| Its packages in the app | Shown as **unavailable** — central cannot hold or confirm, so it does not sell |
| Walk-ins, arrivals, mark-unavailable on the island | **Keep working** locally |
| Node admin edits, new receptionists | Saved locally, queued in the outbox |
| Staff login | Works (accounts are stored on the node) |
| Online booking already `CONFIRMED` | Can be checked in (it is stored on the island) |
| On reconnect | Outbox drains to central; island pulls account/registration changes |

This is a deliberate **consistency-over-availability** choice for online sales: never sell what the
owning island cannot confirm.

## 9. gRPC contract (`proto/booking.proto`, to be updated)

**IslandService** (central → island)

| RPC | Purpose |
|---|---|
| `GetCatalog` | Services and packages of the island |
| `SearchAvailability(day, guests)` | Packages available on a date (search fan-out) |
| `HoldBooking(request_id, package, day, guests, guest info)` | Reserve inventory, returns `HELD` booking |
| `ConfirmBooking(booking_id, payment_ref)` | `HELD` → `CONFIRMED` |
| `ReleaseHold(booking_id)` | Undo a hold (payment failed / cancelled) |
| `CancelBooking(booking_id)` | Customer cancellation → units returned |
| `GetBooking(reference, email)` | "My booking" lookup in the app |
| `Ping` | Reachability |

**CentralService** (island → central)

| RPC | Purpose |
|---|---|
| `PushEvents(events)` | Outbox: bookings, catalog changes, receptionist accounts |
| `PullDirectory(island_id, since)` | Registration + central-owned accounts changed since `since` |

## 10. Parallelism (what we measure)

| Experiment | Compare | Metric |
|---|---|---|
| Search fan-out to 3 islands | sequential vs parallel RPC | latency, speedup (≈3×) |
| Online vs walk-in race for the last room | N concurrent clients, mixed channels | oversells (must be 0), throughput |
| Double arrival confirmation | 2 desks at once | exactly one success |
| Reports (occupancy, sales per island/package) | 1 / 2 / 4 / 8 worker threads | speedup, efficiency (Amdahl) |
| Load test | 10 / 50 / 100 clients | throughput, p95 latency, error rate |

## 11. Screens

**Expo app (customer):** Home (packages, island status) · Filter · Package detail · Select date & guests ·
Guest details (name, email, phone, ID type + last 4) · Payment (mock) · **Confirmation info** ·
My bookings (reference + email) · Cancel booking.

**Node console (web, per island):** Login ·
*Receptionist:* today's arrivals, search & confirm arrival, walk-in booking, mark unavailable ·
*Node admin:* services, packages & prices, receptionist accounts.

**Central admin panel (web):** Login · Islands (register / edit) · Node admin accounts ·
All bookings (filter by island, status, date) · Reports.

Palette (all UIs):

| Token | Hex | Use |
|---|---|---|
| `ink` | `#12212E` | Text, dark mode background |
| `primary` | `#307082` | Header, tabs, selected chips, primary buttons (white text OK) |
| `secondary` | `#6CA3A2` | Unselected chips, icons, badges |
| `sand` | `#ECE7DC` | Screen background |
| `accent` | `#EA9940` | Prices, highlights — use **ink** text on it, not white |

UI based on a hotel-booking UI kit found on Pinterest (inspiration only — credit it in the report).

## 12. Tech

- **TypeScript on Node 24+** (runs `.ts` directly); `npm run typecheck`.
- **gRPC** (`@grpc/grpc-js` + `@grpc/proto-loader`), contract in `proto/booking.proto`.
- **Island storage:** built-in `node:sqlite`. **Central storage:** Supabase Postgres (service key on Laptop 1 only).
- **App:** Expo SDK 58. **Consoles:** static web pages served by each node / central.
- **Passwords:** `node:crypto` scrypt. **Reports:** `node:worker_threads`.

| Service | HTTP | gRPC |
|---|---|---|
| central | 4000 | 50050 |
| island biliran | 8081 | 50051 |
| island maripipi | 8082 | 50052 |
| island higatangan | 8083 | 50053 |

## 13. Team split and timeline

| Who | Owns |
|---|---|
| Laptop 1 owner | Central: API, hold/pay/confirm saga, central admin panel, Supabase, `proto/` |
| Teammate A | Island server: services/packages/inventory, hold/confirm, accounts + login, outbox/pull sync |
| Teammate B | Expo app: customer screens |
| Teammate C | Node console UI (receptionist + node admin), reports with worker threads, load tests, charts |

| Dates | Milestone |
|---|---|
| Oct 29 – Nov 2 | Design v2, island data model + packages + hold/confirm, **hotspot test with all 8 devices** |
| Nov 3 – 9 | App screens, node console, central admin panel, accounts + login |
| Nov 10 – 15 | Catalog/account sync, offline demo, reports, load tests, benchmarks |
| Nov 16 – 20 | Report, charts, rehearsal (buffer) |

## 14. Removed from v1

| v1 | Why it is gone |
|---|---|
| Online/walk-in **allotment split** and rebalancing | Adviser: no splitting; one inventory per service, owned by the island |
| Signed **QR tickets**, `BK-XXXX-YYYY` codes, staff scanner phone | Adviser: no tickets; guest shows the payment confirmation info |
| Single-listing booking | Adviser: customers book packages |
| Online selling while an island is offline | Without a split, only the island can confirm; its packages show as unavailable |
