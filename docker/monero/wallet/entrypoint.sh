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
  # Note: --command="exit" creates the wallet and immediately quits
  /opt/monero/monero-wallet-cli \
    $NET_FLAG \
    --offline \
    --generate-new-wallet="$WALLET_FILE" \
    --password="$MONERO_WALLET_PASSWORD" \
    --mnemonic-language="$LANG_CHOICE" \
    --command="exit" >/tmp/wallet-create.log 2>&1 || {
      echo "[entrypoint] ERROR: wallet creation failed. tail:" >&2
      tail -n 80 /tmp/wallet-create.log >&2 || true
      exit 1
    }
    echo "[entrypoint] Wallet created successfully." >&2
fi

echo "[entrypoint] waiting for monerod at ${MONEROD_HOST}:${MONEROD_RPC_PORT}..." >&2
for i in $(seq 1 60); do
  nc -z "$MONEROD_HOST" "$MONEROD_RPC_PORT" && break
  sleep 1
done

echo "[entrypoint] launching monero-wallet-rpc (network=$MONERO_NETWORK, bind=0.0.0.0:$WALLET_RPC_PORT, daemon=$MONEROD_HOST:$MONEROD_RPC_PORT)" >&2

# Start the RPC server
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