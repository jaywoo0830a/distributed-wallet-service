#!/bin/bash
# docker/bitcoin/entrypoint.sh
set -e

# Config from env
BITCOIN_NETWORK=${BITCOIN_NETWORK:-regtest}
RPC_USER=${BITCOIN_RPC_USER:-devuser}
RPC_PASS=${BITCOIN_RPC_PASSWORD:-devpass}
BITCOIN_DIR="/home/bitcoin/.bitcoin"

# Ensure directory exists
mkdir -p "$BITCOIN_DIR"

# Initialize config if missing
# NOTE: v28.0+ requires network-specific settings inside their own sections
if [ ! -f "$BITCOIN_DIR/bitcoin.conf" ]; then
    echo "Creating bitcoin.conf for $BITCOIN_NETWORK"
    cat <<EOF > "$BITCOIN_DIR/bitcoin.conf"
# Global
server=1
printtoconsole=1

# Storage Optimization (Pruning)
# Set the block storage limit in MiB. 550 is the minimum.
# 1000 MiB equals ~1GB.
prune=1000

# Transaction Indexing
# Disabling txindex saves significant space. 
# The wallet will still function for its own addresses.
txindex=0

# Network Specific Section
[${BITCOIN_NETWORK}]
rpcuser=${RPC_USER}
rpcpassword=${RPC_PASS}
rpcbind=0.0.0.0
rpcallowip=0.0.0.0/0
fallbackfee=0.00001
EOF
fi

# Fix volume permissions
chown -R bitcoin:bitcoin "$BITCOIN_DIR"

# Regtest automation (mining first blocks)
setup_regtest() {
    echo "Waiting for bitcoind RPC server..."
    until bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getblockchaininfo > /dev/null 2>&1; do
        sleep 2
    done
    
    echo "Bitcoind ready. Initializing regtest wallet..."
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest createwallet "default" || true
    
    # Mine 101 blocks to make coins spendable
    echo "Mining 101 blocks to mature coinbase rewards..."
    address=$(bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getnewaddress)
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest generatetoaddress 101 "$address"
    echo "Regtest setup complete."
}

if [ "$1" = "bitcoind" ] && [ "$BITCOIN_NETWORK" = "regtest" ]; then
    setup_regtest &
fi

# Run as bitcoin user using gosu
exec gosu bitcoin "$@"