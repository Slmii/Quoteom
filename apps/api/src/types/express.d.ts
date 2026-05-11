import type { Session } from '@auth/express';

// Single source of truth for Express request augmentation. Imported automatically
// by `include: ["src/**/*"]` in tsconfig — no explicit import required at the call site.
declare module 'express-serve-static-core' {
	interface Request {
		/** Populated by AuthGuard. The verified Auth.js session for this request. */
		authSession?: Session;
		/** Populated by OrganizationGuard. The active organization for this request. */
		organizationId?: string;
	}
}
