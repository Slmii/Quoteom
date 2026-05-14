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
pnpm db:up                          # Postgres in Docker
pnpm db:migrate                     # apply latest migrations
pnpm db:seed                        # 2 orgs, 4 users, 5 memberships
pnpm dev                            # in this terminal — leave running
```

In a second terminal, keep cookies between requests:

```bash
COOKIES=/tmp/quoteom.cookies
```

---

## Authentication (W2.1)

### AUTH-ENC-01: OAuth tokens encrypted at rest in `Account` rows
- [ ] Sign in via Google (with `GOOGLE_CLIENT_ID/SECRET` set). The `Account` row is created.
- [ ] Inspect the row (Prisma Studio or `SELECT * FROM "Account"`): `access_token`, `refresh_token`, `id_token` columns should start with `v1:` and contain base64 ciphertext — **not** the plain JWT/opaque-token shape.
- [ ] In a Node REPL: `import { decrypt } from '@/lib/crypto/token-encryption'; decrypt('v1:...')` returns the plaintext.
- [ ] Tamper with one column (`UPDATE "Account" SET refresh_token = 'v1:tampered' WHERE …;`) → `decrypt(...)` throws (GCM auth tag fails).
- [ ] Run `npx jest src/lib/crypto/token-encryption.spec.ts` → 9 tests pass.
- [ ] Boot the API with `TOKEN_ENCRYPTION_KEY` unset → `ConfigModule` rejects startup with a clear "must be 64 hex chars" message.

### AUTH-01: Magic-link sign-in for an existing user
- [ ] Visit `http://localhost:3001/api/auth/signin` in browser.
- [ ] Enter `alice@quoteom.dev`, submit.
- [ ] **Expect** in API console: `Magic link for alice@quoteom.dev: ...` (dev mode without `RESEND_API_KEY`).
- [ ] **Or** with `RESEND_API_KEY` set: branded email arrives in Alice's inbox, "From: Quoteom <…>".
- [ ] Click the link.
- [ ] **Expect** browser redirected to `http://localhost:3000/` (web app, not API root).
- [ ] `curl -b $COOKIES http://localhost:3001/api/auth/session` returns `{ user: { id, email, name, organizationId } }`.
- [ ] `user.organizationId` matches Alice's `currentOrganizationId` (`…001` for Acme).

### AUTH-SIGNUP-01: Self-signup creates User + Organization + OWNER Membership
- [ ] Visit `http://localhost:3000/sign-up`. Fill `Company name = "Sometestbedrijf BV"` and `Email = new-owner@example.com`. Submit.
- [ ] **Expect** UI redirects to `/verify-request?email=new-owner@example.com`.
- [ ] **Expect** in API console: `Magic link for new-owner@example.com: …` (dev mode without Resend).
- [ ] **Expect** in DB: a new `Organization` row with `name = "Sometestbedrijf BV"`; a new `User` row with `email = new-owner@example.com` (lowercased) and `currentOrganizationId` pointing at the new org; a `Membership` row with `role = OWNER` linking them.
- [ ] Click the magic link → land on `/` → home page shows "Active organization: Sometestbedrijf BV" (single-org user, no switcher).

### AUTH-SIGNUP-02: Duplicate email rejected
- [ ] After AUTH-SIGNUP-01 succeeds: try to sign up *again* with the same email.
- [ ] **Expect** HTTP 409 from `POST /api/signup` with `message: "An account with this email already exists. Sign in instead."`; UI shows error Alert.
- [ ] No second Organization or User row is created.

### AUTH-SIGNUP-03: Validation rejects bad inputs
- [ ] Submit `Email = "not-an-email"` → class-validator returns `email must be an email`; UI shows the error inline.
- [ ] Submit `Company name = "X"` (1 char) → returns `Company name must be at least 2 characters`.
- [ ] Submit `Company name = ""` empty → validation rejects.

### AUTH-SIGNUP-05: Disposable email is rejected at the DTO layer
- [ ] On `/sign-up`, submit `Email = "burner@mailinator.com"` (or any throwaway domain — `10minutemail.com`, `tempmail.org`, etc.).
- [ ] **Expect** HTTP 400 from `POST /api/signup` with class-validator message `Disposable email addresses are not allowed. Please use a work email.`
- [ ] **Expect** no `User` or `Organization` row created.
- [ ] Real corporate email (e.g. `@quoteom.com`) passes through to the happy path (AUTH-SIGNUP-01).

### AUTH-SIGNUP-06: Signup is rate-limited to 5 per IP per hour
- [ ] From one client (one IP), submit 5 unique-email signups in a row. All succeed.
- [ ] On the 6th attempt within the same hour: **expect** HTTP 429 (`Too Many Requests`) with a `Retry-After` header indicating when to retry.
- [ ] No 6th `User` or `Organization` is created.
- [ ] After the TTL window (1 hour), the counter resets and signup works again.
- [ ] **Verify proxy header handling:** behind a load balancer (App Platform / nginx / cloudflare), throttling counts per **`X-Forwarded-For`** IP, not the LB's IP. Test by sending requests with different `X-Forwarded-For` values from a single TCP connection — each should have its own counter. (`trust proxy: 1` is set in `main.ts`.)

### AUTH-SIGNUP-07: Stripe webhook is exempt from rate limiting
- [ ] `for i in {1..120}; do stripe trigger payment_intent.succeeded; done` (or similar burst).
- [ ] **Expect** the webhook handler 200s every one — no 429. Confirmed via `@SkipThrottle()` decorator on `POST /api/billing/webhook`.

### AUTH-SIGNUP-04: OAuth providers stay sign-in-only
- [ ] With `GOOGLE_CLIENT_ID` set, click "Sign in with Google" using a Google account that has **no** existing `User` row in our DB.
- [ ] **Expect** server log warning + Auth.js error redirect to `/sign-in?error=...` (Auth.js's `createUser` throws `SELF_SIGNUP_DISABLED`). OAuth is for already-provisioned users only.
- [ ] To onboard a new Google-only user: they must first signup via the form (using their Google email), then the next sign-in via Google links the OAuth provider to the existing User row.

### AUTH-02: Self-signup is blocked (unknown email)
- [ ] Submit `nobody@example.com` at `/api/auth/signin`.
- [ ] **Expect** API console warning: `[auth] Sign-in attempted for unknown email: nobody@example.com`.
- [ ] No email sent, no `User` row created (verify in `pnpm db:studio` → User table).
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
- [ ] `pnpm invite --email newuser@example.com --org 00000000-0000-0000-0000-000000000001`
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

### INV-08: Create invitation via UI (`/team`)
- [ ] Sign in as an org owner with ≤ `SEATS_INCLUDED - 1` existing seats.
- [ ] Navigate to `/team` → fill the email field → click **Send invite**.
- [ ] **Expect** HTTP 200; success Alert appears; email arrives via Resend (or magic-link-style fallback log in dev); the row shows up under **Pending invitations**; billing status panel's seats count includes the pending invite.
- [ ] **Expect** `GET /api/invitations` returns the new invitation in the JSON list.

### INV-09: Validation rejects bad email
- [ ] On `/team`, submit `not-an-email` as the address.
- [ ] **Expect** HTTP 400 from `POST /api/invitations` with class-validator error: `email must be an email`; UI shows the error in an error Alert.

### INV-10: Revoke a pending invitation
- [ ] On `/team`, click the **×** button next to a pending invitation.
- [ ] **Expect** HTTP 204; row disappears from the list on the next refetch; the `Invitation` table no longer has the row (deleted, not just marked).
- [ ] Calling DELETE on a non-existent / cross-org invitation returns 404 (`INVITATION_NOT_FOUND`).
- [ ] Calling DELETE on an already-accepted invitation returns 409 (`INVITATION_ALREADY_ACCEPTED`).

### INV-12: Reject invite to an existing member
- [ ] Org has Alice as an active member. From `/team`, try to invite `alice@example.com` again.
- [ ] **Expect** HTTP 409 with message `This person is already a member of the organization`; UI shows the error in an error Alert.
- [ ] Try with `ALICE@example.com` (different case) → same 409 (comparison is case-insensitive).

### INV-17: Owner with no entitlement can't invite (canceled / expired / unpaid)
- [ ] As the owner of an org where `Subscription.status = 'canceled'` (e.g. ran BILLING-07b or `stripe subscriptions cancel`), navigate to `/team`.
- [ ] **Expect** the invite form is **not** rendered. Instead a warning Alert shows: `Your subscription has been canceled. Subscribe again to invite teammates.` with a **Subscribe** action button linking to `/billing`.
- [ ] Repeat with `status` set in psql to each of `expired`, `unpaid`, `paused`, `incomplete`, `incomplete_expired` → the banner copy matches the state (see `billingBlockedCopy` in `team.tsx`).
- [ ] Revoke (×) button on existing pending invitations is **hidden** when not entitled — matches the backend, which 402s revoke via `@OwnerWrite()` → `EntitlementGuard`. Owner must resubscribe before cleaning up dangling invites.
- [ ] As a non-owner in the same canceled org: same "Only the organization owner can invite teammates" caption, no banner (the entitlement copy is owner-targeted).

### INV-16: Only owners can create or revoke invitations
- [ ] Sign in as a `MEMBER` of an org. Visit `/team`.
- [ ] **Expect** the page loads (memberships + pending invitations + status all visible).
- [ ] **Expect** the "Invite a teammate" section is replaced by a caption: `Only the organization owner can invite teammates.`
- [ ] **Expect** pending invitations have no revoke (×) button when rendered for a non-owner.
- [ ] `curl -i -X POST http://localhost:3001/api/invitations -b cookies-of-member.txt -H "Content-Type: application/json" -d '{"email":"x@y.com"}'` → HTTP **403** (`OWNER_ROLE_REQUIRED`).
- [ ] `curl -i -X DELETE http://localhost:3001/api/invitations/<id> -b cookies-of-member.txt` → HTTP **403**.
- [ ] `GET /api/invitations` (list) still returns **200** for members — read access stays open.
- [ ] Repeat as the OWNER: invite form is rendered, revoke buttons are clickable, both POST + DELETE succeed.

### INV-15: Email is normalized to lowercase on invitation create + accept
- [ ] From `/team`, invite `John.Doe@Example.com` (mixed case).
- [ ] **Expect** the `Invitation` row stores `email = 'john.doe@example.com'`; UI pending list shows the lowercased form.
- [ ] Recipient clicks the link → accept → **expect** `User.email = 'john.doe@example.com'` (lowercased, no mixed-case row created).
- [ ] **Legacy data**: if a `User` row already exists with `email = 'John.Doe@Example.com'` (created before this normalization landed), accepting an invitation for `john.doe@example.com` should find the existing user (case-insensitive lookup), not throw `Unique constraint failed on (email)`.
- [ ] Invite the same address twice in different casings → 409 `INVITATION_ALREADY_PENDING` (the duplicate check is case-insensitive).

### INV-14: Reject OWNER role on invitation (DTO + service)
- [ ] On `/team`, confirm the role dropdown shows only **Member** and **External** (no Owner option).
- [ ] Via curl: `curl -X POST http://localhost:3001/api/invitations -b cookies.txt -H "Content-Type: application/json" -d '{"email":"new@example.com","role":"OWNER"}'`.
- [ ] **Expect** HTTP 400 with class-validator message `Owner role cannot be assigned via invitation — every organization has exactly one owner` (from `OWNER_ROLE_NOT_INVITABLE`).
- [ ] Garbage role like `"role":"SUPERADMIN"` → 400 with `@IsEnum` generic message ("role must be one of the following values: …").

### INV-13: Reject invite when a pending invitation already exists for that email
- [ ] Org sent an invite to `pending@example.com` 10 minutes ago (still un-accepted, un-expired). Try to invite the same address again.
- [ ] **Expect** HTTP 409 with message `An invitation for this email is already pending`; UI shows the error Alert.
- [ ] Revoke the pending invitation → re-inviting the same address now succeeds (HTTP 200).
- [ ] Backdate the original invitation's `expiresAt` to a past date → re-inviting the same address succeeds (expired invitations don't block).

### INV-11: Pending invitations list is tenant-scoped
- [ ] As Acme org owner, `curl -b $COOKIES http://localhost:3001/api/invitations`.
- [ ] **Expect** only Acme's pending (un-accepted, un-expired) invitations.
- [ ] Switch the active org or sign in as a different tenant → list contains none of Acme's invitations.

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

### TEN-04: Switch organization for multi-org user
- [ ] Seed a user with memberships in two orgs (Acme + BetaCo). Sign in.
- [ ] `GET /api/me/organizations` → returns 2 rows, ordered by `createdAt asc`.
- [ ] `GET /api/me/membership` → returns the membership of the **current** active org (Acme by default).
- [ ] On the home page, an "Active organization" dropdown is rendered (only when ≥2 orgs); current value is Acme.
- [ ] Pick BetaCo from the dropdown → mutation hits `POST /api/me/switch-organization { organizationId: <BetaCo-uuid> }` → 200.
- [ ] **Expect** every query cache is wiped (`queryClient.clear()`) and the router invalidates → all loaders refetch.
- [ ] **Expect** `GET /api/me/membership` now returns BetaCo's row. `GET /api/me/memberships` returns BetaCo's teammates.
- [ ] **Expect** the `OrganizationGuard` reads `User.currentOrganizationId` fresh from DB on every request — no JWT refresh needed, no sign-in/out cycle.

### TEN-05: Switch to an org the user isn't a member of → 404
- [ ] As an Acme-only user: `curl -X POST -H "Content-Type: application/json" -b cookies.txt -d '{"organizationId":"<some-other-org-uuid>"}' http://localhost:3001/api/me/switch-organization`.
- [ ] **Expect** HTTP 404 with message `Membership not found in the active organization` (reuses `MEMBERSHIP_NOT_FOUND` — 404 is also defensible because it doesn't reveal whether the target org exists).
- [ ] DB `User.currentOrganizationId` is unchanged.

### TEN-06: Single-org user — no switcher renders
- [ ] Sign in as a user with exactly one membership.
- [ ] **Expect** the home page shows "Active organization: **Acme**" as plain text (no dropdown). `me.organization.name` comes from `/api/me/membership`.

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
- [ ] `pnpm db:up && npx prisma migrate reset --force && pnpm db:seed`
- [ ] **Expect** all tables empty except seed data (2 orgs, 4 users, 5 memberships, 0 invitations, 0 logs).

### DB-02: Migration idempotency
- [ ] `pnpm db:migrate` (no schema changes since last run).
- [ ] **Expect** `Already in sync, no schema change or pending migration was found.`

---

## Web — sign-in / verify-request / accept-invite (W2.3)

Pre-requisite: API running (`cd apps/api && pnpm dev`) AND web running (`cd apps/web && pnpm dev`). Visit `http://localhost:3000`.

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
- [ ] Mint an invite for a fresh email: `pnpm invite --email newperson@example.com --org 00000000-0000-0000-0000-000000000001` (from `apps/api/`).
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

### BILLING-07: Cancellation via Customer Portal (scheduled at period end)
- [ ] On `/billing` → **Manage subscription** → in Portal, click **Cancel subscription** → confirm "at period end".
- [ ] **Expect** `stripe listen` shows `customer.subscription.updated` with `cancel_at_period_end: true`.
- [ ] **Expect** DB `Subscription.cancelAtPeriodEnd = true`, status still `trialing` or `active` (cancellation is scheduled, not immediate).
- [ ] **Expect** `/billing` UI: status chip unchanged; orange "Cancellation scheduled for {date}" Alert appears.
- [ ] **Resume:** in Portal, click **Renew subscription** → DB `cancelAtPeriodEnd` flips back to `false` via the next `customer.subscription.updated` webhook; the Alert disappears on next status fetch.

### BILLING-07b: Immediate cancellation via Stripe Dashboard
- [ ] In Stripe Dashboard (test mode), open the customer → click **Cancel subscription** → leave the "Cancel at end of billing period" checkbox **unchecked** → confirm.
- [ ] **Expect** `stripe listen` shows `customer.subscription.deleted`.
- [ ] **Expect** DB `Subscription.status = 'canceled'`, `cancelAtPeriodEnd = false` (the field resets — there is no "scheduled" cancellation, it's already applied), `stripeSubscriptionId` still populated until the next `syncFromStripe` finds zero subscriptions.
- [ ] **Expect** `/billing` UI: red "Inactive" chip, "Subscription canceled." primary line, Subscribe button visible, **no** orange banner (the cancellation isn't scheduled — it's done).
- [ ] **Common confusion:** `cancelAtPeriodEnd` only means "a cancel is queued but not yet applied". Once Stripe applies the cancel (immediate cancel, or auto-apply at period end), the field is `false`. Don't add a banner for `status='canceled'`; the chip + line already communicate it.

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

### BILLING-11: Entitlement gate — fresh org, no Subscription row
- [ ] Create a brand-new org via self-signup. Do **not** click Subscribe.
- [ ] **Expect** `GET /api/billing/status` returns `state: 'none'`, `currentPeriodEnd: null`. No Subscription row exists.
- [ ] Hit any tenant write route protected by `@TenantWrite()` (e.g. `POST /api/invitations`).
- [ ] **Expect** HTTP `402` with body `{ statusCode: 402, code: 'billing_required', message: 'Your trial has ended. Subscribe to continue.', billingPath: '/billing' }`. The only path to write entitlement is Stripe Checkout.
- [ ] **Expect** any **read** route on the same org still returns 200 (e.g. `GET /api/me/memberships`, `GET /api/billing/status`).
- [ ] On the web client, calling a write mutation against this org auto-redirects the browser to `/billing`.
- [ ] `/billing` UI shows: chip **"No plan"**, primary line **"You haven't started your trial yet."**, single CTA button **"Start your 14-day free trial"**, no Manage button.

### BILLING-12: Entitlement gate — entitled via Stripe subscription
- [ ] Complete BILLING-01 so `Subscription.status = 'trialing'`.
- [ ] Hit the same write route.
- [ ] **Expect** HTTP 2xx. Stripe-managed entitlement (`trialing | active | past_due`) is the only path to writes.

### BILLING-13: Entitlement gate — Stripe subscription canceled
- [ ] Complete BILLING-07 (cancel via Portal) and wait until the period ends (or force via test clock + advance).
- [ ] **Expect** `Subscription.status` flips to `canceled` after the webhook syncs.
- [ ] Hit the write route → HTTP `402`. **There is no local-grace re-engagement** — once an org has been through Checkout, the only way back to write access is a new Checkout / Portal renewal.

### BILLING-15: Entitlement gate — past_due grace
- [ ] Set `Subscription.status = 'past_due'` in psql (simulating a failed retry).
- [ ] Hit the write route.
- [ ] **Expect** HTTP 2xx. Stripe dunning is handling the retry; we don't lock the customer out mid-retry.

### BILLING-16: Per-seat — invite within included tier
- [ ] Fresh org with 1 member (owner). Run BILLING-01 → status `trialing`, Stripe sub `quantity = 1`.
- [ ] Send 2 invitations and accept both → org now has 3 active memberships.
- [ ] **Expect** `stripe listen` shows `customer.subscription.updated` events on each accept (quantity bumps).
- [ ] **Expect** in Stripe Dashboard: subscription `quantity` = 3.
- [ ] **Expect** Stripe upcoming invoice: 1 × tier-1 line item = €149.00 (no overage line). Verify via `stripe invoices upcoming --subscription <sub_id>`.
- [ ] **Expect** `/billing` UI shows "Seats: 3 used · 3 included in base price" with no overage line.

### BILLING-17: Per-seat — invite past included tier
- [ ] Continuing from BILLING-16 (org at 3 seats). Send + accept a 4th invitation.
- [ ] **Expect** `stripe listen` shows another `customer.subscription.updated`; Stripe sub `quantity = 4`.
- [ ] **Expect** Stripe upcoming invoice shows two line items: tier-1 flat €149.00, tier-2 1 × €30.00 = €30.00, plus a proration credit/charge for the partial period.
- [ ] **Expect** `/billing` UI shows "Seats: 4 used · 3 included" + "1 extra seat × €30/mo = €30/mo overage".
- [ ] Add a 5th member → overage line becomes "2 extra seats × €30/mo = €60/mo overage".

### BILLING-18: Per-seat — seat sync during trialing
- [ ] During the 14-day Stripe trial (BILLING-01), invite a 4th member.
- [ ] **Expect** `stripe listen` shows `customer.subscription.updated` with `quantity: 4`, **no** invoice yet (still trialing).
- [ ] **Expect** advancing past the trial end via test clock: the first real invoice charges €149 base + €30 overage = €179 (plus tax if applicable).

### BILLING-19: Per-seat — pre-Checkout invitations are blocked outright
- [ ] Brand-new org, never hit Checkout (state `'none'`). Try to send an invitation.
- [ ] **Expect** HTTP 402 `billing_required` from `EntitlementGuard` — the request never reaches `syncSeatCount`. No Stripe API calls; no Invitation row created.
- [ ] **Expect** `/billing` UI seats line reads `"Seats: 1 used · 3 included in base price — Start your trial to invite teammates…"`.

### BILLING-OWNER-01: Non-owners cannot access billing actions
- [ ] Sign in as a `MEMBER` (or `EXTERNAL`) of an org.
- [ ] **Expect** home page: no **Billing** button (only **Team** + **Sign out**).
- [ ] Manually navigate to `/billing` → TanStack Router `beforeLoad` redirects to `/`.
- [ ] `curl -i http://localhost:3001/api/billing/status -b cookies-of-member.txt` → HTTP **200** (status is read-only and any member can see trial countdown / seat usage on `/team`).
- [ ] `curl -i -X POST http://localhost:3001/api/billing/checkout-session -b cookies-of-member.txt` → HTTP **403** from `OwnerGuard` with message `Only the organization owner can access this resource`.
- [ ] Same 403 for `POST /api/billing/{portal-session,sync}`.
- [ ] Webhook (`POST /api/billing/webhook`) remains unauthenticated — Stripe signature alone gates it.
- [ ] On `/team` as a non-owner with the org at trial seat cap: the alert shows **"Ask your owner to subscribe"** (no Subscribe button); owners see the **Subscribe** action button.

### BILLING-PORTAL-01: Portal button relabeled for terminal states
- [ ] On `/billing` with `Subscription.status = 'active'` or `'trialing'`: button reads **"Manage subscription"**.
- [ ] Cancel the sub immediately (BILLING-07b) → status flips to `canceled`. Button now reads **"View past invoices"** (no active sub to manage, only invoice history).
- [ ] Same for `unpaid` and `incomplete_expired` (force via psql).
- [ ] For `'none'`: the Portal/Manage button is hidden entirely (no Stripe customer yet). Only the **"Start your 14-day free trial"** CTA shows.

### BILLING-PORTAL-02: Cancellation banner has a one-click Resume action
- [ ] As owner with active sub: open Customer Portal → "Cancel subscription" → confirm "at period end".
- [ ] **Expect** DB: `cancelAtPeriodEnd = true`, `status` still `active`.
- [ ] **Expect** `/billing` status panel shows a warning Alert: *"Cancellation scheduled for {date}. Resume your subscription before then to keep access."* with a **Resume** button on the right.
- [ ] Click **Resume** → opens Customer Portal directly (no scroll to find the main Manage button).
- [ ] In Portal, click "Renew subscription" → webhook fires → `cancelAtPeriodEnd` flips to `false` → banner disappears on next status refetch.

### BILLING-OWNER-02: Owner can access billing
- [ ] Sign in as the org `OWNER`. Home page shows the Billing button. Visit `/billing` → loads normally.
- [ ] `curl -i http://localhost:3001/api/billing/status -b cookies-of-owner.txt` → HTTP 200 with the full status DTO.

### BILLING-22: Trial seat cap — block invites past included tier (during Stripe trial)
- [ ] Fresh org, run BILLING-01 to enter `trialing`. Owner = 1 active member.
- [ ] Invite teammate 1 (2 members total once accepted) → succeeds.
- [ ] Invite teammate 2 (3 members) → succeeds.
- [ ] Send a 3rd invitation (4th seat) → **expect** HTTP 402 with body `{ statusCode: 402, code: 'trial_seat_limit', message: 'Trial accounts are limited to 3 seats. Subscribe to invite more teammates.', billingPath: '/billing' }`.
- [ ] **Expect** no `Invitation` row created; no email sent.
- [ ] **Expect** `/billing` UI seats line reads "3 used · 3 max during trial — Trial seat limit reached. Subscribe to invite more teammates."

### BILLING-23: Trial seat cap — pending invitations count toward the cap
- [ ] Org in `trialing`, owner = 1 active member. Send 2 invitations but **do not accept** them yet.
- [ ] Send a 3rd invitation → **expect** HTTP 402 `trial_seat_limit` (1 active + 2 pending = 3, at cap).
- [ ] **Expect** `/billing` UI still shows `seats.used = 1` (UI only counts accepted memberships) but the API correctly enforces the combined count.

### BILLING-24: Seat cap lifts at `active`
- [ ] Continuing from BILLING-22 (org at 3 seats, `trialing`), use a Stripe test clock to advance past trial end → status webhook flips to `active`.
- [ ] Send a 4th invitation → **expect** HTTP 200; invitation row created; on accept, `syncSeatCount` bumps Stripe quantity to 4 and the next invoice carries a €30 proration line.
- [ ] **Expect** `/billing` UI now shows "1 extra seat × €30/mo = €30/mo overage" instead of the trial seat-cap copy.

### BILLING-25: Trial seat cap — expired pending invites don't count
- [ ] Set up an org with 2 active members + 1 invitation whose `expiresAt < NOW()` (manually backdate via psql).
- [ ] Send a new invitation → **expect** HTTP 200 (2 active + 0 valid pending = 2, below cap of 3). Expired invitations are correctly excluded from the budget.

### BILLING-21: One live subscription per org (defensive backend check)
- [ ] Complete BILLING-01 so the org has `status = 'trialing'`.
- [ ] In a terminal: `curl -i -X POST http://localhost:3001/api/billing/checkout-session -b "auth-cookie-jar.txt"` (or replay the request from DevTools Network with the UI button hidden).
- [ ] **Expect** HTTP `409 Conflict` with body containing `"Organization already has an active subscription (trialing). Use the Customer Portal to manage it."`.
- [ ] **Expect** Stripe Dashboard: **no** new subscription created on the customer; the existing one stands alone.
- [ ] Repeat with `status` manually set in psql to each of `active`, `past_due`, `paused`, `incomplete` — same 409 response.
- [ ] Manually set `status = 'canceled'` → Checkout proceeds (canceled isn't a live state, customer can re-subscribe).

### BILLING-20: Per-seat — sync skipped after cancellation
- [ ] Run BILLING-07b (immediate Dashboard cancel) → status `canceled`.
- [ ] Invite + accept a new member.
- [ ] **Expect** no Stripe API calls (`SEAT_SYNC_STATUSES` excludes `canceled`); API logs do not include a "Seat sync" line.
- [ ] **Expect** `/billing` shows "Seats: N used · 3 included" using the local membership count, regardless of Stripe state.

---

## Gmail / inbox connection (W3.1)

Setup once: in Google Cloud Console, register an OAuth client with TWO authorized redirect URIs — `http://localhost:3000/api/auth/callback/google` (sign-in) and `http://localhost:3000/api/email/gmail/callback` (this feature). Paste the client ID + secret into `apps/api/.env`. Enable the Gmail API for the project.

### EMAIL-01: Happy path — owner connects Gmail and sees 10 messages
- [ ] Sign in as the org `OWNER`. Visit `/settings/email` → chip reads **"Not connected"** + **"Connect Gmail"** button is visible.
- [ ] Click **"Connect Gmail"** → browser bounces to `accounts.google.com/o/oauth2/v2/auth?...`. Consent screen lists exactly two non-OIDC scopes: **"Read your Gmail messages"** + **"Send email on your behalf"** (no `gmail.modify`).
- [ ] Grant consent → browser returns to `/settings/email?connected=1`.
- [ ] **Expect** success Alert; chip flips to **"Connected"**; "Connected as `<your-email>`" + "Linked on `<today>`"; the 10 most recent messages render below with subject + from + timestamp.
- [ ] DB check: one `EmailAccount` row with `provider = 'GMAIL'`, the right `organizationId` and `userId`, `email` matches the connected mailbox, `scope` contains both `gmail.readonly` + `gmail.send`. `accessToken` + `refreshToken` both start with `v1:` (encrypted).
- [ ] API check: `curl -i http://localhost:3001/api/email/gmail/status -b $COOKIES` returns `{ connected: true, email: '<mailbox>', connectedAt: '<iso>' }`.

### EMAIL-02: Disconnect + reconnect re-prompts consent
- [ ] After EMAIL-01: click **"Disconnect"** → button label changes to "Disconnecting..." then page updates: chip flips to **"Not connected"**.
- [ ] DB check: the `EmailAccount` row is gone. Any cascaded `RawMessage` rows are also gone.
- [ ] At `myaccount.google.com/permissions`: the app no longer appears (revocation succeeded).
- [ ] Click **"Connect Gmail"** again → consent screen appears (not silently re-authorized), confirming `prompt=consent` is doing its job.
- [ ] Grant consent → land back on `/settings/email?connected=1`; new `EmailAccount` row created with a FRESH refresh token (different ciphertext than the one EMAIL-01 stored).

### EMAIL-03: State CSRF guard rejects mismatched callbacks
- [ ] Start `/api/email/gmail/connect` and capture the `q_gmail_oauth_state` cookie set on the response.
- [ ] Manually hit `/api/email/gmail/callback?code=fake&state=tampered_state` (where `tampered_state` is the cookie value modified at any byte).
- [ ] **Expect** HTTP 400 with message `OAuth state mismatch — possible CSRF, restart the connect flow.`
- [ ] Same call without the cookie at all → also HTTP 400.
- [ ] Expired state cookie (wait 11 minutes or jump system clock forward) → HTTP 400.

### EMAIL-04: User clicks "Cancel" on the Google consent screen
- [ ] Start the connect flow, then click "Cancel" on Google's screen → redirected to `/api/email/gmail/callback?error=access_denied&state=...`.
- [ ] **Expect** the callback bounces to `/settings/email?error=access_denied`.
- [ ] UI shows error Alert: *"Google returned an error: **access_denied**. Try connecting again."*
- [ ] **Expect** no `EmailAccount` row created.

### EMAIL-05: EXTERNAL collaborators cannot connect (any role can be a primary member)
- [ ] Sign in as a `MEMBER` of an org → can visit `/settings/email`, see status, click **Connect Gmail** → flow succeeds. Their `EmailAccount` row is independent of any OWNER's connection.
- [ ] Sign in as an `OWNER` of the same org → can also connect their own mailbox; status page shows the owner's own connection, not the member's.
- [ ] Sign in as an `EXTERNAL` user. Visit `/settings/email` → router's `beforeLoad` redirects to `/`. Home page does NOT show the **Email** button.
- [ ] `curl -i http://localhost:3001/api/email/gmail/connect -b cookies-of-external.txt` → HTTP **403** from `TenantMemberGuard` with message `External collaborators cannot perform this action.`
- [ ] Same 403 for `GET /status`, `GET /messages`, `POST /disconnect`.

### EMAIL-05b: Per-user isolation — members can't see each other's mailboxes
- [ ] Member A connects their Gmail. Member B (different user, same org) signs in.
- [ ] Member B's `/settings/email` page shows **Not connected** with the Connect CTA. They cannot see Member A's mailbox address or any of A's recent messages.
- [ ] Member B connects their own Gmail. DB now has 2 `EmailAccount` rows for the org, each scoped to its own `userId`.
- [ ] Member B's `/settings/email` page shows B's mailbox only.
- [ ] Member A logs back in → still sees A's mailbox, unchanged.
- [ ] Member B clicks **Disconnect** → only B's row is removed; A's row is untouched.

### EMAIL-05c: Entitlement required to connect (same gate as invitations)
- [ ] Sign in as a MEMBER of an org with state `'none'` (no Subscription row yet). Click **Connect Gmail**.
- [ ] **Expect** HTTP **402** from `EntitlementGuard` on the redirect-to-Google call (`GET /api/email/gmail/connect`). Body: `{ code: 'billing_required', billingPath: '/billing', message: 'An active subscription is required to make changes.' }`.
- [ ] Web client auto-redirects to `/billing` instead of bouncing to Google.
- [ ] Subscribe (BILLING-01) → status flips to `trialing` → retry **Connect Gmail** → succeeds. Inverse direction: cancel the subscription mid-trial → status goes `canceled` → trying to connect a *new* mailbox returns 402 again. Already-connected mailboxes keep working (status/messages reads are not gated by entitlement; existing tokens remain in DB).

### EMAIL-06: Token refresh is lazy + transparent
- [ ] Connect Gmail (EMAIL-01). Manually backdate the `accessTokenExpiresAt` column to `NOW() - INTERVAL '5 minutes'` in psql.
- [ ] Hit `/api/email/gmail/messages` → succeeds; messages return.
- [ ] DB check: `accessTokenExpiresAt` is now ~1 h in the future and `accessToken` has a new ciphertext (different from the original).
- [ ] **Expect** in API logs: no error lines; one outbound POST to `oauth2.googleapis.com/token`.

### EMAIL-07: Disconnected org renders the CTA cleanly (no 404 error)
- [ ] Sign in as the owner of an org that has NEVER connected Gmail. Visit `/settings/email`.
- [ ] **Expect** chip **"Not connected"**, "No mailbox connected yet.", **"Connect Gmail"** button — no error Alert, no "0 messages" residue, no console errors.
- [ ] Network tab: `GET /api/email/gmail/messages` returns 404 (no `EmailAccount`), which the web layer maps to `{ messages: [] }` — surfaced as nothing rather than a thrown error.

### EMAIL-08: Encryption at rest is enforced
- [ ] Connect Gmail. `SELECT "accessToken", "refreshToken" FROM "EmailAccount" LIMIT 1;` — both values must start with `v1:` followed by base64. NEVER raw `ya29.…` or `1//…` shapes.
- [ ] Tamper with one ciphertext byte: `UPDATE "EmailAccount" SET "refreshToken" = 'v1:tampered…' WHERE …;` Now hit `/api/email/gmail/messages` after waiting for the access token to expire → GCM auth tag fails on decrypt → request errors out (rather than silently sending garbage to Google).

### EMAIL-09: Boot fails fast without GOOGLE_CLIENT_ID/SECRET when needed
- [ ] Comment out `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env` (they're declared `.optional()` so boot will succeed).
- [ ] Click **"Connect Gmail"** → API responds with HTTP 500 + message `Google OAuth is not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).`
- [ ] Restore the env vars; restart API; flow works again.

### EMAIL-10: Self-heal when user revokes app at Google (cached token already expired)
- [ ] Connect Gmail (EMAIL-01). Confirm a fresh `EmailAccount` row + 10 messages render.
- [ ] In a separate browser tab visit https://myaccount.google.com/permissions → find the Quoteom app → **Remove access**.
- [ ] In Quoteom, force the access token to look expired: `UPDATE "EmailAccount" SET "accessTokenExpiresAt" = NOW() - INTERVAL '5 minutes';`
- [ ] Refresh `/settings/email`.
- [ ] **Expect**: chip flips to **Not connected** + Connect CTA reappears. The `EmailAccount` row is gone (`SELECT count(*) FROM "EmailAccount";` returns 0). Cascade also cleared any `RawMessage` rows for that account.
- [ ] **Expect** in API logs: one `WARN` line containing `refresh token rejected by Google — deleting row for org ...`, no `ERROR` lines.
- [ ] **Counter-test:** simulate a non-`invalid_grant` 400 by setting `GOOGLE_CLIENT_SECRET` to a wrong value briefly + repeating the steps. The row should NOT be deleted (the body says `invalid_client`, not `invalid_grant`); status read 500s instead. Restore the correct secret afterwards.

### INNGEST-01: Discovery endpoint returns the registered function list
- [ ] With the API running, hit `GET http://localhost:3001/api/inngest` (browser or curl).
- [ ] **Expect** JSON containing `"functions"` array with at least `hello` and `heartbeat` entries. Their `triggers` field reflects what the source code declares (`test/hello` event for hello, `0 * * * *` cron for heartbeat).

### INNGEST-02: Hello smoke fires end-to-end
- [ ] Terminal A: `pnpm dev` (API up).
- [ ] Terminal B: `npx inngest-cli@latest dev` → prints "Inngest dev server is up" at `http://localhost:8288`.
- [ ] In the dev UI **Functions** tab: `hello` and `heartbeat` both visible. CLI auto-discovered them via `/api/inngest`.
- [ ] In the dev UI: **New event** → name `test/hello` → data `{"name": "Quoteom"}` → **Send**.
- [ ] **Expect** **Runs** tab: one run, status **Completed**, output `{"greeting": "Hello, Quoteom!"}`. API logs include `[InngestFn:hello] hello fn fired: Hello, Quoteom!`.
- [ ] Invoke the same event from the API by calling `inngest.send(...)` from a controller (deferred — happens naturally once W3.4 triggers backfill jobs).

### INNGEST-03: Scheduled function fires on cron + can be force-invoked
- [ ] In the dev UI Functions tab → `heartbeat` → **Invoke** → confirm.
- [ ] **Expect** Runs tab: a completed run with output `{ ok: true, at: "<iso>" }`. API logs include `[InngestFn:heartbeat] heartbeat tick at ...`.
- [ ] Leave the dev server running across an hour boundary — at `:00` UTC a fresh run appears automatically. (For faster verification, edit the cron temporarily to `* * * * *` and reload — restore before committing.)

### EMAIL-BACKFILL-01: Happy path — connect Gmail, last 30 days arrive in DB
- [ ] Inngest dev server running (`npx inngest-cli@latest dev`). API running. Org in `trialing` state.
- [ ] Connect Gmail (EMAIL-01). Page lands on `/settings/email?connected=1`.
- [ ] **Expect** UI shows "Importing your last 30 days... this usually takes under a minute." + the list auto-refreshes every 5s.
- [ ] **Expect** Inngest dev UI Runs tab: a `gmail-backfill` run completes within ~30 s for a typical inbox. Output is shaped like `{ emailAccountId, pagesFetched, messagesInserted, messagesSkipped, historyId }`.
- [ ] **Expect** DB: `SELECT count(*) FROM "RawMessage";` returns the same number as `messagesInserted` in the Inngest output.
- [ ] **Expect** DB: `SELECT "historyId" FROM "EmailAccount";` is a non-null string (used by W3.5 push delta sync later).
- [ ] **Expect** UI: messages list updates from "Importing..." → showing 10 most recent (the smoke list endpoint is capped at 10; full inbox arrives in DB regardless).
- [ ] **Expect** every `RawMessage.raw` is a JSON object containing `payload.headers[]` etc.

### EMAIL-BACKFILL-02: Re-running is idempotent
- [ ] After EMAIL-BACKFILL-01 completes: in the Inngest dev UI, **Invoke** the `gmail-backfill` function manually with payload `{"emailAccountId": "<id from EmailAccount>"}`.
- [ ] **Expect** the run completes with `messagesInserted = 0` and `messagesSkipped = <total backfilled>`. No duplicate rows.
- [ ] **Expect** DB: `SELECT count(*) FROM "RawMessage";` unchanged from EMAIL-BACKFILL-01.

### EMAIL-BACKFILL-03: Disconnect + reconnect kicks off a fresh backfill
- [ ] After EMAIL-BACKFILL-01: click **Disconnect** → DB cleared (cascade drops `EmailAccount` + all `RawMessage` rows).
- [ ] Reconnect via the Connect Gmail flow → new `EmailAccount` row → backfill fires again.
- [ ] **Expect** `messagesInserted` matches the count from the original run (no leftover `RawMessage` rows; cascade worked).

### EMAIL-BACKFILL-04: Stale/missing EmailAccount mid-flight
- [ ] Connect Gmail. Immediately (within the 30 s backfill window) **Disconnect** so the row is deleted.
- [ ] **Expect** the in-flight backfill either (a) succeeds against the pre-deletion ID then the cascade trims its outputs OR (b) fails with `EMAIL_ACCOUNT_NOT_FOUND` after the deletion happens. Either is acceptable — the DB ends consistent (no orphan `RawMessage` rows pointing at a deleted `EmailAccount`).
- [ ] **Expect** Inngest dev UI: if (b), the run shows the `NotFoundException` and Inngest does NOT retry it (the exception is terminal — we should add a Non-retriable wrapper later).

### EMAIL-BACKFILL-05: Backfill on a freshly-revoked account
- [ ] Connect Gmail. While backfill is running (immediately after `?connected=1` lands), revoke the app at https://myaccount.google.com/permissions.
- [ ] **Expect**: the first Gmail API call mid-backfill returns 401 → `withFreshAccessToken` force-refreshes → `invalid_grant` → `EmailAccountsService` deletes the row + throws `NotFoundException`. Backfill function surfaces the error.
- [ ] **Expect** DB: zero `EmailAccount` + zero `RawMessage` rows for this user (cascade).
- [ ] **Expect** UI: chip flips to **Not connected** within 5 s thanks to the 5 s polling refetch — no manual refresh needed.

### MS-01: Happy path — owner connects Microsoft and sees 10 messages
Setup once: register an app in https://entra.microsoft.com → App Registrations → New. Redirect URI `http://localhost:3000/api/email/microsoft/callback` (type: Web). Under **Authentication**, allow "Personal Microsoft accounts" if you'll test with outlook.com. Under **Certificates & secrets**, create a client secret. Under **API permissions** → Microsoft Graph → Delegated: `Mail.Read`, `Mail.Send`, `User.Read`, `offline_access`, `openid`, `email`, `profile`. Paste client ID + secret + tenant id (or leave default `common`) into `apps/api/.env`.
- [ ] Sign in as the org `OWNER`. Visit `/settings/email` → both Gmail + Microsoft sections render with **"Not connected"** chips.
- [ ] Click **Connect Microsoft (Outlook)** → browser bounces to `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`. Consent screen lists the requested scopes including **Read your mail** and **Send mail as you**.
- [ ] Grant consent → browser returns to `/settings/email?connected=1`.
- [ ] **Expect** Microsoft section chip flips to **Connected**, "Connected as `<your-email>`" appears, the 10 most recent inbox messages render below with subject + from + timestamp.
- [ ] DB check: one `EmailAccount` row with `provider = 'MICROSOFT'`, `email` matches the connected mailbox, `scope` contains both `Mail.Read` and `Mail.Send`. `accessToken` + `refreshToken` both start with `v1:` (encrypted).
- [ ] API check: `curl -i http://localhost:3001/api/email/microsoft/status -b $COOKIES` returns `{ connected: true, email: '<mailbox>', connectedAt: '<iso>' }`.
- [ ] Verify `Provider sections are independent`: connecting Microsoft doesn't affect Gmail's `EmailAccount` row (both can coexist on the same org/user).

### MS-02: Disconnect + reconnect re-prompts consent
- [ ] After MS-01: click **Disconnect** under Microsoft → chip flips to **Not connected**.
- [ ] DB check: only the Microsoft `EmailAccount` row is gone. Gmail's row (if connected) is unaffected.
- [ ] No Microsoft programmatic revoke (Entra doesn't expose one). User can revoke manually via https://account.microsoft.com/privacy → "Apps and services that can access your data" if they want to fully reset consent.
- [ ] Click **Connect Microsoft (Outlook)** again → consent screen appears again (because `prompt=consent` forces it). Grant → new row, FRESH refresh token (different ciphertext than MS-01's).

### MS-03: State CSRF guard rejects mismatched callbacks
- [ ] Same flow as EMAIL-03 but for `q_ms_oauth_state` cookie + `/api/email/microsoft/callback`. Tamper test, missing-cookie test, expired-state test — all should HTTP 400.

### MS-04: Refresh-token rotation
**This is the key Microsoft-specific behavior** — Microsoft rotates refresh tokens on every refresh; Gmail does not.
- [ ] Connect Microsoft. `SELECT "refreshToken" FROM "EmailAccount" WHERE provider = 'MICROSOFT';` — note the ciphertext.
- [ ] Force the access token to look expired: `UPDATE "EmailAccount" SET "accessTokenExpiresAt" = NOW() - INTERVAL '5 minutes' WHERE provider = 'MICROSOFT';`
- [ ] Visit `/settings/email` → status refresh fires.
- [ ] **Expect** DB: BOTH `accessToken` AND `refreshToken` columns have NEW ciphertext compared to the noted value. (For Gmail this same test would show only `accessToken` rotating — Gmail reuses refresh tokens.)
- [ ] `accessTokenExpiresAt` is now ~1 h in the future.

### MS-05: Backfill — Microsoft Graph happy path
- [ ] Connect Microsoft. UI shows "Importing your last 90 days..."
- [ ] Inngest dev UI Runs tab: a `microsoft-backfill` run completes within ~30 s. Output shaped `{ emailAccountId, pagesFetched, messagesInserted, messagesSkipped }`.
- [ ] DB: `SELECT count(*) FROM "RawMessage" WHERE "emailAccountId" = '<ms-id>';` matches `messagesInserted`.
- [ ] **Expect** `RawMessage.raw` contains the full Graph payload (with `subject`, `body.contentType`, `body.content`, `from.emailAddress.address`, etc.).
- [ ] **Expect** `RawMessage.threadId` is populated from Graph's `conversationId` (used by W5.6 thread reconstruction).
- [ ] Note: Microsoft mailboxes don't get a `historyId` in `EmailAccount` — Graph push uses a different cursor (W3.6).

### MS-ADMIN-CONSENT-01: Work-tenant admin-consent error surfaces the admin CTA
The scenario: a user signs in with a work Microsoft account whose tenant admin has disabled user-level consent for `Mail.*` scopes. Entra refuses to issue the auth code and redirects back to our callback with `error=access_denied` + `error_description=AADSTS65001…` (or AADSTS90094 / AADSTS900971). We translate that into a structured `microsoft_admin_consent_required` UI state with a copyable admin-consent link.
- [ ] Two ways to simulate without an actual locked-down tenant:
   - **Manual URL**: hit `http://localhost:3001/api/email/microsoft/callback?error=access_denied&error_description=AADSTS90094%3A+The+grant+requires+admin+permission` while signed in with a valid session.
   - **Real tenant**: if you have access to an org's Entra portal, set Enterprise applications → Consent and permissions → User consent settings to **"Do not allow user consent"**, then try connecting from a member account.
- [ ] **Expect** browser lands on `/settings/email?error=microsoft_admin_consent_required&adminConsentUrl=https%3A%2F%2Flogin.microsoftonline.com%2Fcommon%2Fadminconsent%3F…`.
- [ ] **Expect** UI: yellow warning Alert with copy "Your IT admin needs to approve Quoteom for your organization", the admin-consent URL displayed in a monospace box, and a **Copy link** button that flips to "Copied!" for ~2.5 s after click.
- [ ] **Expect** the URL points at `https://login.microsoftonline.com/common/adminconsent` with `client_id` matching `MICROSOFT_CLIENT_ID` and `redirect_uri` matching the configured callback.
- [ ] Negative case: `?error=access_denied&error_description=AADSTS70008%3A+expired+token` (unrelated code) should fall through to the existing generic error Alert ("The provider returned an error: access_denied"), NOT render the admin-consent CTA.
- [ ] Negative case: `?error=access_denied` with NO `error_description` should also fall through to the generic error Alert.

### MS-06: Per-user isolation — multi-provider parity
- [ ] Same org. Member A connects Gmail. Member B connects Microsoft. DB shows 2 `EmailAccount` rows (different `userId`, different `provider`).
- [ ] Member A's `/settings/email` shows Gmail "Connected as A", Microsoft "Not connected".
- [ ] Member B's `/settings/email` shows Gmail "Not connected", Microsoft "Connected as B".
- [ ] Each can disconnect their own row without affecting the other.

### INNGEST-04: Auth.js + Inngest don't collide on /api/* mounting
- [ ] Confirm `GET /api/auth/session` still returns the session (Auth.js) and `GET /api/inngest` returns the function list (Inngest). Both are app-level Express middleware mounted before NestJS pipes — order in `main.ts` is `/api/auth` then `/api/inngest`. Adding a NestJS controller for either prefix would shadow them and break this test.

### EMAIL-10b: Self-heal when user revokes app at Google (cached token still "fresh")
The scenario EMAIL-10 misses: the user revokes our app within the access-token's 1 h cache window, so our `accessTokenExpiresAt` doesn't trigger a refresh attempt. The first signal is a 401 from the Gmail API itself.
- [ ] Connect Gmail (EMAIL-01). Verify `SELECT "accessTokenExpiresAt" FROM "EmailAccount";` is ~1 h in the future — do **not** force-expire it.
- [ ] Revoke the app at https://myaccount.google.com/permissions.
- [ ] Immediately refresh `/settings/email` (or hit `GET /api/email/gmail/messages` directly).
- [ ] **Expect** in API logs:
   - `WARN [GmailApiService] messages.list failed: 401 ... Invalid Credentials` (or no error log — depends on the path that hit 401 first; the typed exception bypasses the generic error logging).
   - `WARN [EmailAccountsService] Gmail returned 401 for org <id> / user <id> — forcing refresh + retry`.
   - `WARN [EmailAccountsService] Gmail <email> refresh token rejected by Google — deleting row for org <id> / user <id>`.
- [ ] **Expect** in DB: `EmailAccount` row gone; cascade cleared `RawMessage` rows.
- [ ] **Expect** UI: chip **Not connected**, Connect CTA visible, no 500 error Alert. (The page now treats the request as "mailbox not connected" — same shape as EMAIL-07.)
- [ ] Click **Connect Gmail** → consent screen appears again → reconnect succeeds. New `EmailAccount` row with fresh tokens.

## Gmail push notifications (W3.5)

### EMAIL-PUSH-01: Pure-code unit coverage
The W3.5 staged execution plan (`~/.claude/plans/toasty-herding-giraffe.md`) splits W3.5 into pure-code (Phase A+B, no GCP) and tunnel-smoke (Phase C). This entry covers the Phase A+B unit + integration story.
- [ ] `pnpm --filter @quoteom/api exec jest src/modules/gmail/gmail-delta-sync.service.spec.ts` — 8 tests pass (not-found, orphaned, no-cursor, single page, dedup, idempotency, history-expired recovery, empty delta).
- [ ] `pnpm --filter @quoteom/api exec jest src/lib/oauth/pubsub-jwt-verifier.spec.ts` — 12 tests pass (happy path + 11 rejection paths including tampered signature, expired, wrong issuer, wrong audience, wrong service-account email, email_verified false, unsupported alg, unknown kid, malformed forms).

### EMAIL-PUSH-02: GOOGLE_PUBSUB_TOPIC unset → watch start is a structured no-op
- [ ] With no `GOOGLE_PUBSUB_TOPIC` in `apps/api/.env`, run EMAIL-BACKFILL-01 (connect Gmail). Backfill completes successfully.
- [ ] In the Inngest dev UI, the `gmail-backfill` run shows 2 steps: `backfill` succeeded, `start-watch` succeeded.
- [ ] DB check: `SELECT * FROM "Log" WHERE metadata->>'action' = 'email.watch.skipped_no_topic'` returns 1 row.
- [ ] DB check: `SELECT "watchExpiresAt" FROM "EmailAccount"` still NULL.
- [ ] The cron `gmail-watch-renewal` registered in the dev UI. Manually invoking it produces `email.watch.renewal.skipped_no_topic` and zero updates.

### EMAIL-PUSH-03: Webhook rejects requests without GOOGLE_PUBSUB_AUDIENCE / SERVICE_ACCOUNT
- [ ] With `GOOGLE_PUBSUB_AUDIENCE` / `GOOGLE_PUBSUB_SERVICE_ACCOUNT` unset, `curl -sX POST -H 'authorization: Bearer x.y.z' http://localhost:3001/api/email/gmail/webhook -H 'content-type: application/json' -d '{"message":{"data":""},"subscription":""}'` returns 503.
- [ ] DB check: `Log` row with `action = 'gmail.webhook.not_configured'`, level = ERROR.

### EMAIL-PUSH-04: Webhook rejects requests with no Authorization header → 401
- [ ] With both env vars set (any valid-looking value works), POST without an Authorization header returns 401 + body containing "Missing or malformed Authorization header".
- [ ] Same for `Authorization: foo` (not Bearer-shaped) → 401.

### EMAIL-PUSH-05: Webhook acknowledges pushes for unknown mailboxes with 204 + skip
- [ ] Send a valid signed Pub/Sub push (requires running ngrok + actual Pub/Sub — covered in Phase C). The push body must include a base64-encoded `{ emailAddress: "<not-connected@example.com>", historyId: 1 }`.
- [ ] **Expect** API responds 204 (Pub/Sub stops retrying).
- [ ] DB check: `Log` row `gmail.webhook.unknown_mailbox` at WARN level, no `gmail/history.changed` event fired in the Inngest dev UI.

### EMAIL-PUSH-06: Phase C — end-to-end smoke via ngrok
The ngrok-based smoke story. **First passed on 2026-05-14.** Setup steps (run once per dev machine):

1. **Create Pub/Sub topic** `projects/<your-project>/topics/quoteom-gmail-dev` in GCP.
2. **Grant `gmail-api-push@system.gserviceaccount.com`** the `roles/pubsub.publisher` role on the topic (Permissions tab on the topic). Most common 403 source if missed.
3. **Create a service account** (IAM & Admin → Service Accounts) with the role `roles/iam.serviceAccountTokenCreator`. This is the account Pub/Sub impersonates to sign JWTs.
4. **Register a push subscription** pointing at `https://<your-ngrok-domain>/api/email/gmail/webhook`:
   - Delivery type: Push
   - Enable authentication: ON
   - Service account: the one from step 3
   - Audience: same as the endpoint URL
5. **Add ngrok URLs to the Google OAuth client's Authorized redirect URIs:**
   - `https://<your-ngrok-domain>/api/email/gmail/callback`
   - `https://<your-ngrok-domain>/api/auth/callback/google`
6. **Env vars** in `apps/api/.env`:
   ```
   GOOGLE_PUBSUB_TOPIC=projects/<your-project>/topics/quoteom-gmail-dev
   GOOGLE_PUBSUB_AUDIENCE=https://<your-ngrok-domain>/api/email/gmail/webhook
   GOOGLE_PUBSUB_SERVICE_ACCOUNT=<exact email from step 3>
   WEB_ORIGIN=https://<your-ngrok-domain>      # temporary — set back to localhost after smoke
   ```
   **Also: UNSET `AUTH_URL`** if it's currently set to a localhost value (see gotcha table below). With `trustHost: true`, Auth.js will pick up the ngrok host from request headers.
7. **Add ngrok host to `apps/web/vite.config.ts`** under `server.allowedHosts` — already done in the codebase (`.ngrok-free.dev` wildcard covers it).
8. **Start everything:** `pnpm dev` + `pnpm --filter @quoteom/api inngest` + `ngrok http 3000 --domain=<your-reserved-domain>`.

Smoke steps:
- [ ] Sign in via the **ngrok URL** (not localhost — OAuth callbacks must land on the tunnel for the session cookie to scope correctly).
- [ ] Connect Gmail at `/settings/email`. Inngest UI's `gmail-backfill` run shows two steps: `backfill` ✓ then `start-watch` ✓. DB `watchExpiresAt` is ~7 days in the future.
- [ ] From a different account, send a test email to the connected mailbox.
- [ ] Within 30s: ngrok inspector (http://localhost:4040) shows POST to `/api/email/gmail/webhook` with `Authorization: Bearer eyJ...`, response 204.
- [ ] `gmail-delta-sync` Inngest run fires (~2s debounce after the push). Step output reports `messagesInserted: 1`.
- [ ] `RawMessage` table has the new row; `EmailAccount.historyId` advanced.
- [ ] `Log` table has rows for `gmail.webhook.received` then `email.delta_sync.completed`.

Bonus checks (validate self-healing):
- [ ] **Renewal cron works.** In `db:studio`, backdate `EmailAccount.watchExpiresAt` to yesterday. In Inngest UI invoke `gmail-watch-renewal` (empty payload). Output: `{ scanned: 1, renewed: 1, skipped: 0, failed: 0 }`. `watchExpiresAt` returns to ~7 days out.
- [ ] **Orphan-row pickup works (audit round 2 fix).** Set `watchExpiresAt` to NULL (keep `historyId` set). Invoke `gmail-watch-renewal` again. Still `renewed: 1` — proves the OR-clause in the cron's findMany covers half-connected mailboxes.

#### Common Phase C gotchas (in order of how often they bite)

| Symptom | Cause | Fix |
|---|---|---|
| **`users.watch` returns 403 at backfill end** | Step 2 missed: `gmail-api-push@system.gserviceaccount.com` doesn't have Publisher on the topic. | Add the role on the topic's Permissions tab. |
| **OAuth callback redirects you to localhost** | `WEB_ORIGIN` env still set to `http://localhost:3000`. Auth.js's `redirect` callback rewrites every post-signin URL to that value. | Set `WEB_ORIGIN=https://<your-ngrok>` for the smoke. Restart API. |
| **Sign-in succeeds but home page bounces to `/sign-in`; `Failed to load organizations (401)`** | `AUTH_URL=http://localhost:3000/api/auth` overrides Auth.js's header-based URL detection. `@auth/express`'s `getSession` builds an HTTP URL → uses non-secure cookie name → doesn't find the `__Secure-` cookie that ExpressAuth set. | **Unset `AUTH_URL`** for the smoke. `trustHost: true` in authConfig handles URL detection from request headers correctly. |
| **Webhook 401 every push** | `GOOGLE_PUBSUB_SERVICE_ACCOUNT` env doesn't match the actual service account configured on the push subscription. | The API logs `gmail.webhook.jwt_invalid` with the JWT's actual `email` claim — copy that exact value into env. Restart API. |
| **Webhook 503** | One of `GOOGLE_PUBSUB_AUDIENCE` / `GOOGLE_PUBSUB_SERVICE_ACCOUNT` is empty. By design — we refuse pushes when verification isn't configured. | Set both. Restart API. |
| **Webhook 204 + `gmail.webhook.unknown_mailbox` action log** | `EmailAccount.email` doesn't match Gmail's `emailAddress` in the push (e.g. mailbox alias mismatch). | Check `db:studio` → the email column on EmailAccount. |
| **OAuth callback hits `localhost:3000` instead of tunnel** | You started the flow from localhost, not the ngrok URL. | Restart at `https://<ngrok>/sign-in`. |
| **Vite responds 403 with "host not allowed"** | ngrok subdomain not in `vite.config.ts` allowedHosts. | Already fixed in main with `.ngrok-free.dev` wildcard. If using a different ngrok TLD add it. |

---

## How to maintain this doc

- **Adding a feature** → add a new `## Section` with `### XXX-01:` test cases. Use a short uppercase prefix per area (`AUTH`, `INV`, `TEN`, `LOG`, `MAIL`, `DB`, `WEB`, `BILLING`, then `OPP` for opportunities, `QUO` for quotes, etc.).
- **Removing a feature** → strike through the section, delete after a week if no regression.
- **A test reveals a bug** → don't delete the test case after fixing; future regressions need it.
- **Keep it executable** — every test case should be a thing the reader can copy-paste and run, not prose.
