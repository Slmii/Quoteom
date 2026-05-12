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

### BILLING-11: Trial gate — fresh org, within local 14-day window
- [ ] Create a brand-new org (sign up via invitation flow). Do **not** click Subscribe.
- [ ] Hit any tenant write route protected by `@TenantWrite()` (e.g. a future `POST /api/opportunities`). For now, smoke this by adding `@UseGuards(OrganizationGuard, EntitlementGuard)` to a throwaway POST route or by manually invoking the guard in a unit test.
- [ ] **Expect** the request succeeds (HTTP 2xx). The local trial window keeps writes open until `org.createdAt + 14d`.

### BILLING-12: Trial gate — local trial expired, no Stripe subscription
- [ ] In Prisma Studio or psql: backdate the org row — `UPDATE "Organization" SET "createdAt" = NOW() - INTERVAL '15 days' WHERE id = '<org-uuid>';`
- [ ] Hit the same write route.
- [ ] **Expect** HTTP `402` with body `{ statusCode: 402, code: 'billing_required', message: 'Your trial has ended. Subscribe to continue.', billingPath: '/billing' }`.
- [ ] **Expect** any **read** route on the same org still returns 200 (e.g. `GET /api/me/memberships`).
- [ ] On the web client, calling a write mutation against this org auto-redirects the browser to `/billing`.

### BILLING-13: Trial gate — entitled via Stripe subscription
- [ ] Complete BILLING-01 so `Subscription.status = 'trialing'`.
- [ ] Backdate `Organization.createdAt` to 30 days ago (force the local-grace window to be expired).
- [ ] Hit the same write route.
- [ ] **Expect** HTTP 2xx — the Stripe-managed entitlement (`trialing | active | past_due`) overrides the local window.

### BILLING-14: Trial gate — Stripe subscription canceled
- [ ] Complete BILLING-07 (cancel via Portal) and wait until the period ends (or force via test clock + advance).
- [ ] **Expect** `Subscription.status` flips to `canceled` after the webhook syncs.
- [ ] Hit the write route → HTTP `402`. **Critical:** even if `org.createdAt + 14d > now`, the local-grace window is **not** re-granted once the org has held a Stripe subscription (`stripeSubscriptionId` is non-null on the Subscription row, even with status=canceled — the guard's `!sub?.stripeSubscriptionId` check fails closed). If the row was fully cleared by `syncFromStripe`'s "no subscriptions" branch, the local-grace window may re-engage — that's by design for "deleted in Stripe" cleanup paths.

### BILLING-15: Trial gate — past_due grace
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

### BILLING-19: Per-seat — sync skipped during local trial
- [ ] Brand-new org, never hit Checkout. Invite + accept a 2nd member.
- [ ] **Expect** no Stripe API calls (`stripe listen` shows nothing); API logs do **not** include a "Seat sync" line.
- [ ] **Expect** `/billing` shows local_trial state + accurate seat count.

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
- [ ] For `local_trial` / `expired`: the button is hidden entirely (no Stripe customer yet).

### BILLING-PORTAL-02: Cancellation banner has a one-click Resume action
- [ ] As owner with active sub: open Customer Portal → "Cancel subscription" → confirm "at period end".
- [ ] **Expect** DB: `cancelAtPeriodEnd = true`, `status` still `active`.
- [ ] **Expect** `/billing` status panel shows a warning Alert: *"Cancellation scheduled for {date}. Resume your subscription before then to keep access."* with a **Resume** button on the right.
- [ ] Click **Resume** → opens Customer Portal directly (no scroll to find the main Manage button).
- [ ] In Portal, click "Renew subscription" → webhook fires → `cancelAtPeriodEnd` flips to `false` → banner disappears on next status refetch.

### BILLING-OWNER-02: Owner can access billing
- [ ] Sign in as the org `OWNER`. Home page shows the Billing button. Visit `/billing` → loads normally.
- [ ] `curl -i http://localhost:3001/api/billing/status -b cookies-of-owner.txt` → HTTP 200 with the full status DTO.

### BILLING-22: Trial seat cap — block invites past included tier
- [ ] Fresh org, no Subscription yet (local_trial). Owner = 1 active member.
- [ ] Invite teammate 1 (2 members total once accepted) → succeeds.
- [ ] Invite teammate 2 (3 members) → succeeds.
- [ ] Send a 3rd invitation (4th seat) → **expect** HTTP 402 with body `{ statusCode: 402, code: 'trial_seat_limit', message: 'Trial accounts are limited to 3 seats. Subscribe to invite more teammates.', billingPath: '/billing' }`.
- [ ] **Expect** no `Invitation` row created; no email sent.
- [ ] **Expect** `/billing` UI seats line reads "3 used · 3 max during trial — Trial seat limit reached. Subscribe to invite more teammates."

### BILLING-23: Trial seat cap — pending invitations count toward the cap
- [ ] Fresh org, owner = 1 active member. Send 2 invitations but **do not accept** them yet.
- [ ] Send a 3rd invitation → **expect** HTTP 402 `trial_seat_limit` (1 active + 2 pending = 3, at cap).
- [ ] **Expect** `/billing` UI still shows `seats.used = 1` (UI only counts accepted memberships) but the API correctly enforces the combined count.

### BILLING-24: Seat cap stays during Stripe trial, lifts at `active`
- [ ] Continuing from BILLING-22 (org at 3 seats, local_trial), run BILLING-01 (subscribe with `4242…`).
- [ ] Status flips to `trialing`. **Stripe trial is still a "trial state"** per `TRIAL_STATES = ['local_trial', 'trialing']`. Re-attempting a 4th invitation → still HTTP 402 `trial_seat_limit`. By design — the user said "no more seats before the trial has ended".
- [ ] Use a Stripe test clock to advance past trial end → status webhook flips to `active`.
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

## How to maintain this doc

- **Adding a feature** → add a new `## Section` with `### XXX-01:` test cases. Use a short uppercase prefix per area (`AUTH`, `INV`, `TEN`, `LOG`, `MAIL`, `DB`, `WEB`, `BILLING`, then `OPP` for opportunities, `QUO` for quotes, etc.).
- **Removing a feature** → strike through the section, delete after a week if no regression.
- **A test reveals a bug** → don't delete the test case after fixing; future regressions need it.
- **Keep it executable** — every test case should be a thing the reader can copy-paste and run, not prose.
