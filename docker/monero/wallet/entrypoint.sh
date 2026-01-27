#!/bin/bash
# Exit immediately if a command exits with a non-zero status
set -e

# Configuration from environment variables
BITCOIN_NETWORK=${BITCOIN_NETWORK:-regtest}
RPC_USER=${BITCOIN_RPC_USER:-devuser}
RPC_PASS=${BITCOIN_RPC_PASSWORD:-devpass}
BITCOIN_DIR="/home/bitcoin/.bitcoin"

# Ensure the data directory exists
mkdir -p "$BITCOIN_DIR"

# Initialize bitcoin.conf if not present
# Fix: Recent Bitcoin Core versions require network-specific settings in their own sections
if [ ! -f "$BITCOIN_DIR/bitcoin.conf" ]; then
    echo "Creating new bitcoin.conf for network: $BITCOIN_NETWORK"
    cat <<EOF > "$BITCOIN_DIR/bitcoin.conf"
# Global settings
server=1
txindex=1

# Network selection
chain=${BITCOIN_NETWORK}

# Network specific settings
[${BITCOIN_NETWORK}]
rpcuser=${RPC_USER}
rpcpassword=${RPC_PASS}
rpcbind=0.0.0.0
rpcallowip=0.0.0.0/0
fallbackfee=0.00001

# Map regtest port for clarity if needed
# rpcport=18443
EOF
fi

# Ensure correct ownership so gosu can drop privileges
chown -R bitcoin:bitcoin "$BITCOIN_DIR"

# Background task for regtest initialization (mining initial blocks)
setup_regtest() {
    echo "Waiting for bitcoind to start RPC server..."
    # Loop until bitcoind responds to getblockchaininfo
    # Use -rpcwait to be safer, or simple loop
    until bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getblockchaininfo > /dev/null 2>&1; do
        sleep 2
    done
    
    echo "Bitcoind is up. Setting up default wallet..."
    # Create a default wallet for development use (descriptors=false for legacy compatibility if needed)
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest createwallet "default" || true
    
    # Mine 101 blocks to provide spendable coinbase rewards (mature coins)
    echo "Mining 101 blocks to mature coinbase..."
    address=$(bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getnewaddress)
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest generatetoaddress 101 "$address"
    echo "Regtest environment ready."
}

# Only run setup for regtest mode
if [ "$1" = "bitcoind" ] && [ "$BITCOIN_NETWORK" = "regtest" ]; then
    setup_regtest &
fi

# Execute bitcoind as the bitcoin user using gosu
exec gosu bitcoin "$@"