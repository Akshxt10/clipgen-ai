#!/bin/bash
# ClipGen AI · Oracle "Cloud-init script" — PRIVATE TEMPLATE.
# Paste this whole text into Oracle's Create instance → Advanced options → Management → "Paste cloud-init script",
# then replace the two REPLACE_WITH_… values (and optionally the two optional ones) INSIDE the Oracle form.
# Never save the filled-in version in GitHub, notes shared with others, screenshots, or chats.
# This file is safe to keep public because it contains no secrets, only placeholders.
set -eu
umask 077

export DOMAIN="REPLACE_WITH_yourname.duckdns.org"
export ACCESS_TOKEN="REPLACE_WITH_YOUR_LONG_PASSWORD"
export ACME_EMAIL=""        # optional: your email, for Let's Encrypt expiry notices
export DUCKDNS_TOKEN=""     # optional: lets this VM keep your DuckDNS name up to date by itself

BOOTSTRAP_URL="https://raw.githubusercontent.com/Akshxt10/clipgen-ai/main/backend/deploy/oracle/bootstrap.sh"
BOOTSTRAP_SHA256="492291674d8b16d787941f09088174e8c4e951d6fd88eddd369279e6983bc287"

dir=/root/clipgen-setup
mkdir -p "$dir"
curl -fsSL --retry 5 --retry-delay 5 "$BOOTSTRAP_URL" -o "$dir/bootstrap.sh"
if ! echo "$BOOTSTRAP_SHA256  $dir/bootstrap.sh" | sha256sum -c - >/dev/null 2>&1; then
  echo "ClipGen: the downloaded setup script does not match the expected checksum; refusing to run it." >&2
  exit 1
fi
# everything the setup prints goes to /var/log/clipgen-setup.log (root-only); it never prints secrets
bash "$dir/bootstrap.sh" >/dev/null 2>&1 || echo "ClipGen setup failed: read /var/log/clipgen-setup.log" >&2
