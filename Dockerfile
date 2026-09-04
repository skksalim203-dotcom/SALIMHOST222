# Guarantees Node.js + Python3 + pip3 + git are present, regardless of how
# the hosting platform's auto-detection (e.g. nixpacks) behaves.
# Railway (and most PaaS) automatically prefer a Dockerfile over other
# builders when one exists in the repo root.
FROM node:20-bullseye-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/bin/python

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 26365

CMD ["node", "server.js"]
