#!/bin/sh
set -e

echo "[entrypoint] starting monero_wallet" >&2

WALLET_FILE="${MONERO_WALLET_FILE:-/wallet/main.wallet}"
LANG_CHOICE="${MONERO_WALLET_SEED_LANG:-English}"
MONERO_NETWORK="${MONERO_NETWORK:-mainnet}"
MONEROD_HOST="${MONEROD_HOST:-monerod}"

# Determine ports and flags based on network env
NET_FLAG=""
if [ "$MONERO_NETWORK" = "testnet" ]; then
  NET_FLAG="--testnet"
  MONEROD_RPC_PORT="${MONEROD_RPC_PORT:-28081}"
  WALLET_RPC_PORT="${WALLET_RPC_PORT:-28083}"
elif [ "$MONERO_NETWORK" = "stagenet" ]; then
  NET_FLAG="--stagenet"
  MONEROD_RPC_PORT="${MONEROD_RPC_PORT:-38081}"
  WALLET_RPC_PORT="${WALLET_RPC_PORT:-38083}"
else
  # mainnet
  MONEROD_RPC_PORT="${MONEROD_RPC_PORT:-18081}"
  WALLET_RPC_PORT="${WALLET_RPC_PORT:-18083}"
fi

if [ -z "${MONERO_WALLET_PASSWORD:-}" ]; then
  echo "[entrypoint] ERROR: MONERO_WALLET_PASSWORD is required" >&2
  exit 1
fi

WALLET_DIR="$(dirname "$WALLET_FILE")"
mkdir -p "$WALLET_DIR"

# Generate wallet if it doesn't exist
if [ ! -f "$WALLET_FILE" ]; then
  echo "[entrypoint] wallet not found, creating: $WALLET_FILE" >&2
  /opt/monero/monero-wallet-cli \
    $NET_FLAG \
    --offline \
    --generate-new-wallet="$WALLET_FILE" \
    --password="$MONERO_WALLET_PASSWORD" \
    --mnemonic-language="$LANG_CHOICE" \
    --command="exit" >/tmp/wallet-create.log 2>&1 || {
      echo "[entrypoint] ERROR: wallet creation failed." >&2
      exit 1
    }
    echo "[entrypoint] Wallet created successfully." >&2
fi

echo "[entrypoint] waiting for monerod at ${MONEROD_HOST}:${MONEROD_RPC_PORT}..." >&2
# Retry loop to handle DNS resolution or connection lag
for i in $(seq 1 120); do
  # Redirect stderr to /dev/null to hide "Name or service not known" during retries
  if nc -z "$MONEROD_HOST" "$MONEROD_RPC_PORT" 2>/dev/null; then
    echo "[entrypoint] monerod is up!" >&2
    break
  fi
  if [ $i -eq 120 ]; then
    echo "[entrypoint] ERROR: monerod not reachable after 120 seconds" >&2
    exit 1
  fi
  sleep 2
done

echo "[entrypoint] launching monero-wallet-rpc" >&2

exec /opt/monero/monero-wallet-rpc \
  $NET_FLAG \
  --daemon-address="${MONEROD_HOST}:${MONEROD_RPC_PORT}" \
  --wallet-file="$WALLET_FILE" \
  --password="$MONERO_WALLET_PASSWORD" \
  --rpc-bind-ip=0.0.0.0 \
  --rpc-bind-port="$WALLET_RPC_PORT" \
  --confirm-external-bind \
  --disable-rpc-login \
  "$@"