# Cloud deployment (islands anywhere with internet)

Central runs on **Render** with a public HTTPS address. Each island laptop opens **one
outgoing connection** to it (the *island link*, a WebSocket on `/island-link`) and keeps it
open. All RPC calls travel over that connection in both directions, so island laptops need
**no public IP, no port forwarding, and no shared Wi-Fi** — home Wi-Fi or mobile data works.

```
 📱 app ──HTTPS──► central (Render, https://biliran-central.onrender.com) ──► Supabase
                       ▲            ▲             ▲
            wss link   │            │             │   (each island connects OUT)
                 Biliran laptop  Maripipi     Higatangan
                 (any internet)  (any internet) (any internet)
```

| Concern | How it is handled |
|---|---|
| Islands behind NAT / mobile data | Islands connect outward; central never dials an island |
| Only one public port on the host | API and island links share the HTTPS port |
| Who may connect | Island signs a hello with `TICKET_SECRET` (HMAC, 5-minute window); others are closed with code 4003 |
| Encryption | HTTPS / WSS (TLS) between every island and central |
| Link drops (Wi-Fi blip, redeploy) | Island reconnects automatically with backoff (1 s → 30 s) |
| Free host sleeping after 15 min idle | Islands ping `/health` every 5 minutes while running |
| Admin dashboard on a public URL | `/` asks for `ADMIN_PASSWORD`; data API needs a signed 12-hour session token |
| Island offline | Same as before: walk-ins keep working, outbox syncs on reconnect |

The direct gRPC mode (`NETWORK=hotspot`) still works for a shared Wi-Fi demo.

## 1. Deploy central to Render (Laptop 1 owner, once)

1. Sign up at https://render.com (sign in with GitHub).
2. **New → Blueprint** → choose the repository **Abylon10/BookingSystem**. Render reads
   `render.yaml` and proposes the service **biliran-central**.
3. Fill in the two secrets it asks for:
   - `SUPABASE_SERVICE_KEY` — your `sb_secret_...` key (same as central's `.env`)
   - `TICKET_SECRET` — the same value every laptop uses
   - `ADMIN_PASSWORD` — a password you choose for the central dashboard at `/`
4. **Apply**. The first build takes a few minutes. Your URL appears at the top, e.g.
   `https://biliran-central.onrender.com`.
5. Check: open `https://<your-url>/health` → `{"ok":true,"supabase":true,"linkedIslands":[]}`.

Every push to `main` redeploys automatically. The free plan sleeps after 15 minutes without
traffic; the first request after that takes ~1 minute (running islands keep it awake).

## 2. Island laptops

In `.env`:

```
TICKET_SECRET=<same as everyone>
NETWORK=cloud
CENTRAL_URL=https://<your-url>
LINK_LATENCY_MS=0
```

Start as usual (`npm run island:biliran` etc.). The terminal prints
`connected to central at https://<your-url>`, and the staff console shows
**Connected (cloud link up)**. No firewall or Wi-Fi settings are needed for the link.

Check from anywhere: `https://<your-url>/health` lists the island under `linkedIslands`, and
`https://<your-url>/api/listings` shows it `"online"` with `"via":"link"`.

## 3. Phones

Set `app/.env` to `EXPO_PUBLIC_CENTRAL_URL=https://<your-url>` and restart `npx expo start`.
Phones can use any internet connection. (Expo Go itself still loads the app from the laptop
running `npx expo start`, so that laptop and the phones must be on the same network during
development, or use `npx expo start --tunnel`.)

## Test it locally without Render

```bash
# terminal 1 — central in cloud mode on port 4100
NETWORK=cloud PORT=4100 node --env-file-if-exists=.env central/server.ts
# terminals 2-4 — islands connect out to it
NETWORK=cloud CENTRAL_URL=http://localhost:4100 npm run island:biliran
```

Deployed 12 Nov: https://biliran-central.onrender.com (Render, Singapore). An island on a home
connection linked to it in ~2 s, showed online via the link (~240 ms round trip), walk-in synced,
partition switch worked.

Measured locally (12 Nov): all 3 islands linked; search, walk-in sync, partition switch and
online/offline status work over the link; after a central restart all islands re-linked
within 3 s; a forged hello was refused (code 4003); parallel search 2.98× faster than
sequential with a 150 ms simulated link.
