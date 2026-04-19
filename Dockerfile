FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y ca-certificates git make g++ nodejs npm openssl pkg-config python3 libboost-dev libboost-system-dev libboost-date-time-dev libsodium-dev \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8080 8443 3333

WORKDIR /xmr-node-proxy
COPY . /xmr-node-proxy
RUN npm install \
    && cp --update=none config_example.json config.json \
    && openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.proxy" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
CMD ["node", "proxy.js"]
