#!/usr/bin/env bash
# ClipGen AI · Oracle Cloud bootstrap (Always Free Ampere A1 VM, Ubuntu 22.04/24.04, arm64)
#
# Installs Docker, builds the ClipGen backend image on this VM, and runs it behind Caddy (automatic HTTPS).
# It is normally started once by backend/deploy/oracle/user-data.template.sh (Oracle "cloud-init script"), and can be
# re-run safely at any time:   sudo clipgen-setup            (re-applies everything, keeps your secrets and data)
#                              sudo clipgen-setup status     (read-only health/exposure report)
#
# What it never does: call any Oracle API, create or resize any cloud resource, install the OCI CLI, or upgrade
# the account. It only configures this one machine. It refuses to run on a machine that is larger than the
# documented Always Free allowance (see check_hardware), unless you explicitly override that.
#
# Secrets: ACCESS_TOKEN / DUCKDNS_TOKEN arrive as environment variables, are stored only in root-only files
# (/etc/clipgen, mode 600) and are never printed, logged, or passed on a command line.
#
# Inputs (environment):
#   DOMAIN          required first time   e.g. aksh-clipgen.duckdns.org (must already point to this VM's public IP)
#   ACCESS_TOKEN    required first time   20–128 chars of A-Z a-z 0-9 . _ ~ -  (the password you type into the app)
#   ACME_EMAIL      optional              email for Let's Encrypt expiry notices
#   DUCKDNS_TOKEN   optional              only if you want this VM to keep the DuckDNS name updated itself
#   ALLOWED_ORIGINS optional              default https://akshxt10.github.io  (your GitHub Pages app); the VM's own
#                                         https://DOMAIN is always added
#   WHISPER_MODEL   optional              tiny | base (default) | small   (+ .en variants)
#   MAX_DURATION_MIN optional             default 45
#   REPO_REF        optional              git branch or tag to build, default main
#   ALLOW_NON_FREE_SHAPE=1                override the free-tier guard (you accept that this may cost money)
# Test hooks: CLIPGEN_DRYRUN=1 (validate + render config only), CLIPGEN_ROOT=<dir> (write under that prefix),
#             HW_ARCH, HW_CPUS, HW_MEM_MB, HW_DISK_GB, HW_SHAPE (pretend hardware).
set -Eeuo pipefail
umask 077

ROOT="${CLIPGEN_ROOT:-}"
DRYRUN="${CLIPGEN_DRYRUN:-0}"
ETC="$ROOT/etc/clipgen"
OPT="$ROOT/opt/clipgen"
SYSTEMD="$ROOT/etc/systemd/system"
SBIN="$ROOT/usr/local/sbin"
LOG="$ROOT/var/log/clipgen-setup.log"
CONF="$ETC/config.env"          # non-secret settings
APPENV="$ETC/app.env"           # secret: ACCESS_TOKEN, SIGNING_SECRET (+ settings), docker --env-file
DDNSENV="$ETC/duckdns.env"      # secret: DuckDNS token
REPO_URL="https://github.com/Akshxt10/clipgen-ai.git"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
APP_IMAGE="clipgen-backend:local"
NET="clipgen"
LOGOPTS=(--log-driver json-file --log-opt max-size=10m --log-opt max-file=3)

mkdir -p "$(dirname "$LOG")" "$ETC" "$OPT"
touch "$LOG"; chmod 600 "$LOG"
exec > >(tee -a "$LOG") 2>&1

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
trap 'printf "\nSetup stopped at line %s (see %s). Nothing secret was printed.\n" "$LINENO" "$LOG" >&2' ERR

file_get() { [ -f "$1" ] || return 0; sed -n "s/^$2=//p" "$1" | head -n1; }

# ------------------------------------------------------------------ status (read-only)
if [ "${1:-}" = "status" ]; then
  echo "== containers =="; docker ps -a --filter name=clipgen --format '{{.Names}}  {{.Status}}  ports: {{.Ports}}' || true
  echo "== is the backend port reachable from outside? (must show nothing for 7860) =="; ss -ltn 2>/dev/null | grep -E ':7860\b' || echo "7860 is not listening on the host: good"
  echo "== disk =="; df -h / | tail -1
  echo "== settings (no secrets) =="; cat "$CONF" 2>/dev/null || echo "(no saved settings)"
  exit 0
fi

# ------------------------------------------------------------------ inputs
SAVED_DOMAIN="$(file_get "$CONF" DOMAIN)"
DOMAIN="${DOMAIN:-$SAVED_DOMAIN}"
ACME_EMAIL="${ACME_EMAIL:-$(file_get "$CONF" ACME_EMAIL)}"
ORIGINS_IN="${ALLOWED_ORIGINS:-$(file_get "$CONF" ALLOWED_ORIGINS)}"
WHISPER_MODEL="${WHISPER_MODEL:-$(file_get "$CONF" WHISPER_MODEL)}"; WHISPER_MODEL="${WHISPER_MODEL:-base}"
MAX_DURATION_MIN="${MAX_DURATION_MIN:-$(file_get "$CONF" MAX_DURATION_MIN)}"; MAX_DURATION_MIN="${MAX_DURATION_MIN:-45}"
REPO_REF="${REPO_REF:-$(file_get "$CONF" REPO_REF)}"; REPO_REF="${REPO_REF:-main}"
ACCESS_TOKEN="${ACCESS_TOKEN:-$(file_get "$APPENV" ACCESS_TOKEN)}"
DUCKDNS_TOKEN="${DUCKDNS_TOKEN:-$(file_get "$DDNSENV" DUCKDNS_TOKEN)}"
ORIGINS_IN="${ORIGINS_IN:-https://akshxt10.github.io}"

validate_inputs() {
  local bad=()
  DOMAIN="$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z')"
  [[ -n "$DOMAIN" ]] || bad+=("DOMAIN is missing (for example aksh-clipgen.duckdns.org).")
  if [[ -n "$DOMAIN" ]]; then
    [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || bad+=("DOMAIN is not a valid host name.")
    [[ "$DOMAIN" =~ ^[0-9.]+$ ]] && bad+=("DOMAIN must be a name, not an IP address.")
  fi
  [[ -n "$ACCESS_TOKEN" ]] || bad+=("ACCESS_TOKEN is missing.")
  if [[ -n "$ACCESS_TOKEN" && ! "$ACCESS_TOKEN" =~ ^[A-Za-z0-9._~-]{20,128}$ ]]; then
    bad+=("ACCESS_TOKEN must be 20–128 characters using only letters, digits and . _ ~ - (it is not shown here).")
  fi
  if [[ -n "$ACME_EMAIL" && ! "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then bad+=("ACME_EMAIL does not look like an email address."); fi
  if [[ -n "$DUCKDNS_TOKEN" ]]; then
    [[ "$DUCKDNS_TOKEN" =~ ^[0-9a-fA-F-]{20,64}$ ]] || bad+=("DUCKDNS_TOKEN does not look like a DuckDNS token (it is not shown here).")
    [[ "$DOMAIN" =~ ^[a-z0-9-]+\.duckdns\.org$ ]] || bad+=("DUCKDNS_TOKEN only makes sense with a name ending in .duckdns.org.")
  fi
  [[ "$ORIGINS_IN" =~ ^[A-Za-z0-9:/.,*-]+$ ]] || bad+=("ALLOWED_ORIGINS contains unexpected characters.")
  [[ "$WHISPER_MODEL" =~ ^(tiny|base|small)(\.en)?$ ]] || bad+=("WHISPER_MODEL must be tiny, base or small (optionally with .en).")
  [[ "$MAX_DURATION_MIN" =~ ^[0-9]{1,3}$ ]] || bad+=("MAX_DURATION_MIN must be a number of minutes.")
  [[ "$REPO_REF" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || bad+=("REPO_REF contains unexpected characters.")
  if ((${#bad[@]})); then
    printf '\nProblems with the settings:\n' >&2; printf '  - %s\n' "${bad[@]}" >&2; exit 2
  fi
}

# ------------------------------------------------------------------ free-tier guard
oracle_meta() { curl -fsS -m 3 -H 'Authorization: Bearer Oracle' "http://169.254.169.254/opc/v2/$1" 2>/dev/null || true; }
check_hardware() {
  local arch cpus mem disk shape
  arch="${HW_ARCH:-$(uname -m)}"
  cpus="${HW_CPUS:-$(nproc)}"
  mem="${HW_MEM_MB:-$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)}"
  disk="${HW_DISK_GB:-$(df -BG --output=size / | tail -1 | tr -dc 0-9)}"
  shape="${HW_SHAPE:-$(oracle_meta instance/shape)}"
  log "machine: shape=${shape:-unknown} arch=$arch cpus=$cpus memory=${mem}MB root-disk=${disk}GB"
  local why=()
  [[ "$shape" == "VM.Standard.A1.Flex" ]] || why+=("this is not an Ampere A1 Flex machine (detected: ${shape:-not an Oracle Cloud VM}). Only that shape can hold the 2 CPU / 12 GB speech-recognition workload inside Oracle's Always Free allowance.")
  [[ "$arch" == "aarch64" || "$arch" == "arm64" ]] || why+=("CPU architecture is $arch, expected aarch64.")
  (( cpus <= 2 )) || why+=("$cpus CPUs is more than the documented Always Free allowance (2 OCPUs in total). Extra capacity can be billed.")
  (( mem <= 12800 )) || why+=("${mem} MB RAM is more than the documented Always Free allowance (12 GB in total). Extra capacity can be billed.")
  (( mem >= 4000 )) || why+=("only ${mem} MB RAM: the speech model needs about 4 GB or more to run reliably.")
  (( disk <= 200 )) || why+=("a ${disk} GB boot disk is more than the 200 GB Always Free storage allowance.")
  if ((${#why[@]})); then
    if [[ "${ALLOW_NON_FREE_SHAPE:-0}" == "1" ]]; then
      log "WARNING: free-tier guard overridden (ALLOW_NON_FREE_SHAPE=1). This machine may not be free:"
      printf '   - %s\n' "${why[@]}"
    else
      printf '\nStopped by the free-tier safety guard (nothing was installed):\n' >&2
      printf '  - %s\n' "${why[@]}" >&2
      printf '\nCreate the VM again as: shape VM.Standard.A1.Flex, 2 OCPU, 12 GB memory, boot volume 200 GB or less.\nTo run anyway at your own cost risk, set ALLOW_NON_FREE_SHAPE=1.\n' >&2
      exit 3
    fi
  fi
  HW_DISK_GB_EFFECTIVE="$disk"
}

# ------------------------------------------------------------------ files
write_file() { # write_file <path> <mode>  (content on stdin) — atomic, idempotent
  local dest="$1" mode="$2" tmp; tmp="$(mktemp "$dest.XXXXXX")"; cat >"$tmp"; chmod "$mode" "$tmp"; mv -f "$tmp" "$dest"
}

render_config() {
  local signing disk_mb origins
  signing="$(file_get "$APPENV" SIGNING_SECRET)"
  [[ "$signing" =~ ^[0-9a-f]{64}$ ]] || signing="$(openssl rand -hex 32)"
  disk_mb=$(( HW_DISK_GB_EFFECTIVE * 1024 * 45 / 100 )); (( disk_mb > 60000 )) && disk_mb=60000; (( disk_mb < 2048 )) && disk_mb=2048
  origins="$ORIGINS_IN"; [[ ",$origins," == *",https://$DOMAIN,"* ]] || origins="$origins,https://$DOMAIN"

  write_file "$CONF" 600 <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
ALLOWED_ORIGINS=$ORIGINS_IN
WHISPER_MODEL=$WHISPER_MODEL
MAX_DURATION_MIN=$MAX_DURATION_MIN
REPO_REF=$REPO_REF
EOF

  write_file "$APPENV" 600 <<EOF
PORT=7860
ACCESS_TOKEN=$ACCESS_TOKEN
SIGNING_SECRET=$signing
ALLOWED_ORIGINS=$origins
TRUST_PROXY=1
MAX_DURATION_MIN=$MAX_DURATION_MIN
MAX_SOURCE_MB=1024
MAX_DISK_MB=$disk_mb
RETENTION_HOURS=12
MAX_CONCURRENT_JOBS=1
EOF

  if [[ -n "$DUCKDNS_TOKEN" ]]; then
    write_file "$DDNSENV" 600 <<EOF
DUCKDNS_DOMAIN=${DOMAIN%.duckdns.org}
DUCKDNS_TOKEN=$DUCKDNS_TOKEN
EOF
  fi

  # Caddy: HTTPS certificates are obtained and renewed automatically. Only Caddy faces the internet.
  # No access log is configured on purpose (signed download links carry a signature in the URL).
  write_file "$ETC/Caddyfile" 600 <<EOF
{
	admin off
$( [[ -n "$ACME_EMAIL" ]] && printf '\temail %s\n' "$ACME_EMAIL" )
}

$DOMAIN {
	request_body {
		max_size 24MB
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		-Server
	}
	reverse_proxy clipgen-app:7860
}
EOF
}

# ------------------------------------------------------------------ system pieces (not run in dry-run mode)
install_packages() {
  log "installing Docker and tools (this can take a few minutes)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends docker.io git curl ca-certificates openssl iptables
  apt-get install -y --no-install-recommends docker-buildx >/dev/null 2>&1 || true
  systemctl enable --now docker
}

install_helpers() {
  # firewall rules, re-applied at every boot after Docker is up
  cat >"$OPT/firewall.sh" <<'EOF'
#!/bin/sh
# ClipGen AI host firewall additions (idempotent). Oracle's own network rules (security list) are a separate layer.
set -eu
# web traffic reaches Caddy only; there is deliberately NO rule for the backend port 7860
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
# containers must never reach Oracle's instance-metadata service (it can hand out this VM's settings)
for i in 1 2 3 4 5 6 7 8 9 10; do iptables -L DOCKER-USER -n >/dev/null 2>&1 && break; sleep 2; done
iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER 1 -d 169.254.169.254 -j DROP
EOF
  chmod 700 "$OPT/firewall.sh"
  mkdir -p "$SYSTEMD" "$SBIN"
  cat >"$SYSTEMD/clipgen-firewall.service" <<EOF
[Unit]
Description=ClipGen AI firewall additions
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$OPT/firewall.sh
[Install]
WantedBy=multi-user.target
EOF

  if [[ -n "$DUCKDNS_TOKEN" ]]; then
    cat >"$SBIN/clipgen-duckdns" <<'EOF'
#!/bin/sh
# Keeps the DuckDNS name pointing at this VM. The token is read from a root-only file and handed to curl on
# stdin, so it never appears in the process list or in any log.
set -eu
. /etc/clipgen/duckdns.env
printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip="\n' "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN" \
  | curl -fsS -m 20 -K - -o /dev/null -w 'duckdns update: http %{http_code}\n' || echo "duckdns update failed"
EOF
    chmod 700 "$SBIN/clipgen-duckdns"
    cat >"$SYSTEMD/clipgen-duckdns.service" <<'EOF'
[Unit]
Description=ClipGen AI DuckDNS updater
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/clipgen-duckdns
EOF
    cat >"$SYSTEMD/clipgen-duckdns.timer" <<'EOF'
[Unit]
Description=ClipGen AI DuckDNS updater (every 10 minutes)
[Timer]
OnBootSec=1min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOF
  fi
  # a copy of this script so it can be re-run:  sudo clipgen-setup
  if [[ -r "${BASH_SOURCE[0]}" && "$(readlink -f "${BASH_SOURCE[0]}")" != "$(readlink -f "$SBIN/clipgen-setup" 2>/dev/null || true)" ]]; then
    install -m 700 "${BASH_SOURCE[0]}" "$SBIN/clipgen-setup"
  fi
  systemctl daemon-reload
  systemctl enable clipgen-firewall.service >/dev/null
  systemctl restart clipgen-firewall.service
  if [[ -n "$DUCKDNS_TOKEN" ]]; then systemctl enable --now clipgen-duckdns.timer >/dev/null; systemctl start clipgen-duckdns.service || true; fi
}

build_image() {
  log "fetching the source code ($REPO_REF)"
  if [[ -d "$OPT/src/.git" ]]; then
    git -C "$OPT/src" fetch --depth 1 origin "$REPO_REF"
    git -C "$OPT/src" checkout -q --force FETCH_HEAD
  else
    rm -rf "$OPT/src"; git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$OPT/src"
  fi
  log "building the backend image (first time: about 15–40 minutes while whisper.cpp compiles; later runs reuse the cache)"
  if docker buildx version >/dev/null 2>&1; then export DOCKER_BUILDKIT=1; fi
  ( cd "$OPT/src" && docker build -f backend/Dockerfile --build-arg SOURCE=local --build-arg "WHISPER_MODEL=$WHISPER_MODEL" -t "$APP_IMAGE" . )
}

run_containers() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  docker volume inspect clipgen-data >/dev/null 2>&1 || docker volume create clipgen-data >/dev/null
  log "starting the backend (no published ports: only reachable by Caddy over the private Docker network)"
  docker rm -f clipgen-app >/dev/null 2>&1 || true
  docker run -d --name clipgen-app --restart unless-stopped --network "$NET" \
    --env-file "$APPENV" \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 1024 --memory 9g --memory-swap 9g --cpus 2 \
    "${LOGOPTS[@]}" -v clipgen-data:/data "$APP_IMAGE" >/dev/null
  log "starting Caddy (the only container with published ports: 80 and 443)"
  docker pull "$CADDY_IMAGE" >/dev/null
  docker rm -f clipgen-caddy >/dev/null 2>&1 || true
  docker run -d --name clipgen-caddy --restart unless-stopped --network "$NET" \
    -p 80:80 -p 443:443 \
    --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges --pids-limit 256 \
    "${LOGOPTS[@]}" \
    -v "$ETC/Caddyfile:/etc/caddy/Caddyfile:ro" -v clipgen-caddy-data:/data -v clipgen-caddy-config:/config \
    "$CADDY_IMAGE" >/dev/null
}

self_check() {
  log "checking the backend"
  local ok=0
  for i in $(seq 1 30); do
    if docker exec clipgen-app node -e "fetch('http://127.0.0.1:7860/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
    sleep 4
  done
  [[ $ok == 1 ]] && log "backend is running" || log "WARNING: backend did not answer yet; look at:  docker logs clipgen-app"
  if ss -ltn 2>/dev/null | grep -qE ':7860\b'; then log "WARNING: port 7860 is listening on the host. It must not be."; else log "port 7860 is not exposed on the host: good"; fi
  if [[ -n "$(docker port clipgen-app 2>/dev/null)" ]]; then log "WARNING: backend container has published ports"; fi
  log "checking HTTPS for $DOMAIN (needs the DNS name to point here and Oracle ports 80/443 open; Caddy keeps retrying by itself)"
  for i in $(seq 1 8); do
    if curl -fsS -m 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then log "HTTPS works: https://$DOMAIN"; return 0; fi
    sleep 15
  done
  log "HTTPS is not answering yet. That is normal until DNS and the Oracle network rule are set. Check later with:  sudo clipgen-setup status"
}

# ------------------------------------------------------------------ main
log "ClipGen AI setup starting (dry-run=$DRYRUN)"
validate_inputs
check_hardware
render_config
if [[ "$DRYRUN" == "1" ]]; then log "dry run finished: settings are valid and files were written under ${ROOT:-/}etc/clipgen"; exit 0; fi
[[ $EUID -eq 0 ]] || die "run as root (sudo)."
install_packages
install_helpers
build_image
run_containers
self_check
log "done. Open https://$DOMAIN , go to Settings → Backend, enter your access token and tap Connect."
