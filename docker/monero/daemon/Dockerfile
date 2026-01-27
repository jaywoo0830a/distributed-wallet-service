FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 tini \
    && rm -rf /var/lib/apt/lists/*

# Monero Setup (UID 1000 to match host typically)
ARG MONERO_UID=1000
ARG MONERO_GID=1000
RUN groupadd -g "${MONERO_GID}" monero \
    && useradd -m -u "${MONERO_UID}" -g "${MONERO_GID}" -s /bin/bash monero

# Directories
RUN mkdir -p /opt/monero /data \
    && chown -R monero:monero /opt/monero /data

WORKDIR /opt/monero

# Download CLI binaries
RUN curl -fL https://downloads.getmonero.org/cli/linux64 -o monero.tar.bz2 \
    && tar -xjf monero.tar.bz2 --strip-components=1 \
    && rm -f monero.tar.bz2 \
    && chown -R monero:monero /opt/monero

USER monero
WORKDIR /data

# Ports: P2P, Mainnet RPC, Testnet RPC, Stagenet RPC
EXPOSE 18080 18081 28080 28081 38080 38081

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/monero/monerod"]
CMD ["--data-dir=/data", "--non-interactive", "--confirm-external-bind"]