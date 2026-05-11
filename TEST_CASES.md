# Quoteom — Manual Test Cases

Living document. **Add a new section whenever a feature is built.** Each test case is a self-contained checklist you can walk through to verify behavior end-to-end.

**Conventions**
- Commands assume you run them from `apps/api/` unless stated otherwise.
- Seed data: 2 orgs (`Acme Installaties` id `…001`, `Bouwbedrijf de Vries` id `…002`) and 4 users (`alice@`, `jeroen@`, `bart@`, `sander@`) — see `apps/api/prisma/seed.ts`.
- "Web app" = `http://localhost:3000`. "API" = `http://localhost:3001`.

---

## Setup (run before each feature pass)

```bash
cd apps/api
npm run db:up                          # Postgres in Docker
npm run db:migrate                     # apply latest migrations
npm run db:seed                        # 2 orgs, 4 users, 5 memberships
npm run dev                            # in this terminal — leave running
```

In a second terminal, keep cookies between requests:

```bash
COOKIES=/tmp/quoteom.cookies
```

---

## Authentication (W2.1)

### AUTH-01: Magic-link sign-in for an existing user
- [ ] Visit `http://localhost:3001/api/auth/signin` in browser.
- [ ] Enter `alice@quoteom.dev`, submit.
- [ ] **Expect** in API console: `Magic link for alice@quoteom.dev: ...` (dev mode without `RESEND_API_KEY`).
- [ ] **Or** with `RESEND_API_KEY` set: branded email arrives in Alice's inbox, "From: Quoteom <…>".
- [ ] Click the link.
- [ ] **Expect** browser redirected to `http://localhost:3000/` (web app, not API root).
- [ ] `curl -b $COOKIES http://localhost:3001/api/auth/session` returns `{ user: { id, email, name, organizationId } }`.
- [ ] `user.organizationId` matches Alice's `currentOrganizationId` (`…001` for Acme).

### AUTH-02: Self-signup is blocked (unknown email)
- [ ] Submit `nobody@example.com` at `/api/auth/signin`.
- [ ] **Expect** API console warning: `[auth] Sign-in attempted for unknown email: nobody@example.com`.
- [ ] No email sent, no `User` row created (verify in `npm run db:studio` → User table).
- [ ] Page shows generic "check your email" success (privacy — doesn't reveal nonexistence).

### AUTH-03: Sign-out
- [ ] Signed in as in AUTH-01.
- [ ] POST `http://localhost:3001/api/auth/signout` with the CSRF token from `GET /api/auth/csrf`.
- [ ] **Expect** session cookie cleared.
- [ ] Subsequent `GET /api/auth/session` returns `{}` (or `null`).

### AUTH-04: Session pins to `currentOrganizationId`
- [ ] Sign in as `sander@quoteom.dev` (member of both Acme and Bouw).
- [ ] **Expect** `user.organizationId` in session === Acme's id (`…001`, his pinned current org).
- [ ] (Future: a "switch org" mutation will let him flip to Bouw without re-auth.)

---

## Invitations (W2.2)

### INV-01: Mint an invitation via CLI
- [ ] `npm run invite -- --email newuser@example.com --org 00000000-0000-0000-0000-000000000001`
- [ ] **Expect** stdout shows `Invitation created` + the token.
- [ ] In console (dev): `Invite for newuser@example.com to Acme Installaties: http://localhost:3000/accept-invite?token=…`.
- [ ] In Prisma Studio → `Invitation` table: row exists with `email`, `organizationId`, `role: MEMBER`, `expiresAt` ~7 days out, `acceptedAt: null`.

### INV-02: Accept an invitation (new user)
- [ ] Mint as INV-01 with a fresh email.
- [ ] Copy the token. `curl -X POST -H 'Content-Type: application/json' -d '{"token":"PASTE_TOKEN"}' http://localhost:3001/api/invitations/accept`
- [ ] **Expect** response `{ userId, email, organizationId, organizationName: "Acme Installaties" }`.
- [ ] In DB: new `User` row exists for that email with `currentOrganizationId` set to Acme.
- [ ] New `Membership` row joins the user to Acme with `role: MEMBER`.
- [ ] `Invitation.acceptedAt` is now set.

### INV-03: Accept an invitation (existing user gains second membership)
- [ ] Mint invite for `bart@quoteom.dev` (Bouw owner) into Acme.
- [ ] Accept it via curl.
- [ ] **Expect** Bart's `currentOrganizationId` stays at Bouw (`…002`) — existing pin is not overwritten.
- [ ] Bart now has **two** Membership rows: original `OWNER` of Bouw + new `MEMBER` of Acme.

### INV-04: Already-accepted invitation
- [ ] Replay INV-02 with the same token.
- [ ] **Expect** HTTP 409 with `{ statusCode: 409, message: "Invitation has already been accepted" }`.

### INV-05: Expired invitation
- [ ] In Prisma Studio: set an Invitation's `expiresAt` to a past date.
- [ ] POST accept with that token.
- [ ] **Expect** HTTP 410 with `{ statusCode: 410, message: "Invitation has expired" }`.

### INV-06: Unknown token
- [ ] POST accept with `{ "token": "doesnotexist" }`.
- [ ] **Expect** HTTP 404 with `{ statusCode: 404, message: "Invitation not found" }`.

### INV-07: Validation rejects malformed token
- [ ] POST accept with `{ "token": "x" }` (too short).
- [ ] **Expect** HTTP 400 with class-validator error: `token must be longer than or equal to 32 characters`.
- [ ] POST accept with `{}` (missing field).
- [ ] **Expect** HTTP 400.

---

## Tenancy (W2.2)

### TEN-01: Tenant-scoped endpoint returns only the active org's data
- [ ] Sign in as `alice@quoteom.dev` (Acme).
- [ ] `curl -b $COOKIES http://localhost:3001/api/me/memberships`
- [ ] **Expect** response contains only memberships where `organizationId === …001` (Acme).
- [ ] Sign out, sign in as `bart@quoteom.dev` (Bouw).
- [ ] Repeat the curl.
- [ ] **Expect** response contains only memberships where `organizationId === …002` (Bouw). No overlap with Alice's response.

### TEN-02: Authenticated but no active org → 403
- [ ] In Prisma Studio: set Alice's `currentOrganizationId` to `null`.
- [ ] Re-sign in (so the JWT picks up the new value).
- [ ] `curl -b $COOKIES http://localhost:3001/api/me/memberships`
- [ ] **Expect** HTTP 403 with `{ statusCode: 403, message: "No active organization. …" }`.

### TEN-03: Unauthenticated → 401
- [ ] No cookies. `curl http://localhost:3001/api/me/memberships`
- [ ] **Expect** HTTP 401 with `{ statusCode: 401, message: "Not authenticated" }`.

---

## Logging (W2.6)

### LOG-01: Levels persist correctly
- [ ] `curl http://localhost:3001/api/hello`
- [ ] Open Prisma Studio → `Log` table.
- [ ] **Expect** exactly 3 new rows for this request: one each of `WARN`, `ERROR`, `FATAL` (the demo log calls in `AppService.getHello`).
- [ ] **Expect** the `INFO`/`DEBUG`/`VERBOSE` calls do NOT appear in the table — only console.

### LOG-02: Error stack persisted
- [ ] After LOG-01, inspect the `ERROR` row.
- [ ] **Expect** `stack` column populated with the demo stack trace.

### LOG-03: 5xx exception filters log to DB
- [ ] Trigger a server error (e.g., set `DATABASE_URL` to an invalid value temporarily and hit a Prisma route).
- [ ] **Expect** an `ERROR` row with `context: "AllExceptionsFilter"` and the stack trace.

---

## Email delivery

### MAIL-01: Magic-link email uses branded template
- [ ] With `RESEND_API_KEY` set + `RESEND_EMAIL_FROM` pointing at a verified domain (or `onboarding@resend.dev`).
- [ ] Trigger AUTH-01.
- [ ] In the recipient inbox:
  - [ ] From header reads `Quoteom <…>`.
  - [ ] Subject: `Sign in to <host>`.
  - [ ] HTML body: off-white background, slate "Sign in" button, amber link below.
  - [ ] Falling back to plain-text view shows readable plain-text copy.

### MAIL-02: Invite email uses branded template
- [ ] Trigger INV-01 with `RESEND_API_KEY` set.
- [ ] In the recipient inbox:
  - [ ] Subject: `Invitation: <Organization> on Quoteom`.
  - [ ] HTML body: heading `Welcome to <Organization>`, "Accept invitation" CTA.

### MAIL-03: Dev fallback (no API key)
- [ ] Remove `RESEND_API_KEY` from `apps/api/.env`, restart.
- [ ] Trigger AUTH-01 or INV-01.
- [ ] **Expect** the URL printed to API console; no HTTP call to Resend.

---

## Database

### DB-01: Reset + reseed
- [ ] `npm run db:up && npx prisma migrate reset --force && npm run db:seed`
- [ ] **Expect** all tables empty except seed data (2 orgs, 4 users, 5 memberships, 0 invitations, 0 logs).

### DB-02: Migration idempotency
- [ ] `npm run db:migrate` (no schema changes since last run).
- [ ] **Expect** `Already in sync, no schema change or pending migration was found.`

---

## Web — sign-in / verify-request / accept-invite (W2.3)

Pre-requisite: API running (`cd apps/api && npm run dev`) AND web running (`cd apps/web && npm run dev`). Visit `http://localhost:3000`.

### WEB-01: Anonymous home page
- [ ] Open `http://localhost:3000/` in a fresh browser / incognito.
- [ ] **Expect** "Quoteom" heading + "You're not signed in" + an "Sign in" button.
- [ ] Click "Sign in".
- [ ] **Expect** navigation to `/sign-in`.

### WEB-02: Sign-in form — happy path
- [ ] On `/sign-in`, enter `alice@quoteom.dev`.
- [ ] Click "Send magic link".
- [ ] **Expect** browser navigates to `/verify-request?email=alice@quoteom.dev`.
- [ ] **Expect** "Check your inbox" page shows Alice's email address.
- [ ] In the API console (dev) or Alice's inbox (prod): the magic link.
- [ ] Click the magic link.
- [ ] **Expect** redirect back to `http://localhost:3000/` showing "Signed in as alice@quoteom.dev" + the active org ID + an "Sign out" button.

### WEB-03: Sign-in form — validation
- [ ] On `/sign-in`, leave the email field empty, click submit.
- [ ] **Expect** inline error: `Please enter a valid email address`.
- [ ] Enter `not-an-email`, submit.
- [ ] **Expect** same inline error. No request to the API.

### WEB-04: Sign-out
- [ ] Signed in as in WEB-02.
- [ ] Click "Sign out" on the home page.
- [ ] **Expect** the page re-renders to the anonymous view (no full reload needed — TanStack Query invalidates the session cache).
- [ ] Refresh the page; **expect** still anonymous (cookie was actually cleared).

### WEB-05: Accept-invite page — happy path (new user)
- [ ] Mint an invite for a fresh email: `npm run invite -- --email newperson@example.com --org 00000000-0000-0000-0000-000000000001` (from `apps/api/`).
- [ ] Grab the URL from the dev console (or inbox).
- [ ] Open the URL in browser. URL shape: `http://localhost:3000/accept-invite?token=...`.
- [ ] **Expect** brief "Accepting invitation..." spinner, then:
  - "Welcome to Acme Installaties" heading.
  - "Your account has been created. Sign in to continue."
  - "Sign in" button.
- [ ] Click "Sign in" → goes to `/sign-in`.

### WEB-06: Accept-invite page — already-accepted
- [ ] Replay WEB-05 with the same token (e.g., open the same URL again).
- [ ] **Expect** error alert: "This invitation has already been accepted."

### WEB-07: Accept-invite page — bad token
- [ ] Visit `http://localhost:3000/accept-invite?token=doesnotexist`.
- [ ] **Expect** error alert: "This invitation doesn't exist."

### WEB-08: Accept-invite page — missing token
- [ ] Visit `http://localhost:3000/accept-invite` (no `?token=`).
- [ ] **Expect** TanStack Router validation rejects the search params (currently 404 or error boundary). Future: friendly empty-state page.

---

## Billing (Stripe)

> **Setup once:**
> 1. Stripe CLI logged in: `stripe login`.
> 2. Local webhook forwarding running in a separate terminal: `stripe listen --forward-to localhost:3001/api/billing/webhook`.
> 3. Copy the `whsec_…` printed by `stripe listen` into `apps/api/.env` as `STRIPE_WEBHOOK_SECRET` and restart the API.
> 4. `STRIPE_SECRET_KEY` set to a **test mode** key; `STRIPE_PRICE_ID` set to a recurring EUR price (lookup_key `quoteom_monthly_eur`).
> 5. In the Stripe Dashboard's Customer Portal settings, enable: update payment method, cancel subscription, view invoices.

### BILLING-01: Happy path — subscribe with `4242 4242 4242 4242`
- [ ] Sign in as an org owner; navigate to `/billing`.
- [ ] Click **Subscribe** → redirected to Stripe Checkout (URL starts with `https://checkout.stripe.com/`).
- [ ] Confirm the page shows **EUR**, a **14-day trial**, and offers card + iDEAL + SEPA (assuming Dashboard configured).
- [ ] Pay with card `4242 4242 4242 4242`, any future expiry, any CVC, any postal code.
- [ ] **Expect** redirect to `/billing/success?session_id=...`; spinner shows "Confirming your subscription…" then "You're all set".
- [ ] **Expect** `stripe listen` shows `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` events all forwarded with `[200]`.
- [ ] **Expect** in the DB: `Subscription.status = 'trialing'`, `stripeSubscriptionId` populated, `currentPeriodStart`/`currentPeriodEnd` set ~14 days apart, `paymentMethodBrand = 'card'`, `paymentMethodLast4 = '4242'`.
- [ ] Reload `/billing` → page now shows the **Manage subscription** state (not Subscribe).

### BILLING-02: Customer Portal access
- [ ] On `/billing` (post BILLING-01), click **Manage subscription**.
- [ ] **Expect** redirect to `https://billing.stripe.com/p/session/...`; page lists current subscription, payment method ending in 4242, upcoming invoice.
- [ ] Click the back link → returns to `/billing` on the web app.

### BILLING-03: Webhook signature verification rejects forgeries
- [ ] In a terminal: `curl -i -X POST http://localhost:3001/api/billing/webhook -H "Content-Type: application/json" -H "stripe-signature: t=1,v1=bogus" -d '{"id":"evt_test","type":"customer.subscription.updated"}'`.
- [ ] **Expect** HTTP `400`; body contains "Invalid Stripe signature".
- [ ] **Expect** no DB writes — `Subscription` row for the org is unchanged (check `updatedAt`).

### BILLING-04: Failed payment via Stripe CLI trigger
- [ ] With `stripe listen` running, run: `stripe trigger payment_intent.payment_failed`.
- [ ] **Expect** the CLI shows `payment_intent.payment_failed` and `charge.failed` forwarded with `[200]`.
- [ ] **Expect** API logs include `Event payment_intent.payment_failed has no customer id — skipping` OR a sync log if the synthetic intent has a customer. (Trigger uses an ephemeral test customer, so most likely the skip path — that's correct behavior.)
- [ ] **Variant (subscription-attached failure):** in Dashboard, create a test customer with subscription, attach card `4000 0000 0000 0341` (always fails) via Portal, wait for the next invoice retry (or force one via `stripe trigger invoice.payment_failed --override invoice:customer=cus_XXX`).
- [ ] **Expect** the org's `Subscription.status` flips to `past_due` after sync.

### BILLING-05: Stale customer self-healing
- [ ] In Stripe Dashboard (test mode), find the org's customer and **delete** it.
- [ ] On `/billing`, click **Subscribe** again.
- [ ] **Expect** API logs include `Stripe customer cus_… no longer exists — recreating`.
- [ ] **Expect** Checkout still opens normally; DB `Subscription.stripeCustomerId` now points to a fresh `cus_…` and all sync-derived fields are cleared back to defaults (`status = null`, no `stripeSubscriptionId`).

### BILLING-06: Trial-end transition via Stripe test clock
- [ ] In Dashboard → Developers → Test Clocks, create a clock at "now". Create a customer attached to the clock, then run BILLING-01's checkout against that customer (advanced: requires manually building a Checkout session against the clock-bound customer, or use Stripe API directly).
- [ ] Advance the clock by **15 days**.
- [ ] **Expect** `stripe listen` shows `customer.subscription.trial_will_end` (3 days before end) and then `customer.subscription.updated` with `status: 'active'` after the trial expires.
- [ ] **Expect** DB `Subscription.status` transitions `trialing → active` and `currentPeriodEnd` jumps to ~30 days after trial end.

### BILLING-07: Cancellation via Customer Portal
- [ ] On `/billing` → **Manage subscription** → in Portal, click **Cancel subscription** → confirm "at period end".
- [ ] **Expect** `stripe listen` shows `customer.subscription.updated` with `cancel_at_period_end: true`.
- [ ] **Expect** DB `Subscription.cancelAtPeriodEnd = true`, status still `trialing` or `active` (cancellation is scheduled, not immediate).
- [ ] **Resume:** in Portal, click **Renew subscription** → DB `cancelAtPeriodEnd` flips back to `false` via the next `customer.subscription.updated` webhook.

### BILLING-08: 3DS authentication required
- [ ] Run BILLING-01 with card `4000 0027 6000 3184` (requires 3DS).
- [ ] **Expect** Stripe Checkout shows a 3DS challenge frame. Approve.
- [ ] **Expect** the rest of the flow matches BILLING-01.

### BILLING-09: Generic card decline
- [ ] Run BILLING-01 with card `4000 0000 0000 0002` (generic decline).
- [ ] **Expect** Stripe Checkout displays "Your card was declined."; no redirect happens. No `Subscription.status` write.

### BILLING-10: Eager sync race vs. webhook
- [ ] In BILLING-01, watch the API logs: the `POST /api/billing/sync` from `/billing/success` and the webhook-driven `syncFromStripe` will run within a second of each other.
- [ ] **Expect** both succeed; final DB state is identical regardless of which won (the function is idempotent).

---

## How to maintain this doc

- **Adding a feature** → add a new `## Section` with `### XXX-01:` test cases. Use a short uppercase prefix per area (`AUTH`, `INV`, `TEN`, `LOG`, `MAIL`, `DB`, `WEB`, `BILLING`, then `OPP` for opportunities, `QUO` for quotes, etc.).
- **Removing a feature** → strike through the section, delete after a week if no regression.
- **A test reveals a bug** → don't delete the test case after fixing; future regressions need it.
- **Keep it executable** — every test case should be a thing the reader can copy-paste and run, not prose.
