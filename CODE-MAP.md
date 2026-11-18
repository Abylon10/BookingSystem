# Code map — where each part of Resortify is

Use this to find, read and explain any part of the system.
Every important spot in the code is tagged with a comment like `[PDC: Marshalling]`.
To list them all:

```powershell
git grep -n "PDC:"
```

## 1. The folders

| Folder | What runs there | Main files |
|---|---|---|
| `app/` | Guest phone app (Expo / React Native) | `App.tsx` (screens and navigation), `src/api.ts` (calls to central) |
| `central/` | Central node (cloud, Render) | `server.ts` (API + calls to islands), `admin.ts` (central dashboard API), `poll.ts`, `reports.ts` |
| `island/` | One island node per laptop | `server.ts` (RPC server + staff consoles), `engine.ts` (booking rules), `db.ts` (SQLite) |
| `shared/` | Code used by both central and islands | `marshal.ts`, `link.ts`, `rpc.ts`, `config.ts` |
| `proto/` | The gRPC contract | `booking.proto` |
| `loadtest/` | Performance and race tests | `search.ts`, `race.ts`, `reports.ts` |

## 2. Course concepts → code

| Concept | File | Function / part | What to say |
|---|---|---|---|
| **Client–server** | `app/src/api.ts` → `central/server.ts` | `request()` → `app.get/post('/api/…')` | The phone is the client; central serves the HTTP/JSON API. |
| **Client–server** | `island/server.ts` (bottom) | HTTP routes `/api/…` | Staff browsers are clients of their island node. |
| **Marshalling** | `shared/marshal.ts` | whole file | Objects ↔ JSON text, errors ↔ `{code, message}`, the gRPC `Invocation` envelope and the link frames. Every remote call goes through here. |
| **Marshalling (protobuf)** | `proto/booking.proto`, `shared/rpc.ts` | `Invocation`, `EventBatch` | gRPC encodes these messages as protobuf binary on the wire. |
| **RPC – client side** | `central/server.ts` | `callIsland()` | Central calls a named method on a remote island, with a deadline, over any of the three transports. |
| **RPC – server side** | `island/server.ts` | the `api` map | The methods central can call (`SearchAvailability`, `HoldBooking`, `ConfirmBooking`, …). One map serves all transports. |
| **RPC transport 1: gRPC** | `shared/rpc.ts`, `island/server.ts` | `call()`, `grpcHandlers.Invoke` | Used on a shared LAN / hotspot. |
| **RPC transport 2: WebSocket** | `shared/link.ts` | `class Peer` | Island connects OUT to central (works behind home routers); both sides call each other on one socket; replies matched by id. |
| **RPC transport 3: HTTPS polling** | `central/poll.ts`, `island/server.ts` | `PollPeer`, `pollLoop()` | Fallback for networks that block WebSockets. |
| **Middleware** | `central/server.ts`, `island/server.ts`, `shared/rpc.ts` | Express app, gRPC runtime, `Peer` | Hide the network so the booking code only sees method calls. |
| **Distributed nodes / data partitioning** | `island/db.ts`, `island/engine.ts` | one SQLite file per island | Each island owns its own rooms and bookings and is the only writer. References carry the island prefix (`MRP-…`) so central routes calls to the owner (`ownerOf()` in central). |
| **Parallel task execution** | `central/server.ts` | `search()` | All islands are asked at the same time with `Promise.all`; time ≈ slowest island, not the sum. `?mode=sequential` exists for the benchmark. |
| **Multithreading** | `central/reports.ts`, `central/report-worker.ts` | `parallelReport()`, `aggregate()` | Records split into ranges, one per worker thread, results merged (Amdahl's law). |
| **Concurrency control** | `island/engine.ts` | `reserve()` | All units for all days taken in ONE transaction, each with the guard `booked + blocked + qty <= capacity`. Online and walk-in use the same code, so the last room can never be sold twice. |
| **Synchronization** | `island/db.ts`, `island/engine.ts` | `transaction()`, `transition()` | `BEGIN IMMEDIATE` lock; a status changes only from the expected status (check-in once, confirm only a live hold). |
| **Idempotency** | `island/engine.ts`, `central/server.ts` | `reserve()` request id, `Idempotency-Key` | A retried request returns the same booking instead of a second one. |
| **Saga (distributed transaction)** | `central/server.ts`, `island/engine.ts` | `POST /api/bookings`, `POST /api/bookings/:ref/pay`, `confirm()`, `release()` | Hold → pay → confirm; a failed payment runs the compensation `ReleaseHold`. Holds also expire by themselves after 10 min (`expireHolds()`). |
| **Replication (outbox)** | `island/db.ts`, `island/server.ts`, `central/server.ts` | `addOutbox()`, `drainOutbox()`, `storeEvents()` | Every change writes an event in the same transaction; events are retried until central acknowledges them and de-duplicated by `event_id`. |
| **Fault tolerance / partitions** | `island/server.ts`, `shared/link.ts`, `central/server.ts` | `serve()` (partition switch), link close handling, heartbeats | A cut-off island keeps selling walk-ins; central marks it offline and refuses its online sales (consistency over availability). |
| **Security** | `shared/link.ts`, `island/server.ts`, `island/engine.ts`, `central/admin.ts` | `verifyHello()`, `readSession()`, `route(fn, adminOnly)`, scrypt in `addStaff()` | Signed island hello, HMAC session tokens, roles checked on the server, hashed passwords. |

## 3. Follow one online booking through the code

1. **Phone** – `app/src/screens/GuestForm.tsx` → `holdBooking()` in `app/src/api.ts` sends `POST /api/bookings` with an `Idempotency-Key`.
2. **Central** – `central/server.ts`, route `POST /api/bookings`: finds the owning island and calls `callIsland(island, 'HoldBooking', …)`.
3. **Marshalling** – `shared/marshal.ts`: the request becomes an `Invocation` (gRPC) or a `req` frame (WebSocket / polling).
4. **Island** – `island/server.ts`, `api.HoldBooking` → `engine.reserve()` in `island/engine.ts`: one transaction, guarded updates, `addOutbox()`.
5. **Reply** travels back the same way; central answers the phone with the `HELD` booking.
6. **Pay** – `POST /api/bookings/:ref/pay` → `ConfirmBooking` (or `ReleaseHold` if payment failed) → `engine.confirm()` / `engine.release()`.
7. **Sync** – the island's `drainOutbox()` sends the change to central's `storeEvents()`, which updates the copy in Supabase for the dashboard.

## 4. How the transports line up

| | gRPC (LAN) | WebSocket link (internet) | HTTPS polling (fallback) |
|---|---|---|---|
| Who connects | central → island | island → central | island → central |
| Call format | `Invocation { method, json }` | frame `{ t: "req", id, m, p }` | same frames, in HTTP bodies |
| Reply format | `Invocation` / status `"CODE: message"` | frame `{ t: "res", id, ok, p \| e }` | same frames |
| Code | `shared/rpc.ts`, `grpcHandlers` | `shared/link.ts` | `central/poll.ts`, `pollLoop()` |

All three are encoded and decoded by `shared/marshal.ts` and end in the same island `api` map.
