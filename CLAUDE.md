# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Quoteom — AI offerte management for Dutch SMBs. Reads inbox + WhatsApp, extracts quote requests, drafts replies in the owner's tone, generates quote PDFs, tracks deadlines / expiry / follow-ups.

Solo 14-week MVP build. The build plan lives at `~/.claude/plans/toasty-herding-giraffe.md` (week-by-week with status markers + decisions/deviations). The reference test catalog is `TEST_CASES.md` (one entry per behavior we need to verify before shipping).

## Stack at a glance

- **Monorepo**: Turborepo + npm workspaces. Node 22+, npm 10+.
- **Web**: TanStack Start (React 19, Vite 7) + MUI v9 + TanStack Query v5. SSR-first.
- **API**: NestJS 11 (Express + CommonJS, plain `tsc`) + Prisma 7 (`prisma-client` generator + `@prisma/adapter-pg`) + Postgres 16 (Docker locally).
- **Auth**: Auth.js v5 mounted as Express middleware at `/api/auth/*` (magic link via Resend + Google + Microsoft Entra). JWT sessions.
- **Billing**: Stripe (API version `2026-04-22.dahlia` pinned) with graduated tiered pricing.
- **Deploy target**: DigitalOcean App Platform EU (not wired yet; W1.5 carryover).

## Commands

Run from repo root unless specified. All scripts are turbo-orchestrated:

```bash
npm install                        # bootstrap workspaces
npm run dev                        # api + web in watch mode
npm run typecheck                  # tsc --noEmit across both apps
npm run lint                       # eslint
npm run format                     # prettier --write
npm run test                       # runs jest (api) + vitest (web)
```

API-specific (in `apps/api/`):

```bash
npm run db:up                      # docker compose: local Postgres
npm run db:down
npm run db:migrate                 # prisma migrate dev
npm run db:deploy                  # prisma migrate deploy (prod)
npm run db:generate                # regen Prisma client into src/generated/prisma/
npm run db:studio
npm run db:seed                    # prisma db seed (runs prisma/seed.ts via tsx)
npm run dev                        # nest start --watch
npm run invite -- --email a@b.com --org <uuid> [--role MEMBER|OWNER|EXTERNAL]
```

Web-specific (in `apps/web/`):

```bash
npm run dev                        # vite dev (port 3000, proxies /api → 3001)
npm run build                      # vite build (.output/)
npm run start                      # node .output/server/index.mjs
npm run test                       # vitest run
```

Single test runs:

```bash
# API (Jest)
cd apps/api && npx jest src/modules/billing/billing.service.spec.ts
cd apps/api && npx jest -t "syncFromStripe clears state"

# Web (Vitest)
cd apps/web && npx vitest run src/lib/utils/foo.test.ts
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
npm run dev                                              # API + web

# Terminal 2
npx inngest-cli@latest dev                               # discovers /api/inngest
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
