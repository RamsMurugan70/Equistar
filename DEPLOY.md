# Deploying EquiStar

One container. Inside it, a hub that participants sign in to, and one app process per
participant that the hub starts on demand and routes them to.

---

## What you need

- A host with Docker. A 4 GB droplet is comfortable for 25 participants — a real Equix backend
  measures about 56 MB, so 25 of them plus the hub is roughly 1.5 GB with room to spare.
- **No domain and no open ports.** The tunnel dials outward, so 80 and 443 stay shut.

---

## 1. Get the code and the secrets in place

```bash
git clone <your repo> equistar && cd equistar
cp .env.example .env
printf 'SESSION_SECRET=%s\nCREDENTIAL_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
```

**Keep a copy of `CREDENTIAL_KEY` somewhere other than this server.** It decrypts every
participant's stored broker API secret and is deliberately not in any database. Lose it and all
twenty-five re-enter their keys.

---

## 2. Seed the shared market data

The app reads scans, prices and corporate actions from one shared database that every instance
attaches. Build it from a copy of the desktop app's database, on your own machine:

```bash
node app/scripts/splitDatabase.js --from "D:\AI Projects\ZTA-Codex\data\app.db"
```

That writes two files into `data/`:

| | |
|---|---|
| `market.db` | scans, prices, fundamentals, corporate actions — shared by everyone |
| `template.db` | the empty per-participant schema, copied for each new account |

The script **asserts** that no personal data reached the template and refuses to finish
otherwise, because shipping one person's trades to twenty-five strangers would otherwise look
exactly like success.

Copy both onto the server's volume before first boot:

```bash
docker compose up -d --build          # creates the volume
docker compose cp data/market.db equistar:/data/market.db
docker compose cp data/template.db equistar:/data/template.db
docker compose restart equistar
```

Starting without them is not fatal: participants can still be created, but nothing scan-derived
works until `market.db` exists, and no participant can be created without `template.db`.

---

## 3. Find your address

```bash
docker compose logs cloudflared | grep -i trycloudflare
```

A line with `https://something-random.trycloudflare.com`. That is the workshop's address.

---

## 4. Create the admin

```bash
docker compose exec equistar node hub/src/scripts/createAdmin.js
```

It prints a one-time password. Sign in, change it when asked.

**An admin manages people and does not trade** — no portfolio, no app instance, no broker keys.
To use the app yourself, create an ordinary participant account and sign in as that.

---

## 5. Add the participants

On the admin page: login ID, name, Create. Each one gets a generated password shown **once** —
give it to them then, because it is not stored in readable form and can only be reset.

Each participant gets their own database and their own port. Their instance is not started until
they first sign in, so adding twenty-five accounts in a row launches nothing.

---

## 6. Run the first scan

Admin page → **Run the scan now**. Takes a few minutes for about 750 symbols.

Run it **after 15:30 IST**. During market hours Yahoo returns a live, incomplete candle and the
scan records it as though it were a close.

There are no schedulers anywhere in EquiStar. This scan and every broker sync happen because
somebody pressed a button.

---

## What each participant does

1. Sign in with the ID and password you gave them, and set their own password.
2. **Brokers** → follow the steps for ICICI or Zerodha, paste in their own API key and secret.
3. Copy the **Redirect URL** shown on that page into their broker's developer console, exactly.
   One wrong character is the most common reason a login fails and the broker will not say which.
4. **Connect**, then **Daily Sync → Sync now** to pull holdings and trades.

Both broker sessions expire daily and neither can be renewed without a person, so this is a
once-a-morning routine rather than something the server can do for them.

---

## Backups

Everything worth keeping is in one volume:

```bash
docker compose exec equistar tar czf - /data > equistar-$(date +%F).tar.gz
```

That includes every participant's trading history. Treat it accordingly, and remember it is
useless without `CREDENTIAL_KEY` — which is the intended behaviour, not a problem to fix.

---

## Updating

```bash
git pull && docker compose up -d --build
```

Instances are children of the hub and stop with it, then restart as participants sign in again.
Nothing in `/data` is touched by a rebuild.

---

## What this deployment does not have

- **No scheduled anything.** By design. If nobody presses Sync, no data arrives.
- **A quick-tunnel hostname changes on every restart.** Fine while you are testing; not fine once
  twenty-five people have the link. Set `TUNNEL_TOKEN` for a named tunnel before the workshop.
- **Cloudflare terminates TLS**, so it can see the traffic. Worth a conscious decision for an app
  holding broker credentials.
- **No offsite backups, no metrics, no alerting.** If something stops working, someone has to
  notice.
- **One instance per participant does not scale past the port range** — 100 by default. Well
  beyond a workshop, but it is a ceiling, not a warning.
