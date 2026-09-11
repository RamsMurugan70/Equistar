# Runbook — deploying EquiStar to the GCP VM by hand

For shipping an update without help. `DEPLOY-gcp.md` is how the box was built; this is how to
change what runs on it. The repository is public, so the live values (IP, project, hostname) are
placeholders here; the filled-in copy is `RUNBOOK-gcp.local.md`, which is gitignored and exists
only on the owner's machine.

| Placeholder | Where to find the real value |
|---|---|
| `VM_IP` | Compute Engine → VM instances → `equistar` → External IP |
| `YOUR-HOST.ts.net` | `tailscale funnel status` on the VM, or the Tailscale admin console |
| `PROJECT` / zone | Top bar of the GCP console; the VM's row shows its zone |

---

## What exists, and all of it

One Compute Engine VM — nothing else in GCP: no load balancer, no firewall rule, no Cloud SQL,
no domain, no DNS.

| Thing | Where |
|---|---|
| Code | `/opt/equistar` on the VM — a git clone of this repository |
| Secrets | `/opt/equistar/.env` — `SESSION_SECRET`, `CREDENTIAL_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` (Ask the Data). Not in git. After editing `.env`, run `sudo docker compose up -d equistar` — a plain `restart` does not reload it |
| Port binding | `/opt/equistar/docker-compose.override.yml` — `127.0.0.1:5080:5080`. Not in git |
| Data | Docker volume `equistar_equistar-data`: `hub.db`, `market.db`, `template.db`, `users/<id>/app.db` |
| Backups | `/opt/equistar/*.tar.gz` |
| Public HTTPS | Tailscale Funnel on the VM host (not in Docker) → `127.0.0.1:5080` |
| SSH | user `equistar-deploy`, key `~/.ssh/id_ed25519` on the owner's PC |

The volume survives `git pull`, `docker compose build`, `up -d`, `restart` and reboots. Only
`docker compose down -v` deletes it — never type that.

---

## Deploy an update

On the PC, in the repository folder, with the change committed:

```bash
git push origin master
```

On the VM:

```bash
ssh equistar-deploy@VM_IP
cd /opt/equistar

# 1. Back up the data first. Always.
sudo docker run --rm -v equistar_equistar-data:/data -v $PWD:/backup alpine \
  tar czf /backup/equistar-data-$(date +%F-%H%M).tar.gz -C /data .

# 2. Pull, build, restart. A few minutes; participants see a short outage at the restart.
git pull && sudo docker compose build && sudo docker compose up -d equistar
```

## Check it

```bash
sudo docker compose ps                  # STATUS must say (healthy)
ss -ltn | grep 5080                     # must be 127.0.0.1:5080 — never 0.0.0.0:5080
curl -s -o /dev/null -w "%{http_code}\n" https://YOUR-HOST.ts.net/hub/    # 200
sudo docker compose logs --tail 50 equistar
```

A 200 only proves the sign-in page loads. Sign in and open a page with real data (Portfolio,
Performance) before calling it done.

---

## Roll back

**Code** — the common case. Data is untouched:

```bash
git log --oneline -5                    # pick the last good commit
git checkout <good-commit>
sudo docker compose build && sudo docker compose up -d equistar
```

Run `git checkout master` before the next normal deploy, or `git pull` will refuse.

**Data** — last resort. This REPLACES everything participants have saved since the backup:

```bash
sudo docker compose stop equistar
sudo docker run --rm -v equistar_equistar-data:/data -v $PWD:/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/FILE.tar.gz -C /data"
sudo docker compose start equistar
```

---

## When something else breaks

| Symptom | Fix |
|---|---|
| SSH refused / times out | GCP console → VM instances → `equistar` → **SSH** (browser terminal) |
| VM stopped | GCP console → start it. The external IP may change unless reserved as static (VPC network → IP addresses); the Tailscale URL does not change |
| Public URL dead, container healthy | On the VM: `sudo tailscale status`, then `sudo tailscale funnel --bg 5080 </dev/null` |
| Sign-in does nothing | The session cookie is `Secure`; it only works over the https Funnel URL, never `http://VM_IP` |
| Disk full | `df -h /`; delete old `*.tar.gz` backups (keep the newest two) and `sudo docker image prune` |

---

## Keep these safe, off the VM

- **`CREDENTIAL_KEY`** from `/opt/equistar/.env`. It decrypts every participant's stored broker
  keys and exists nowhere else. Lose the VM without a copy and everyone re-enters their keys.
  Store it in a password manager.
- **A recent backup tar**, copied down with `scp` now and then. It holds every participant's
  trading history — keep it private.
- **GCP billing.** The free trial stops the VM after 90 days or $300 of credit. Upgrade the billing
  account before then; nothing needs redeploying afterwards.
