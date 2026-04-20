FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /xmr-node-proxy

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ git libboost-date-time-dev libsodium-dev make nodejs npm openssl python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund --no-package-lock

COPY . .
RUN cp --update=none config_example.json config.json \
    && openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.proxy" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500

EXPOSE 1111 3333 8080 8081 8443

CMD ["node", "proxy.js"]
