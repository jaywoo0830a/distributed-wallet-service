# wallet-api (ESM + Babel) - Stub/near-implementation skeleton

This project provides an ExpressJS API + BullMQ workers + MySQL state store, aligned with the provided OpenAPI design (polling, idempotency, async internals).

## Run with Docker

```bash
docker compose up --build
```

- API: http://localhost:3000
- Health: http://localhost:3000/up

## Local (no Docker)

```bash
npm i
npm run build
npm run migrate
npm run start
npm run worker
```

## Notes

- Source code is written in modern ECMAScript (ESM). Output is compiled to `dist/` via Babel.
- Replace `src/wallet/adapter.js` with your real wallet implementation.

