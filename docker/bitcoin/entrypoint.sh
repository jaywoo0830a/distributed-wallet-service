#!/bin/bash
set -e

# Configuration based on environment variables
BITCOIN_NETWORK=${BITCOIN_NETWORK:-regtest}
RPC_USER=${BITCOIN_RPC_USER:-devuser}
RPC_PASS=${BITCOIN_RPC_PASSWORD:-devpass}
BITCOIN_DIR="/home/bitcoin/.bitcoin"

# Ensure data directory exists and has correct permissions
mkdir -p "$BITCOIN_DIR"

# Generate bitcoin.conf if not already present
if [ ! -f "$BITCOIN_DIR/bitcoin.conf" ]; then
    echo "Initializing bitcoin.conf for ${BITCOIN_NETWORK}"
    cat <<EOF > "$BITCOIN_DIR/bitcoin.conf"
chain=${BITCOIN_NETWORK}
server=1
rpcuser=${RPC_USER}
rpcpassword=${RPC_PASS}
rpcbind=0.0.0.0
rpcallowip=0.0.0.0/0
deprecatedrpc=create_bdb

[regtest]
fallbackfee=0.00001
txindex=1
EOF
fi

# Set ownership to ensure gosu can drop privileges safely
chown -R bitcoin:bitcoin "$BITCOIN_DIR"

# Setup logic for Regtest (automatic wallet creation and mining)
setup_regtest() {
    echo "Waiting for bitcoind to respond..."
    until bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getblockchaininfo > /dev/null 2>&1; do
        sleep 2
    done
    
    echo "Creating default wallet..."
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest createwallet "default" || true
    
    echo "Mining 101 blocks to mature coinbase..."
    address=$(bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getnewaddress)
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest generatetoaddress 101 "$address"
    echo "Regtest setup complete."
}

# Run background setup if in regtest mode
if [ "$1" = "bitcoind" ] && [ "$BITCOIN_NETWORK" = "regtest" ]; then
    setup_regtest &
fi

# Use gosu to run the daemon as a non-privileged user
exec gosu bitcoin "$@"