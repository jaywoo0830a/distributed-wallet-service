#!/bin/bash
set -e

# Config
WALLET_DIR="/wallet"
WALLET_FILE="$WALLET_DIR/main.wallet"
MONEROD_HOST="${MONEROD_HOST:-monerod}"
WALLET_PASS="${MONERO_WALLET_PASSWORD:-devpass}"
MONERO_NETWORK="${MONERO_NETWORK:-mainnet}"

# Define ports based on network
case "$MONERO_NETWORK" in
  testnet)  DAEMON_PORT=28081; W_PORT=28083; FLAG="--testnet" ;;
  stagenet) DAEMON_PORT=38081; W_PORT=38083; FLAG="--stagenet" ;;
  *)        DAEMON_PORT=18081; W_PORT=18083; FLAG="" ;;
esac

# Create wallet if missing
if [ ! -f "$WALLET_FILE" ]; then
    echo "[entrypoint] Generating new Monero wallet..."
    /opt/monero/monero-wallet-cli $FLAG --offline \
        --generate-new-wallet="$WALLET_FILE" \
        --password="$WALLET_PASS" \
        --mnemonic-language="English" \
        --command="exit"
fi

# Wait for monerod to be ready
echo "[entrypoint] Waiting for monerod at $MONEROD_HOST:$DAEMON_PORT..."
until nc -z "$MONEROD_HOST" "$DAEMON_PORT"; do
    sleep 3
done
echo "[entrypoint] Monerod detected."

# Run the RPC server
# --non-interactive is critical to prevent exiting when running in docker
echo "[entrypoint] Starting monero-wallet-rpc on port $W_PORT..."
exec /opt/monero/monero-wallet-rpc $FLAG \
    --daemon-address="$MONEROD_HOST:$DAEMON_PORT" \
    --wallet-file="$WALLET_FILE" \
    --password="$WALLET_PASS" \
    --rpc-bind-ip=0.0.0.0 \
    --rpc-bind-port="$W_PORT" \
    --confirm-external-bind \
    --disable-rpc-login \
    --non-interactive \
    --trusted-daemon