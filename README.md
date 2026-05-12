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

| Script              | What                    |
| ------------------- | ----------------------- |
| `npm run dev`       | api + web in watch mode |
| `npm run build`     | builds both apps        |
| `npm run typecheck` | tsc on both             |
| `npm run lint`      | eslint on both          |
| `npm run format`    | prettier --write        |

`apps/api`:

| Script              | What                      |
| ------------------- | ------------------------- |
| `db:up` / `db:down` | start/stop local Postgres |
| `db:generate`       | regenerate Prisma client  |
| `db:migrate`        | run dev migration         |
| `db:studio`         | open Prisma Studio        |

## Deployment (DigitalOcean App Platform)

The app spec at `.do/app.yaml` describes everything: two services (api + web) behind one
load balancer, a managed Postgres component, and a PRE_DEPLOY job that runs
`prisma migrate deploy` before each release goes live. Routing inside the app is by path
(`/api/*` → api component, `/` → web component) so both share the same hostname — no CORS
configuration, cookies just work.

### First-time setup

Prerequisites: a DigitalOcean account and `doctl` CLI installed + authenticated.

1. **Validate the spec locally:**
   ```bash
   doctl apps spec validate .do/app.yaml
   ```

2. **Create the app:**
   ```bash
   doctl apps create --spec .do/app.yaml
   ```
   Note the printed `App ID` — you'll need it for updates.

3. **Set secrets in the Dashboard** (Apps → quoteom → Settings → App-Level Environment Variables). These can't be in the spec because they're secret values:
   - `AUTH_SECRET` — generate with `openssl rand -base64 32`
   - `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`
   - `RESEND_API_KEY`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (leave blank to disable that provider)
   - `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (leave blank to disable)

   After the first deploy attempt these will be visible as empty SECRET fields; fill them in and trigger a new deploy.

4. **Point Stripe webhooks** at `https://<your-app>.ondigitalocean.app/api/billing/webhook`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

5. **Custom domain** (optional): in App Platform Dashboard → Settings → Domains.

### Updating the spec

After editing `.do/app.yaml`:

```bash
doctl apps update <APP_ID> --spec .do/app.yaml
```

Pushing to `main` auto-deploys via `deploy_on_push: true` regardless of spec changes; you only need the explicit `update` when the spec itself changes (e.g. new env vars, scaling settings).

### Rollback

App Platform keeps the last several builds. To roll back:

**Via Dashboard** (fastest):
1. Apps → quoteom → Activity tab → find the last good deployment → click → **Rollback to this deployment**.

**Via CLI:**
```bash
doctl apps list-deployments <APP_ID>            # find a good deployment id
doctl apps create-deployment <APP_ID> \
    --force-rebuild \
    --restore-from-deployment <DEPLOYMENT_ID>
```

**Database migrations are not auto-reverted.** If a bad deploy ran a destructive migration, you have to write + apply a follow-up migration manually:

```bash
# In a local clone, generate a corrective migration:
cd apps/api
npx prisma migrate dev --name revert_<thing>
# Push to main — the next PRE_DEPLOY job runs it against prod.
```

For schema changes that aren't safely reversible (dropping a column with live data), pause new deploys before merging:

```bash
doctl apps update-deployment-policy <APP_ID> --deploy-on-push=false
```

…investigate, then re-enable.

### CI gate

`.github/workflows/ci.yml` runs typecheck + lint + tests + build on every PR and push. Merges to `main` only proceed after CI is green; App Platform then picks up the commit and deploys.
