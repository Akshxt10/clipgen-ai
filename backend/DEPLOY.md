# Deploying the ClipGen AI backend

GitHub Pages can only host the web app (screens and buttons). Cutting video needs a real server with FFmpeg and a
speech model, so the backend in this folder runs separately, in Docker.

**Status: nothing here has been deployed or run on Oracle yet.** The setup script is tested in a "dry-run" mode
(validation, free-tier guard, generated files, re-run safety), but the Docker image has never been built and the
script has never run on a real Oracle VM, because the development sandbox has no Docker and no Oracle account.
Expect to fix small things on the first real run, and send me the log (`/var/log/clipgen-setup.log`, it never contains secrets).

## Which host? (checked November 2026)

| Host | Free? | Verdict |
|---|---|---|
| **Oracle Cloud "Always Free" Ampere A1 VM** | Yes, within the allowance: **2 OCPUs, 12 GB RAM**, 200 GB storage, 10 TB/month outbound, no sleeping | **Recommended.** The only free option found that can run the speech model properly. Needs a card for sign-up verification (normally not charged). |
| Hugging Face Space (Docker) | **No.** Docker Spaces now need a paid plan to create (only static Spaces are free) | Not usable for free. |
| Render free web service | Yes, but about 512 MB RAM, under one CPU, sleeps after 15 idle minutes, wiped on restart | Too small for the `base` speech model. Last resort with `tiny` and short videos; not covered here. |
| Google Cloud Run, Fly.io, Koyeb | Need a billing account or have unclear/limited free tiers | Not recommended. |

Everything below is for Oracle.

## What the setup does

One Ubuntu VM runs two containers on a private Docker network:

```
 phone / browser ──HTTPS 443──► Caddy (certificates, only thing with open ports) ──private──► ClipGen backend :7860
                                                                                              (FFmpeg, whisper.cpp)
```

- **Port 7860 is never published.** Only Caddy has ports (80 and 443). The setup checks this at the end.
- Automatic HTTPS from Let's Encrypt (needed because the app on GitHub Pages is HTTPS and browsers block plain HTTP backends).
- Both containers restart automatically after a reboot or crash and keep their logs small (10 MB × 3 files each).
- Containers get no extra Linux privileges, and cannot reach Oracle's instance-metadata address.
- The backend can use at most 9 GB of the 12 GB and 2 CPUs, so the VM itself stays responsive.
- `ACCESS_TOKEN` (a password the app asks for) is required; `SIGNING_SECRET` is generated on the VM. Both live only in
  root-only files under `/etc/clipgen` and never appear in logs, the command line or GitHub.
- `ALLOWED_ORIGINS` is `https://akshxt10.github.io` (your GitHub Pages app) plus your own domain.

## Protect yourself from accidental charges

The script cannot make Oracle charge you, but **you** can by creating the wrong thing. Do all of these:

1. When creating the VM choose exactly: shape **VM.Standard.A1.Flex**, **2 OCPUs**, **12 GB** memory, boot volume **100 GB** (anything up to 200 GB). Look for the "Always Free-eligible" label in the console.
2. **Never tap "Upgrade" / "Pay As You Go".** Stay on the free account. (The setup script does not and cannot upgrade anything.)
3. Create a budget alert first: Billing & Cost Management → Budgets → create a budget of 1 USD (or the lowest allowed) with an alert at 1 %, sent to your email. This warns you if anything starts costing money.
4. Do not create other resources: no load balancer, NAT gateway, extra block volumes, extra VMs, or reserved IPs you do not use.
5. The setup refuses to run on a machine that is larger than the allowance (more than 2 CPUs, more than 12 GB RAM, boot disk over 200 GB, or not an A1 machine). It prints why and installs nothing. To override at your own risk: `ALLOW_NON_FREE_SHAPE=1`.
6. Oracle may reclaim a VM that stays almost idle for 7 days. If that happens you lose the VM (not money). Check it once a week or recreate it; the setup is repeatable.

## Step by step on an iPhone

Do these in Safari. Oracle's website is built for computers, so use "Request Desktop Website" (aA menu) if a page looks cut off.
Button names below may differ slightly from what Oracle shows today.

### A. Prepare (Notes app)

1. Pick a **name**: you will get `yourname.duckdns.org`. Letters, digits and hyphens only.
2. Create your **access token**: Settings → Passwords → + → "Suggest strong password", or type 25+ random characters using only letters, digits and `. _ ~ -`. This is the password the app will ask for. Write it in a private note. Do not paste it into chats, GitHub, or screenshots.

### B. DuckDNS (free name)

1. Open duckdns.org and sign in (GitHub/Google/etc.).
2. Add the subdomain `yourname`. Keep the page open; you will set its IP in step F.
3. Optional: copy your DuckDNS **token** (a long code on that page). Only paste it into the Oracle form if you want the VM to keep the name updated itself. Never put it in a public place.

### C. Oracle account

1. Go to oracle.com/cloud/free and sign up. Choose your **home region** carefully: it cannot be changed, and free Arm capacity varies by region.
2. Complete the card verification (a temporary hold is normal). Some Indian cards need "international transactions" enabled.
3. Do **not** upgrade the account.
4. Do step "Protect yourself" 3 (budget alert) now.

### D. Open the web ports (Oracle network rule)

1. Menu → Networking → Virtual cloud networks → your VCN → Security → the default security list → **Add ingress rules**.
2. Add two rules: Source CIDR `0.0.0.0/0`, protocol TCP, destination port `80`; and another with port `443`.
3. Do **not** add port 7860.

### E. Create the VM

1. Menu → Compute → Instances → **Create instance**.
2. Name: `clipgen`. Image: **Canonical Ubuntu 24.04** (Arm / aarch64). Shape: **Ampere → VM.Standard.A1.Flex**, **2 OCPU, 12 GB**.
3. Networking: public IPv4 address **assigned**.
4. SSH keys: let Oracle **generate a key pair** and download the private key to Files. (You only need it later for updates.)
5. Boot volume: **100 GB**.
6. Advanced options → Management → **Paste cloud-init script**: open `backend/deploy/oracle/user-data.template.sh` on GitHub, copy all of it, paste it, then edit **inside the Oracle box**:
   - `DOMAIN="yourname.duckdns.org"`
   - `ACCESS_TOKEN="<your token from the note>"`
   - optional `ACME_EMAIL="you@example.com"` and `DUCKDNS_TOKEN="<token>"`
7. Create. If you see **"Out of host capacity"**, try another availability domain or try again later.

The pasted text with your token stays in your Oracle account (and root-only on the VM); never paste it anywhere else.

### F. Point the name at the VM

1. When the instance shows **Running**, copy its **public IP address**.
2. On duckdns.org put that IP next to `yourname` and tap **update ip**.
3. The setup builds the image now (10–40 minutes on the first run: it compiles the speech engine). Caddy gets the HTTPS certificate once DNS is correct and the ports are open.

### G. Check and connect

1. Open `https://yourname.duckdns.org/api/health`. It should show `ok`. If not, wait a few minutes and retry.
2. Open `https://yourname.duckdns.org` — the app itself is served from there too.
3. Settings → Backend: the address is filled in or paste it; enter the **access token**; tap **Connect**. It should report speech recognition `whisper.cpp · model.bin` and FFmpeg.
4. Test with a short (2–3 minute) video you own. Note how long analysis and one render take, and tell me, so I can set realistic limits. Speed on 2 Arm cores has not been measured yet.

To use the GitHub Pages copy instead, set the same address and token in its Settings (or set `DEFAULT_API_BASE` in `phase2/config.js` to your `https://yourname.duckdns.org`; never put the token there).

## Later: update, change the token, look at status (needs SSH from the iPhone)

Install an SSH app (for example Termius or Blink), import the private key you saved, connect to `ubuntu@<public IP>`. Then:

```
sudo clipgen-setup status                      # read-only: containers, port exposure, disk (no secrets)
sudo clipgen-setup                             # re-applies everything and rebuilds from the latest code (keeps data and secrets)
sudo ACCESS_TOKEN='new-long-token' clipgen-setup   # change the token (the signing secret is kept); afterwards run: history -c
docker logs --tail 100 clipgen-app             # backend log
```

Re-running restarts the backend, which interrupts any job in progress. Do it when idle. Projects are deleted automatically after 12 hours.

## What the setup script protects against, and what it does not

- ✅ Secrets only in root-only files; not in logs, process list, GitHub, or the command line.
- ✅ Backend not reachable except through Caddy; metadata address blocked from containers; no extra Linux privileges.
- ✅ Refuses oversized (potentially billable) machines; never calls Oracle APIs; never upgrades.
- ✅ Safe to re-run; the cloud-init wrapper only runs a setup script whose SHA-256 matches the one pinned in the wrapper.
- ⚠️ Oracle's console shows/stores the pasted cloud-init text in your tenancy. Treat your Oracle login like the token.
- ⚠️ Free-tier hardware is slow, and speed has not been measured.
- ⚠️ If you change `bootstrap.sh`, update the checksum line in `user-data.template.sh` (the test `deploy.test.js` tells you the new value).
- ⚠️ IPv6 is not configured. Updates to Ubuntu happen through its default automatic security updates.

## Environment variables (set automatically by the script; change with `sudo ... clipgen-setup`)

| Variable | Set to | Meaning |
|---|---|---|
| `ACCESS_TOKEN` | from you | every API call needs `Authorization: Bearer …` |
| `SIGNING_SECRET` | generated | HMAC key for preview/download links |
| `ALLOWED_ORIGINS` | `https://akshxt10.github.io,https://yourname.duckdns.org` | allowed web origins (CORS) |
| `TRUST_PROXY` | `1` | rate limiting uses the address Caddy forwards |
| `MAX_DURATION_MIN` | 45 | longest video accepted |
| `MAX_SOURCE_MB` | 1024 | largest upload |
| `MAX_DISK_MB` | 45 % of the boot disk (max 60000) | storage quota |
| `RETENTION_HOURS` | 12 | projects are deleted after this |
| `MAX_CONCURRENT_JOBS` | 1 | one analysis/render at a time |

Optional extras you can add by hand later (in `/etc/clipgen/app.env`, then re-run): `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL`
(any OpenAI-compatible endpoint for clip re-ranking), `WHISPER_THREADS`, `FFMPEG_THREADS`, `FACE_DETECT=off`.
Speech model size: `WHISPER_MODEL=tiny|base|small` (default `base`; `small` is better but slower).

## Build notes

- The image is built **on the VM** from the repository (`docker build -f backend/Dockerfile --build-arg SOURCE=local .`).
- whisper.cpp is built with `-DGGML_NATIVE=OFF` (a generic Arm build) so it cannot crash with "illegal instruction" on a different CPU.
  Because the image is built on the same machine that runs it, you can try `--build-arg WHISPER_NATIVE=ON` for a possibly faster build;
  I have not measured the difference.
- The first build downloads the speech model from the whisper.cpp project; later builds reuse Docker's cache.
