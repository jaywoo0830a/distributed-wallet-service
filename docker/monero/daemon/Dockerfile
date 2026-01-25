FROM debian:bookworm-slim

SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

ARG MONERO_UID=1000
ARG MONERO_GID=1000

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 tini \
  && rm -rf /var/lib/apt/lists/*

# Setup user
RUN groupadd -g "${MONERO_GID}" monero \
  && useradd -m -u "${MONERO_UID}" -g "${MONERO_GID}" -s /usr/sbin/nologin monero \
  && mkdir -p /opt/monero /data \
  && chown -R monero:monero /opt/monero /data

WORKDIR /opt/monero

# Download Monero CLI (Latest)
RUN curl -fL --retry 5 --retry-delay 2 --connect-timeout 10 --max-time 300 \
      https://downloads.getmonero.org/cli/linux64 \
      -o monero.tar.bz2 \
  && tar -xjf monero.tar.bz2 --strip-components=1 \
  && rm -f monero.tar.bz2 \
  && chown -R monero:monero /opt/monero

USER monero
WORKDIR /data

# Expose P2P and RPC ports for Mainnet, Testnet, Stagenet
# 18080/18081 (Main), 28080/28081 (Test), 38080/38081 (Stage)
EXPOSE 18080 18081 28080 28081 38080 38081

# Use Tini as init process
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/monero/monerod"]