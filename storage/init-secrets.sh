#!/bin/sh
# First-run secrets for bundled storage. Runs before Garage on every `up`; only ever
# creates what's missing, so existing secrets (and the data they unlock) are kept.
set -eu
umask 077
cd /run/garage

secret() {
  [ -s "$1" ] && return 0
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$1.tmp"
  mv "$1.tmp" "$1"
  echo "created $1"
}

secret rpc_secret
secret admin_token

# Garage (root) reads both; jvinu (uid 1000, the node user) reads only the admin token.
chmod 600 rpc_secret admin_token
chown 1000:1000 admin_token
