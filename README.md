# EquiStar

The Equix portfolio tracker, hosted for a room of people instead of one.

Same app: dashboard, action queue, portfolio and health, LTCG/STCG, orders, the daily Top 25,
Stock Sleuth, Ask the Data, performance and daily sync. Three things added on top — an admin who
issues accounts, a sign-in, and a screen where each participant enters their own broker API keys.

---

## How twenty-five people share one app that was written for one

Equix has 33 tables and **not one of them carries a `user_id`**. It has no login and no concept
of an account. Adding one would have meant putting a user column on every table and auditing
every query across 111 files, where a single missed `WHERE` clause hands one person's portfolio
to another.

So EquiStar does not try. Each participant gets **their own process and their own database
file**, and the hub routes them there after they sign in:

```
                    ┌─ hub (:5080) ── the only thing anyone can reach
                    │     accounts, sessions, routing, the shared scan
                    │
     participant ───┤
                    └─► their own app process (:5100, :5101, …)
                          their own app.db          ← trades, holdings, broker keys
                          + market.db (attached)    ← scans and prices, shared by all
```

A process that never opens someone else's file cannot leak their data, however the queries
inside it are written. That is the entire security argument, and it needs no cooperation from
the app.

**Market data is the exception, and deliberately so.** Scans and prices are identical for
everyone and expensive to fetch — twenty-five instances scanning the same 500 symbols would put
12,500 requests at Yahoo in one minute and get the server's address blocked. One scan writes
`market.db`; every instance attaches it read-only. Because those tables do not exist in a
participant's own file, SQLite resolves the app's existing queries into the shared one and not a
single query had to change.

---

## Nothing runs on a timer

The desktop app started five schedulers. EquiStar has none. Broker capture happens when a
participant presses **Sync now**, and the universe scan when the admin presses **Run the scan**.

That is a deliberate choice, and it fits the constraint anyway: neither broker session can be
renewed without a human, so an unattended evening sync would fail for everyone who had not
logged in to their broker that day.

---

## Layout

```
hub/            accounts, sessions, instance supervision, the shared scan
  src/          config, db, accounts, instances, scanner, server
  web/          sign-in, forced password change, admin console
app/
  server/       the Equix backend — one process per participant
  client/       the React frontend, built once and served by every instance
  scripts/      splitDatabase.js, and the two Python fundamentals scripts
engines/        the Python scanners and scorer
data/           market.db, template.db, hub.db, users/<login>/app.db  (gitignored)
```

---

## Running it locally

```bash
cd hub && npm install
cd ../app/server && npm install
cd ../client && npm install && npm run build
```

Build the two shared databases from a copy of the desktop app's:

```bash
node app/scripts/splitDatabase.js --from "D:\AI Projects\ZTA-Codex\data\app.db"
```

Then create an admin and start the hub:

```bash
cd hub
node src/scripts/createAdmin.js
npm start                      # http://localhost:5080
```

`CREDENTIAL_KEY` must be set before anyone can save broker keys — see `.env.example`.

## Deploying it

See **[DEPLOY.md](DEPLOY.md)**. One container, a Cloudflare Tunnel for HTTPS without a domain,
and no open ports.

---

## What is deliberately not here

The options and F&O half of Equix — the recommendation engine, F&O P&L, the Telegram advisor
parser — and Investing.com ProPicks. Participants have an equity book and no options
subscription, and the strategy logic behind those screens is not theirs to receive.
