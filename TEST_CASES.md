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
  - [ ] HTML body: off-white background, slate "Inloggen" button, amber link below.
  - [ ] Falling back to plain-text view shows readable Dutch copy.

### MAIL-02: Invite email uses branded template
- [ ] Trigger INV-01 with `RESEND_API_KEY` set.
- [ ] In the recipient inbox:
  - [ ] Subject: `Uitnodiging: <Organization> op Quoteom`.
  - [ ] HTML body: heading `Welkom bij <Organization>`, "Uitnodiging accepteren" CTA.

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

## How to maintain this doc

- **Adding a feature** → add a new `## Section` with `### XXX-01:` test cases. Use a short uppercase prefix per area (`AUTH`, `INV`, `TEN`, `LOG`, `MAIL`, `DB`, then `OPP` for opportunities, `QUO` for quotes, etc.).
- **Removing a feature** → strike through the section, delete after a week if no regression.
- **A test reveals a bug** → don't delete the test case after fixing; future regressions need it.
- **Keep it executable** — every test case should be a thing the reader can copy-paste and run, not prose.
