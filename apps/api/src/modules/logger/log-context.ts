import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request log context populated as the request flows through middleware + guards.
 *
 *  - `requestId`     — generated at request entry, mirrored in the `X-Request-Id` response
 *                      header so clients can correlate. Always present once the
 *                      RequestContextMiddleware has run.
 *  - `userId`        — pushed by `AuthGuard` once Auth.js confirms the session.
 *  - `organizationId` — pushed by `OrganizationGuard` once the active org is resolved.
 *
 * Anything logged inside the request boundary (`Logger.warn(...)`, `LogService.logAction(...)`)
 * automatically inherits this context — the LogService reads it on every persist call.
 */
export interface LogContext {
	requestId: string;
	userId?: string;
	organizationId?: string;
}

/**
 * Module-level singleton — NOT a Nest provider — because the request-entry middleware
 * runs OUTSIDE Nest's DI graph (mounted via `app.use(...)` in main.ts, ahead of
 * `useGlobalPipes`). Auth.js's ExpressAuth and Inngest's `serve()` mount in the same
 * pre-Nest zone and therefore can't read injected providers either. A static singleton
 * is the only shape that works uniformly across the Auth.js / Inngest / Nest boundaries.
 */
const als = new AsyncLocalStorage<LogContext>();

export const logContext = {
	/**
	 * Wrap a callback inside the given context. The store is observable from any
	 * async-descended code via `get()`.
	 */
	run<T>(context: LogContext, fn: () => T): T {
		return als.run(context, fn);
	},

	/** Read the active context, or undefined if called outside a request boundary. */
	get(): LogContext | undefined {
		return als.getStore();
	},

	/**
	 * Merge fields into the active context (in-place). No-op if no context is active —
	 * typically only happens in code that runs outside the request lifecycle (boot
	 * sequences, Inngest cron-firing-without-a-request, tests that don't wrap).
	 */
	set(partial: Partial<LogContext>): void {
		const store = als.getStore();
		if (!store) {
			return;
		}
		Object.assign(store, partial);
	}
};
