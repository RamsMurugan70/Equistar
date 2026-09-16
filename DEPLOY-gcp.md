# Deploying EquiStar on Google Cloud, behind Tailscale Funnel

The as-built record of the deployment that is currently running. `DEPLOY.md` describes the
generic Docker + Cloudflare Tunnel path; this file describes what was actually done and, more
usefully, the four places where the obvious command does not work.

**No secrets or live addresses are recorded here.** The VM's external IP is in the Compute Engine
console, the public hostname comes from `tailscale status`, and the account passwords were shown
once at creation. A public repository is the wrong place for any of them.

---

## Why Tailscale rather than Cloudflare

Cloudflare Tunnel needs a domain on a Cloudflare account before it will give you a hostname that
survives a restart. Without one you get a quick tunnel whose address changes every time
`cloudflared` restarts, which is useless for a link handed to a room of people.

Tailscale Funnel gives a stable HTTPS hostname with a real certificate, on a free account, with
no domain at all. Both dial outward, so neither needs an inbound firewall rule — and that is the
property that matters, because an EquiStar instance has no authentication of its own and trusts
the hub to have checked the session.

---

## What was provisioned

Compute Engine VM, `asia-south1` (Mumbai), **e2-medium** — 2 vCPU, 4 GB, 30 GB balanced disk,
Ubuntu LTS.

That size was measured rather than guessed: the hub uses ~69 MB and one active participant
instance ~117 MB, so ten participants plus a running scan lands near 1.7 GB. `e2-small` (2 GB) is
too tight once the Python scanner loads pandas.

**All three firewall boxes left unticked** — "Allow HTTP", "Allow HTTPS", and "Allow load
balancer and health checks". Nothing external ever initiates a connection to this box, so GCP's
default-deny is a real layer of the design rather than an oversight.

Also left off: Ops Agent (100–200 MB of RAM for metrics nobody reads — about one participant's
worth), display device (it is a headless server), IP forwarding, and Tier_1 networking.

**Access scopes: "Allow default access".** EquiStar never calls a Google Cloud API. Granting
"full access to all Cloud APIs" would give an internet-facing box more privilege in the project
for no benefit at all.

SSH is by key, pasted into **Advanced options → Security → Manage Access**. GCP derives the Linux
username from the key's trailing comment, so a key ending `... equistar-deploy` produces the user
`equistar-deploy`. Paste it as a single line; a wrapped key is rejected or parsed wrong.

---

## Gotcha 1 — the OS is newer than the docs assume

GCP's Ubuntu LTS image was **26.04 (`resolute`)**, not the 24.04 most guides assume. Docker's apt
repository does carry that codename, so the official repo install works unchanged — but check
before assuming:

```bash
curl -sI https://download.docker.com/linux/ubuntu/dists/$(lsb_release -cs)/Release | head -1
```

A `200` means the codename exists. Ubuntu's own `docker.io` package was *not* available on this
image, so the official repository is the only route.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Tailscale installs the same way, with the same codename in its keyring and list URLs.

---

## Code and secrets

```bash
sudo mkdir -p /opt/equistar && sudo chown $USER:$USER /opt/equistar
git clone https://github.com/RamsMurugan70/Equistar.git /opt/equistar
cd /opt/equistar
printf 'SESSION_SECRET=%s\nCREDENTIAL_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
chmod 600 .env
```

**Keep `CREDENTIAL_KEY` somewhere other than this server.** It decrypts every participant's
stored broker API secret and is deliberately in no database — that is exactly what makes a stolen
copy of the databases useless on its own. Losing it means everyone re-enters their keys, and
there is no recovery path.

---

## Seeding the shared market data

`market.db` and `template.db` are not in the repository — they carry real scan history and are
gitignored. Copy them from a working machine, then move them into the Docker volume. The volume
does not exist until the container has started once, so the order matters:

```bash
scp data/market.db data/template.db equistar-deploy@VM_IP:/tmp/
```

```bash
cd /opt/equistar
sudo docker compose up -d equistar
CID=$(sudo docker compose ps -q equistar)
sudo docker cp /tmp/market.db   $CID:/data/market.db
sudo docker cp /tmp/template.db $CID:/data/template.db
sudo docker exec -u root $CID chown -R node:node /data
sudo docker compose restart equistar
```

Compare `sha256sum` on both ends before trusting the copy.

---

## Gotcha 2 — the committed compose file publishes no ports

`docker-compose.yml` expects `cloudflared` to run as a container beside the app and reach it over
the compose network, so it uses `expose:` rather than `ports:`. Tailscale runs on the **host**, so
the hub has to be reachable from the host — but only from there.

`docker-compose.override.yml`, which is not in the repository:

```yaml
services:
  equistar:
    ports:
      - "127.0.0.1:5080:5080"
```

**`127.0.0.1:5080:5080`, never a bare `5080:5080`.** A bare mapping publishes the hub on the VM's
public interface and leaves GCP's firewall as the only thing between the app and the internet.
Verify after starting:

```bash
ss -ltn | grep 5080          # must show 127.0.0.1:5080, never 0.0.0.0:5080
```

The `cloudflared` service in the base file is simply never started, because
`docker compose up -d equistar` names the single service to bring up.

---

## Gotcha 3 — Funnel needs a click in the admin console

```bash
sudo tailscale up --authkey=tskey-auth-... --hostname=equistar
sudo tailscale funnel --bg 5080
```

The first `funnel` run fails with *"Funnel is not enabled on your tailnet"* and prints a
`login.tailscale.com/f/funnel?node=...` URL. Someone with tailnet admin rights has to open it and
enable Funnel; the command cannot do it for you. Re-run `tailscale funnel --bg 5080` afterwards.

Run it with `</dev/null` when driving it over a non-interactive SSH session, or it blocks waiting
on a terminal and the message is never printed.

`tailscale serve status` then shows the public hostname. **Revoke the auth key** once the VM has
joined — it is only needed for the initial join, and deleting it does not disconnect the machine.

`COOKIE_SECURE=true` in the compose file means the hub sets a `Secure` session cookie, which
browsers silently drop over plain HTTP. Sign-in therefore cannot work until Funnel is live, and
the failure presents as "sign in does nothing at all" rather than as an error. Enable Funnel
before testing login, or you will debug the wrong thing.

---

## Gotcha 4 — `createAdmin.js` needs a TTY

The script prompts through `readline`, so piping input to it over SSH prints the prompts and then
exits without creating anything. Call the accounts module directly instead:

```bash
CID=$(sudo docker compose ps -q equistar)
sudo docker exec $CID node -e '
const db=require("/app/hub/src/db"); const accounts=require("/app/hub/src/accounts");
db.open();
(async()=>{
  const out=[];
  out.push(await accounts.create({loginId:"admin", displayName:"Admin", role:"admin"}, "setup"));
  for (const [id,name] of [["rams","Rams"],["hema","Hema"]])
    out.push(await accounts.create({loginId:id, displayName:name}, "setup"));
  out.forEach(a=>console.log(a.role, a.loginId, "pw="+a.password));
  process.exit(0);
})();'
```

**The generated passwords are printed once and stored nowhere in readable form.** Copy them
before the terminal scrolls; the only remedy afterwards is a reset. An admin has no instance and
no database — admins manage people and do not trade — so create a separate ordinary account to
use the app yourself.

To put a group onto one joining password for a single announcement,
`hub/src/scripts/issuePassword.js` does that with the forced first-login change left on.

---

## Verifying

The sign-in page, a successful login, and a page of real data are three different things. Check
all three.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://YOUR-HOST.ts.net/hub/
```

Then sign in as a participant, confirm the Industry Scorecard returns its industries, and confirm
that `POST /api/recommendations/nifty500-scan` returns **403 `SCAN_NOT_OWNER`**. A participant
instance must never be able to run the scan: it attaches the shared `market.db`, so its writes
would delete and replace the scan data every other participant is reading.

---

## Afterwards

Each participant re-registers their broker redirect URL against the new host. The Brokers screen
shows each person their exact URL with a copy button, so it is a paste rather than a
construction:

```
https://YOUR-HOST.ts.net/u/<login>/api/kite/callback
https://YOUR-HOST.ts.net/u/<login>/api/breeze/callback
```

Then run the first scan from the admin page, so everyone starts on the same fresh data.

Worth saying to participants up front: **both broker connections are free.** ICICI Direct's Breeze
API costs nothing, and Zerodha's Kite Connect has a free "Personal" plan that covers holdings,
orders and trades — all EquiStar reads. Zerodha's paid plan (₹500/month) only adds live and
historical market data, which this app never asks Zerodha for. The old ₹2,000/month figure was
right until Zerodha changed its pricing in 2025, and repeating it kept people from connecting.

---

## Operating it

```bash
cd /opt/equistar
sudo docker compose logs -f equistar
sudo docker compose restart equistar
sudo docker compose ps
```

Deploying an update:

```bash
cd /opt/equistar && git pull && sudo docker compose build && sudo docker compose up -d equistar
```

Backing up the volume, which holds every participant's trading history:

```bash
sudo docker run --rm -v equistar_equistar-data:/data -v $PWD:/backup alpine \
  tar czf /backup/equistar-data-$(date +%F).tar.gz -C /data .
```

**The free trial ends after 90 days or $300 of credit, and the VM stops.** Everything lives in
that one volume, so moving to a paid box is the tar above plus a copy — but `CREDENTIAL_KEY` has
to move with it, or every stored broker credential is unreadable.
