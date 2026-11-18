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
- On the central dashboard (Islands page) your island shows as online.

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
code. Create `app/.env` from `app/.env.example` (`EXPO_PUBLIC_CENTRAL_URL=https://biliran-central.onrender.com` and the Supabase URL + publishable key). If the phone cannot load the app over Wi-Fi ("Failed to download remote update"), connect the laptop to the phone's hotspot and run `npx expo start --lan`.
Add packages with `npx expo install <name>`, not `npm install`.

## Island accounts (sign-in page)

Each island console now opens on a **sign-in page**. There is no first-run setup on the island any more:

1. The **central admin** opens the central dashboard → **Accounts** → *Create island account* → picks the island, role **Island admin**, a username and a password (8+ characters). The island must be online.
2. The island admin signs in on the island console (http://localhost:8081/8082/8083) and adds **receptionists** under *Staff accounts*.
3. No link to central yet (e.g. first setup on a LAN)? On the island laptop:

```bash
npm run island:admin -- maripipi --user maria --pass "a long password"
```

Receptionists see Dashboard, Check-in, Walk-in, Services on/off and Bookings. Island admins also get Packages & services (prices, extra-day fees), Staff accounts, cancellations with refunds, and the Disconnect switch.

## Google sign-in for the app (once, Laptop 1)

1. **Google Cloud Console** → create a project → **Google Auth Platform** → set up the consent screen (app name, support e-mail, *External*), add the scope `openid`.
2. **Clients → Create client → Web application**. Under *Authorized redirect URIs* add `https://xrpkpxxxancrogjddriw.supabase.co/auth/v1/callback`. Save, copy the **Client ID** and **Client secret**.
3. **Supabase** → Authentication → **Sign In / Providers → Google** → enable, paste the Client ID and secret, save.
4. Supabase → Authentication → **URL Configuration → Redirect URLs** → add `biliranbooking://**` (installed app) and `exp://**` (Expo Go). The app's Account tab shows its exact return address at the bottom.
5. Facebook later: create a Meta developer app, enable **Facebook** in Supabase the same way, and set `EXPO_PUBLIC_FACEBOOK_LOGIN=1` for the app.

## Downloadable Android app (APK)

When the design and functions are final (Member C or Laptop 1):

```bash
cd app
npx eas-cli@latest login
npx eas-cli@latest build -p android --profile preview
```

Sign in with a free Expo account (create it at expo.dev). The build runs in Expo's cloud (about 10–20 minutes) and ends with a link to download the **.apk**. Share that link; phones install it after allowing "install unknown apps". `app/eas.json` already points the app at the Render central.

## Daily routine

```bash
git pull          # get the latest before you start
npm install       # only if package.json changed
```

Commit your work on a branch and push; Laptop 1 merges into `main`.
