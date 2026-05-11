# Quoteom

AI offerte management for Dutch SMBs. Reads inbox + WhatsApp, extracts quote requests, drafts replies in the owner's tone, generates quote PDFs, and tracks deadlines and expiry dates so nothing goes cold.

## Stack

- **Frontend**: TanStack Start (React 19) + MUI v9 + TanStack Query
- **Backend**: NestJS 11 + Prisma 7 + Postgres 16
- **Build**: Turborepo + npm workspaces
- **Deploy**: DigitalOcean App Platform (EU)

## Structure

```
apps/
├── api/   NestJS — REST API, Prisma, AI orchestration
└── web/   TanStack Start — frontend + SSR
```

## Quickstart

Prerequisites: Node 22+, Docker.

```bash
# install
npm install

# env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# local Postgres
cd apps/api && npm run db:up

# everything in dev mode
cd ../.. && npm run dev
```

- API: http://localhost:3001 (Swagger at `/docs`)
- Web: http://localhost:3000

## Scripts

Root (runs across all apps via turbo):

| Script | What |
|---|---|
| `npm run dev` | api + web in watch mode |
| `npm run build` | builds both apps |
| `npm run typecheck` | tsc on both |
| `npm run lint` | eslint on both |
| `npm run format` | prettier --write |

`apps/api`:

| Script | What |
|---|---|
| `db:up` / `db:down` | start/stop local Postgres |
| `db:generate` | regenerate Prisma client |
| `db:migrate` | run dev migration |
| `db:studio` | open Prisma Studio |

## Deployment

See `.do/app.yaml` for the DigitalOcean App Platform spec.
