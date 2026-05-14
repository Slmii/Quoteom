# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Quoteom — AI offerte management for Dutch SMBs. Reads inbox + WhatsApp, extracts quote requests, drafts replies in the owner's tone, generates quote PDFs, tracks deadlines / expiry / follow-ups.

Solo 14-week MVP build. The build plan lives at `~/.claude/plans/toasty-herding-giraffe.md` (week-by-week with status markers + decisions/deviations). The reference test catalog is `TEST_CASES.md` (one entry per behavior we need to verify before shipping).

## Stack at a glance

- **Monorepo**: Turborepo + pnpm workspaces. Node 22+, pnpm 10+ (activate via `corepack enable`).
- **Web**: TanStack Start (React 19, Vite 7) + MUI v9 + TanStack Query v5. SSR-first.
- **API**: NestJS 11 (Express + CommonJS, plain `tsc`) + Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`) + Postgres 16 (Docker locally).
- **Auth**: Auth.js v5 mounted as Express middleware at `/api/auth/*` (magic link via Resend + Google + Microsoft Entra). JWT sessions.
- **Billing**: Stripe (API version `2026-04-22.dahlia` pinned) with graduated tiered pricing.
- **Deploy target**: DigitalOcean App Platform EU (not wired yet; W1.5 carryover).

## Commands

Run from repo root unless specified. All scripts are turbo-orchestrated:

```bash
pnpm install                       # bootstrap workspaces
pnpm dev                           # api + web in watch mode
pnpm typecheck                     # tsc --noEmit across both apps
pnpm lint                          # eslint
pnpm format                        # prettier --write
pnpm test                          # runs jest (api) + vitest (web)
```

API-specific (in `apps/api/`):

```bash
pnpm db:up                         # docker compose: local Postgres
pnpm db:down
pnpm db:migrate                    # prisma migrate dev
pnpm db:deploy                     # prisma migrate deploy (prod)
pnpm db:generate                   # regen Prisma client into src/generated/prisma/
pnpm db:studio
pnpm db:seed                       # prisma db seed (runs prisma/seed.ts via tsx)
pnpm dev                           # nest start --watch
pnpm invite --email a@b.com --org <uuid> [--role MEMBER|OWNER|EXTERNAL]
```

Web-specific (in `apps/web/`):

```bash
pnpm dev                           # vite dev (port 3000, proxies /api → 3001)
pnpm build                         # vite build (.output/)
pnpm start                         # node .output/server/index.mjs
pnpm test                          # vitest run
```

Single test runs:

```bash
# API (Jest) — from apps/api/
pnpm exec jest src/modules/billing/billing.service.spec.ts
pnpm exec jest -t "syncFromStripe clears state"

# Web (Vitest) — from apps/web/
pnpm exec vitest run src/lib/utils/foo.test.ts
```

## High-level architecture

### Two apps, talking via `/api/*`

- **Browser → web (port 3000)**. Vite dev proxies `/api/*` → API at 3001 with `changeOrigin: false` so the `Host` header stays `localhost:3000`. This is load-bearing for Auth.js: the magic-link callback must land on the web origin so the session cookie scopes correctly. **Don't change `changeOrigin`.**
- **Web SSR → API**. Browser fetches use relative URLs through the proxy. **SSR-side fetches must use absolute URLs + forwarded cookies** — that's what `lib/api/server-fetch.ts` (used inside `createServerFn` handlers) handles. Don't `fetch('/api/...')` in SSR code; it throws "Failed to parse URL".
- **Stripe webhook**. `POST /api/billing/webhook`. Signature-verified, no auth. Local dev: `stripe listen --forward-to localhost:3001/api/billing/webhook`.

### API layout (`apps/api/src/`)

```
common/                # cross-cutting framework primitives
  guards/              # auth, organization, owner, entitlement
  decorators/          # @TenantWrite, @OwnerWrite (composite UseGuards)
  filters/             # AllExceptionsFilter (forwards code + billingPath)
  dto/
config/                # @nestjs/config Zod env schema
lib/
  errors.ts            # ALL thrown messages live here (single source of truth)
  mails/               # Resend templates (Inter + Playfair, dedent-rendered)
generated/prisma/      # Prisma client (committed; generator output)
modules/
  auth/                # auth.config (Auth.js v5 ExpressAuth) + auth.module
  prisma/              # @Global PrismaService
  logger/              # LogService — extends ConsoleLogger, persists fatal/error/warn to Log table
  billing/             # Stripe — controller / service / module / DTOs / constants
  invitations/
  me/
```

Path aliases: `@/*` → `apps/api/src/*`. No `.js` suffixes in imports (NestJS = CommonJS in this project; SWC was tried and reverted in favor of plain `tsc`).

### Web layout (`apps/web/src/`)

```
routes/
  (auth)/route.tsx     # public layout (sign-in)
  (app)/route.tsx      # authenticated layout — redirects to /sign-in if no session
  (app)/billing/route.tsx   # beforeLoad: redirects non-owners to /
lib/
  api/                 # createServerFn handlers + browser fetch client
    server-fetch.ts    # absolute URL + cookie forwarding for SSR
    client.ts          # browser fetch wrapper (relative URLs, 402 auto-redirect)
  queries/             # *.queries.ts — queryOptions + mutation hooks per domain
  schemas/             # zod schemas for route search params / forms
  utils/               # theme, page meta, etc.
```

Path alias: `@/*` → `apps/web/src/*`.

## Architectural patterns that are non-obvious

### Three orthogonal request gates, three guards

For tenant-scoped routes, ask three independent questions:

| Question | Guard |
| --- | --- |
| Who are you? | `AuthGuard` (built into the others) |
| Which org? | `OrganizationGuard` (built into `OwnerGuard`) |
| Is the org allowed to make changes? | `EntitlementGuard` |
| (Optional) Are you the org's OWNER? | `OwnerGuard` |

Apply via composite decorators:

- `@UseGuards(OrganizationGuard)` — read; any member of the org.
- `@TenantWrite()` — write; any member; needs entitlement (covers trial/active/past_due/local-grace).
- `@UseGuards(OwnerGuard)` — owner-only, no entitlement check (e.g. billing Checkout — needed when the sub is *canceled* to re-subscribe).
- `@OwnerWrite()` — owner-only write that also requires entitlement.

`EntitlementGuard` (formerly `TrialGateGuard` — renamed because it gates ALL non-entitled states, not just trials) returns `402 { code: 'billing_required', billingPath: '/billing' }`. The web `api()` client auto-redirects to `/billing` on that exact shape.

### Stripe sync — single source-of-truth function

`BillingService.syncFromStripe(customerId)` is the **only** path that writes to the local `Subscription` table. Every tracked webhook event triggers a full re-sync (never partial updates from event payloads). Pattern is Theo's "How I Stay Sane Implementing Stripe":

- Pinned API version `2026-04-22.dahlia`.
- `current_period_*` lives on `subscription.items.data[0]`, not the subscription root (Stripe moved it in 2024).
- `getOrCreateCustomer` is self-healing — verifies the local `stripeCustomerId` still exists at Stripe, recreates on `resource_missing`.
- Webhook handler 200s immediately and processes via `setImmediate` so Stripe's retry timer never fires for in-flight handlers.
- **Never pass `payment_method_types`** on Checkout/SetupIntents — use Dashboard Payment Method Configurations.

### Per-seat billing model

Stripe Price is graduated tiered: tier 1 = first `SEATS_INCLUDED` (3) seats at flat €149, tier 2 = €30/seat overage. `BillingService.syncSeatCount(orgId)` reconciles Stripe's billed `quantity` with `Membership.count` after every invitation accept, with `proration_behavior: 'create_prorations'`. Skipped during `local_trial` and after `canceled`. Trial orgs are capped at `SEATS_INCLUDED` seats (invitation creation rejects with `402 trial_seat_limit`).

### Logging routes through the DB

API uses `new Logger(ContextName)` everywhere, but `main.ts` calls `app.useLogger(app.get(LogService))` — so every `Logger` instance routes through `LogService`, which **persists fatal/error/warn to the `Log` Postgres table** (log/debug/verbose stay console-only). No third-party error tracking; the DB is the audit trail.

**Never use `console.*` in API code** that runs after `app.useLogger(...)`. `lib/mails/send.ts`, `auth.config.ts` use module-level `new Logger('Mail')` / `new Logger('Auth')`. Only `load-env.ts` (pre-Nest bootstrap) is allowed `console.log`.

### Error messages live in one file

`apps/api/src/lib/errors.ts` is the canonical home for every thrown message. Constants for static text (`INVITATION_NOT_FOUND`), functions for templates (`trialSeatLimitReached(cap)`). Service/controller/guard throw sites import from there — never inline strings.

### Web data fetching — loader + queryOptions + Suspense

For every GET in the web app:

1. Define a `createServerFn` handler in `lib/api/<feature>.api.ts` that calls `serverFetch(...)` (handles SSR absolute URL + cookie forwarding).
2. Wrap in `queryOptions({ queryKey, queryFn: <serverFn>, staleTime })` in `lib/queries/<feature>.queries.ts`.
3. In the route file: `loader: ({ context }) => context.queryClient.ensureQueryData(theQueryOptions)`.
4. In the component: `const { data } = useSuspenseQuery(theQueryOptions)`.

**Never** use bare `useQuery` for GETs at the component level (causes a render-then-fetch waterfall, breaks SSR-correct first paint). The route `loader` is the prefetch mechanism — `useSuspenseQuery` then reads guaranteed data.

POST/PATCH/DELETE use `useMutation` with the relative-URL `api()` client. Mutations that invalidate a query call `invalidateQueries({ queryKey: theQueryOptions.queryKey })`.

### Controllers return typed DTO classes

Every controller method has an explicit return-type annotation pointing at a DTO **class** (not interface) and is decorated with `@ApiOkResponse({ type: TheDto })` (use `[TheDto]` for arrays). This is required for Orval-generated client types — TS interfaces are erased at runtime and don't appear in the OpenAPI spec. Service methods that produce values that cross the controller boundary should be typed with the DTO directly — don't define a parallel interface with the same shape.

Service inputs (`CreateInvitationInput`) and module-private types (`PaymentMethodLike`, `ErrorResponseBody`) can remain interfaces — they never cross a boundary.

### SSR-safe formatting

In SSR-rendered components: **never** `toLocaleDateString(undefined, …)` or `Intl.*Format()` with undefined locale. Node defaults to `en-US`, the browser uses the visitor's locale → hydration mismatch. Use `dayjs(date).format('D MMM YYYY')` for dates; inline cents-to-string helper for currency. dayjs is already a dependency via MUI's `AdapterDayjs`.

### Self-signup is BLOCKED

Auth.js's `createUser` is overridden to throw — only **invitations** create User rows. The `InvitationsService.accept` flow upserts the user via case-insensitive lookup (since legacy rows may exist mixed-case) and stores all new emails lowercased.

### Multi-org per user

A user has `currentOrganizationId` for the active session. `OrganizationGuard` reads that and attaches `request.organizationId`. Future "switch org" UI will let users pivot between memberships.

## Conventions to follow

- TypeScript everywhere. Named exports for components/utilities; avoid default exports.
- Type/interface field order: primitives first, then booleans, then functions. Optionals after required.
- Boolean variable prefixes: `is*`, `has*`, `can*`, `should*`.
- All API modules under `src/modules/<feature>/`. New modules: controller + service + module + `dto/` (request DTOs and `*.response.dto.ts`).
- Per-app `.env` files (never root-level env). Read via `ConfigService<EnvSchema, true>.get('KEY', { infer: true })` for NestJS-managed code; raw `process.env` only for pre-DI code (`auth.config.ts`, `load-env.ts`, `lib/mails/send.ts`, `prisma/seed.ts`).
- UI text in English first (Dutch i18n later).

## Stripe testing

`stripe listen --forward-to localhost:3001/api/billing/webhook` must be running in another terminal. The `whsec_…` it prints goes into `apps/api/.env` as `STRIPE_WEBHOOK_SECRET`. Restart the API after changing.

Quick scenarios:
- `stripe trigger payment_intent.succeeded` — proves the channel works.
- `stripe subscriptions update sub_XXX --trial-end=now` — end an active trial (only works if status is `trialing`; if already `active`, cancel and re-subscribe via `/billing`).
- `stripe subscriptions cancel sub_XXX` — kill an active sub to test resubscribe.

See `TEST_CASES.md` for the full Stripe / billing test catalog (BILLING-01..25, INV-01..17, etc.).

## Inngest dev workflow (W3.3+)

The API exposes `/api/inngest` (mounted in `main.ts`, same pattern as Auth.js). Functions live in `apps/api/src/modules/inngest/functions/` and register via the array in `functions/index.ts`.

Local dev needs the Inngest CLI running alongside the API:

```bash
# Terminal 1
pnpm dev                                                 # API + web

# Terminal 2
pnpm --filter @quoteom/api inngest                       # discovers /api/inngest (pinned inngest-cli devDep)
# Open http://localhost:8288 — every registered function shows up here.
```

The CLI dev server handles auth at the localhost boundary, so `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` stay empty in dev. They're required in production (Inngest Cloud → Settings → Keys).

Smoke checks:
- **Manual event** → in the dev UI: New event → `{"name": "test/hello", "data": {"name": "Quoteom"}}` → run history shows the `hello` fn output `{ "greeting": "Hello, Quoteom!" }`.
- **Scheduled cron** → `heartbeat` fires at `0 * * * *`. In the dev UI use "Invoke" to bypass the cron and trigger it manually.

Adding a new function:
1. Create `apps/api/src/modules/inngest/functions/<name>.function.ts` exporting an `InngestFunction.Any`-typed constant.
2. Add the import + export to `functions/index.ts`.
3. Reload the API — the dev UI picks it up on the next discovery poll.

## Gmail push notifications dev workflow (W3.5)

Pub/Sub push delivery requires a publicly-reachable HTTPS URL. Same shape as the Stripe webhook flow but heavier: instead of a single CLI you need an ngrok tunnel + a real GCP project. **Skip this section entirely for local-only dev** — `GmailWatchService` no-ops cleanly when `GOOGLE_PUBSUB_TOPIC` is unset, so the connect / backfill / disconnect flow works without any of this.

Two ways to exercise the push pipeline locally:

### Easy: simulate the push (no GCP, validates delta-sync only)

Bypasses the webhook + JWT verification. Connect Gmail through the UI, copy the `EmailAccount.id` from `db:studio`, then in the Inngest dev UI (http://localhost:8288) fire:

```json
{ "name": "gmail/history.changed", "data": { "emailAccountId": "<paste>" } }
```

Sends a real `users.history.list` to Google with the stored cursor, persists new `RawMessage` rows, advances `historyId`. Good enough to verify the delta-sync code; doesn't exercise Pub/Sub or JWT verification.

### Full: end-to-end via ngrok + GCP Pub/Sub

One-time setup per dev machine:

1. **Pub/Sub topic** in GCP — `projects/<gcp-project>/topics/quoteom-gmail-dev`. On the topic's Permissions tab, grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role (without this, `users.watch` 403s — the #1 Phase C gotcha).
2. **Reserved ngrok domain** — free tier gives one. Run `ngrok http 3000 --domain=<your-domain>` pointing at the **web** port (3000), so `/api/*` proxies through to the API.
3. **Push subscription** on the topic — Delivery type: **Push**; Endpoint URL: `https://<your-domain>/api/email/gmail/webhook`; Enable authentication: **ON**; Audience: same as the endpoint URL; pick or create a service account with `roles/iam.serviceAccountTokenCreator`.
4. **Authorized redirect URIs** on the Google OAuth client — add `https://<your-domain>/api/email/gmail/callback` and `https://<your-domain>/api/auth/callback/google` so OAuth callbacks land on the tunnel domain during smoke testing.
5. **`apps/api/.env`**:
   ```bash
   GOOGLE_PUBSUB_TOPIC=projects/<gcp-project>/topics/quoteom-gmail-dev
   GOOGLE_PUBSUB_AUDIENCE=https://<your-domain>/api/email/gmail/webhook
   GOOGLE_PUBSUB_SERVICE_ACCOUNT=<service-account-email-from-step-3>
   ```
   Restart `pnpm dev`.

Smoke flow (4 terminals: `pnpm dev`, `pnpm --filter @quoteom/api inngest`, `ngrok ...`, `db:studio`):

1. Sign in via the **ngrok URL** (not `localhost:3000` — OAuth callbacks need to land on the tunnel domain).
2. Connect Gmail at `/settings/email`. The `gmail-backfill` Inngest run shows two steps: `backfill` then `start-watch`. After completion: `EmailAccount.historyId` set AND `watchExpiresAt` ~7 days out.
3. Send yourself a test email from another account.
4. Within 5–10 seconds:
   - **ngrok inspector** (http://localhost:4040): POST to `/api/email/gmail/webhook` with a `Bearer eyJ...` JWT, response 204.
   - **Inngest UI**: `gmail-delta-sync` fires (2 s debounce — wait a beat), run reports `messagesInserted: 1`.
   - **`RawMessage`** in `db:studio`: the new row.

Renewal cron is verifiable without waiting a week: in `db:studio` backdate `watchExpiresAt` to yesterday → in the Inngest UI click **Invoke** on `gmail-watch-renewal` → output reports `{ scanned: 1, renewed: 1, ... }` and `watchExpiresAt` jumps back to ~7 days out. Same path also verifies the orphan-row fix: NULL out `watchExpiresAt` (keep `historyId`) and Invoke again — orphan still gets picked up.

Common Phase C gotchas (in order of frequency):

| Symptom | Fix |
|---|---|
| `users.watch` returns 403 / `Insufficient Permission` | `gmail-api-push@system.gserviceaccount.com` missing Publisher on topic (Step 1). |
| OAuth callback redirects to `localhost:3000` | `WEB_ORIGIN` in `apps/api/.env` still set to `http://localhost:3000`. Auth.js's `redirect` callback rewrites every post-signin URL to this value. **Set `WEB_ORIGIN=https://<your-ngrok>` for the smoke**, restart API, then put it back when done. |
| Sign-in completes but home page bounces to `/sign-in` (and `Failed to load organizations (401)`) | `AUTH_URL=http://localhost:3000/api/auth` set in `apps/api/.env`. This env var **overrides** Auth.js's header-based URL detection — `@auth/express`'s `getSession` builds an HTTP URL → uses non-secure cookie name → can't find the `__Secure-`-prefixed cookie that ExpressAuth set. **Unset `AUTH_URL` for the smoke** (and for dev in general — `trustHost: true` handles URL detection from headers). |
| Webhook 401 on every push | `GOOGLE_PUBSUB_AUDIENCE` doesn't match the subscription's audience exactly, OR `GOOGLE_PUBSUB_SERVICE_ACCOUNT` doesn't match the actual signer in the subscription's Auth section. The `gmail.webhook.jwt_invalid` action log includes the JWT's actual `email` claim — copy-paste that into env. |
| Webhook 503 | One of `GOOGLE_PUBSUB_AUDIENCE` / `GOOGLE_PUBSUB_SERVICE_ACCOUNT` is empty — by design (refuse to accept pushes when verification isn't configured). |
| Vite responds 403 "host not allowed" | ngrok subdomain not in `apps/web/vite.config.ts` `server.allowedHosts`. The `.ngrok-free.dev` wildcard already in main covers the free tier; add `.ngrok.app` etc. if you use a different TLD. |
| Push arrives but `gmail.webhook.unknown_mailbox` 204 | `EmailAccount.email` doesn't match Gmail's primary alias. Check `db:studio`. |
| OAuth callback hits `localhost:3000` instead of the tunnel | You signed in via localhost; restart from the ngrok URL. |
| Push body has empty `message.data` | Gmail occasionally fires heartbeat-style pushes with no data. Webhook returns 400 → Pub/Sub retries → eventually drops. Not blocking but noisy. |

**Env hygiene after smoke:** revert `WEB_ORIGIN` to `http://localhost:3000` if you want normal-localhost dev to keep working. `GOOGLE_PUBSUB_TOPIC` / `AUDIENCE` / `SERVICE_ACCOUNT` are inert during localhost dev (the watch service only fires when you connect through the configured topic, which requires the ngrok flow) — fine to leave set.

**`AUTH_URL` recommendation:** leave unset in dev. `trustHost: true` in `authConfig` makes Auth.js use the request Host header for URL detection, which works for both localhost AND ngrok without env churn. Only set `AUTH_URL` in production deploys where you want to pin the canonical URL against Host-header spoofing.

See `TEST_CASES.md` → EMAIL-PUSH-01..06 for the full test catalog.
