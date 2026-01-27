FROM debian:bookworm-slim

# Install dependencies including netcat for healthchecks and connectivity testing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

ARG MONERO_UID=1000
ARG MONERO_GID=1000

# Setup monero user and wallet directory with strict permissions
RUN groupadd -g "${MONERO_GID}" monero \
    && useradd -m -u "${MONERO_UID}" -g "${MONERO_GID}" -s /usr/sbin/nologin monero \
    && mkdir -p /opt/monero /wallet \
    && chown -R monero:monero /opt/monero /wallet \
    && chmod 700 /wallet

WORKDIR /opt/monero

# Download same binaries as daemon to ensure version parity
RUN curl -fL https://downloads.getmonero.org/cli/linux64 -o monero.tar.bz2 \
    && tar -xjf monero.tar.bz2 --strip-components=1 \
    && rm -f monero.tar.bz2 \
    && chown -R monero:monero /opt/monero

# Copy the custom entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && chown monero:monero /entrypoint.sh

USER monero
WORKDIR /wallet

# Expose Wallet RPC ports for Mainnet, Testnet, and Stagenet
EXPOSE 18083 28083 38083

ENTRYPOINT ["/entrypoint.sh"]