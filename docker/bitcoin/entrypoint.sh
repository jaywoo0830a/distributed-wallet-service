#!/bin/bash
set -e

# Default to regtest (local dev) if not specified
BITCOIN_NETWORK=${BITCOIN_NETWORK:-regtest}
RPC_USER=${BITCOIN_RPC_USER:-devuser}
RPC_PASS=${BITCOIN_RPC_PASSWORD:-devpass}

# Configure bitcoin.conf if not exists
if [ ! -f "/home/bitcoin/.bitcoin/bitcoin.conf" ]; then
    echo "Creating bitcoin.conf for network: $BITCOIN_NETWORK"
    cat <<EOF > /home/bitcoin/.bitcoin/bitcoin.conf
chain=${BITCOIN_NETWORK}
server=1
rpcuser=${RPC_USER}
rpcpassword=${RPC_PASS}
rpcbind=0.0.0.0
rpcallowip=0.0.0.0/0
deprecatedrpc=create_bdb
EOF

    if [ "$BITCOIN_NETWORK" == "regtest" ]; then
        echo "fallbackfee=0.00001" >> /home/bitcoin/.bitcoin/bitcoin.conf
        echo "txindex=1" >> /home/bitcoin/.bitcoin/bitcoin.conf
    fi
fi

# Fix permissions
chown -R bitcoin:bitcoin /home/bitcoin

# Background function to create default wallet and mine blocks (only for regtest)
setup_regtest() {
    echo "Waiting for Bitcoind to start..."
    until bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getblockchaininfo > /dev/null 2>&1; do
        sleep 1
    done
    
    echo "Bitcoind started. Creating default wallet..."
    # Try creating wallet, ignore if exists
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest createwallet "default" || true
    
    echo "Mining 101 blocks to mature coinbase (so we have funds)..."
    address=$(bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest getnewaddress)
    bitcoin-cli -rpcuser=${RPC_USER} -rpcpassword=${RPC_PASS} -regtest generatetoaddress 101 "$address"
    echo "Regtest setup complete."
}

if [ "$1" = "bitcoind" ] && [ "$BITCOIN_NETWORK" = "regtest" ]; then
    setup_regtest &
fi

exec gosu bitcoin "$@"