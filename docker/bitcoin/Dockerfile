FROM debian:bookworm-slim

ARG BITCOIN_VERSION=28.0
ARG BITCOIN_URL=https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

# Download and Install Bitcoin Core
RUN curl -SLO "${BITCOIN_URL}" \
    && tar -xzf bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz -C /usr/local --strip-components=1 \
    && rm bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz

# Setup user and directories
RUN groupadd -r bitcoin && useradd -r -m -g bitcoin bitcoin \
    && mkdir -p /home/bitcoin/.bitcoin \
    && chown -R bitcoin:bitcoin /home/bitcoin

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

VOLUME /home/bitcoin/.bitcoin

EXPOSE 8332 8333 18332 18333 18443 18444

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bitcoind"]