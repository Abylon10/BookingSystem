# Team laptop setup

Follow this once on each teammate's laptop (Laptops 2–4). Laptop 1 (central) is already set up.

| Laptop | Runs | Start command |
|---|---|---|
| Laptop 1 | Central node | `npm run central` |
| Laptop 2 | Biliran island node | `npm run island:biliran` |
| Laptop 3 | Maripipi island node | `npm run island:maripipi` |
| Laptop 4 | Higatangan island node | `npm run island:higatangan` |

## 1. Install the tools

1. **Node.js 24 or newer**: https://nodejs.org (LTS installer, keep the defaults).
2. **Git**: https://git-scm.com/download/win (keep the defaults).
3. **VS Code**: https://code.visualstudio.com

Check in a new terminal:

```bash
node -v
git --version
```

`node -v` must print `v24` or higher.

## 2. Get the code

In VS Code: **Ctrl+Shift+P → Git: Clone** → paste
`https://github.com/Abylon10/BookingSystem.git` → pick a folder → **Open**.

Then open the terminal (**Ctrl+`**) and run:

```bash
npm install
```

## 3. Create your `.env`

Copy `.env.example` to a new file named `.env` (same folder) and set:

```
TICKET_SECRET=<ask Laptop 1 for it — must be the same on all laptops>
NETWORK=hotspot
LINK_LATENCY_MS=0
```

Leave `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` **empty** — only Laptop 1 uses them.
Never commit `.env` or post the secret in the group chat.

## 4. Join the network

1. Connect to the team hotspot.
2. Run `ipconfig` and send your **IPv4 Address** (under the Wi-Fi adapter) to Laptop 1.
3. Make the hotspot a **Private** network: Settings → Network & internet → Wi-Fi → the hotspot → **Private network**.
4. Laptop 1 puts all IPs in `config/network.hotspot.json` and pushes. Then pull:

```bash
git pull
```

## 5. Start your node

Run your laptop's command from the table above, for example:

```bash
npm run island:maripipi
```

The first time, Windows Firewall asks about Node.js: tick **Private networks** and click **Allow**.

Check it works:

- Your staff console opens at http://localhost:8081 (Biliran), :8082 (Maripipi) or :8083 (Higatangan).
- On Laptop 1, `http://localhost:4000/api/listings` shows your island as `"online"`.

Stop the node with **Ctrl+C**.

## Troubleshooting

| Problem | Fix |
|---|---|
| `TICKET_SECRET is not set` | `.env` missing or misnamed (must be exactly `.env`, not `.env.txt`) |
| `Set ISLAND_ID to one of …` | Use one of the three `island:` commands exactly |
| Island shows `offline` on central | Network is Public, or firewall not allowed; from Laptop 1 run `Test-NetConnection -ComputerName <your IP> -Port 50052` (your island's gRPC port) |
| `EADDRINUSE` | The node is already running in another terminal; close it |
| Changes from the team missing | `git pull` |

## Member C (mobile app) — extra

On your laptop:

```bash
cd app
npm install
npx expo start
```

Install **Expo Go** on your phone (must support Expo SDK 58), join the same hotspot, and scan the QR
code. Create `app/.env` with `EXPO_PUBLIC_CENTRAL_URL=http://<Laptop 1 IP>:4000`.
Add packages with `npx expo install <name>`, not `npm install`.

## Daily routine

```bash
git pull          # get the latest before you start
npm install       # only if package.json changed
```

Commit your work on a branch and push; Laptop 1 merges into `main`.
