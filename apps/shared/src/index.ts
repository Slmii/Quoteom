/**
 * `@quoteom/shared` — types that cross the API ↔ web boundary.
 *
 * All shapes here describe data ON THE WIRE (JSON). Where the API stores `Date` objects
 * server-side, the wire format is always an ISO string — so `createdAt`, `expiresAt`,
 * etc. are typed as `string` here. The API's response DTOs use `Date` internally; NestJS
 * serializes those to ISO strings before sending, and the FE parses them back as strings.
 *
 * Convention:
 *  - All interface fields use the wire format (string for dates, no Prisma types).
 *  - Request DTOs (e.g. `CreateInvitationInput`) describe what the FE sends; BE adds
 *    class-validator decorators to runtime-validate those inputs.
 *  - Response interfaces describe what the FE receives; BE DTOs may or may not formally
 *    `implements` them (mismatches between Date-on-BE and string-on-wire mean some
 *    DTOs can't be `implements`-linked without conversion churn).
 */

// `.js` extensions are required by the API's `nodenext` moduleResolution. The web uses
// `Bundler` resolution which doesn't care either way, so suffixed paths work for both.
export * from './auth.js';
export * from './billing.js';
export * from './common.js';
export * from './email.js';
export * from './invitations.js';
export * from './team.js';
