FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 netcat-openbsd tini \
    && rm -rf /var/lib/apt/lists/*

ARG MONERO_UID=1000
ARG MONERO_GID=1000
RUN groupadd -g "${MONERO_GID}" monero \
    && useradd -m -u "${MONERO_UID}" -g "${MONERO_GID}" -s /bin/bash monero

RUN mkdir -p /opt/monero /wallet \
    && chown -R monero:monero /opt/monero /wallet

WORKDIR /opt/monero

# Download binaries
RUN curl -fL https://downloads.getmonero.org/cli/linux64 -o monero.tar.bz2 \
    && tar -xjf monero.tar.bz2 --strip-components=1 \
    && rm -f monero.tar.bz2

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown monero:monero /entrypoint.sh

USER monero
WORKDIR /wallet

EXPOSE 18083 28083 38083

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]