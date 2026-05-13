import { logContext } from '@/modules/logger/log-context';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const REQUEST_ID_HEADER = 'x-request-id';
// Conservative shape — reject anything that could be a vector for log injection or
// header smuggling. UUIDs, ULIDs, nanoids all pass; arbitrary user-controlled strings don't.
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Wraps every request in a `logContext` ALS frame so any log call made during the request
 * — whether from Nest controllers, Auth.js callbacks, Inngest function handlers, or the
 * background `setImmediate(...)` paths Stripe's webhook uses — inherits a stable
 * `requestId` (and later `userId` / `organizationId`).
 *
 * Mounted via `app.use(requestContextMiddleware)` in main.ts BEFORE the Auth.js and
 * Inngest mounts so it covers their requests too. Sits ahead of Nest's pipes/filters.
 *
 * If the client sends an `X-Request-Id` header that matches our validation regex we
 * reuse it — useful when a proxy / SDK assigns its own trace ID and we want unified
 * correlation. Otherwise we generate a UUIDv4. Either way the chosen ID is mirrored back
 * in the response header so the client can correlate.
 */
export function requestContextMiddleware(request: Request, response: Response, next: NextFunction): void {
	const incoming = request.header(REQUEST_ID_HEADER);
	const requestId = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
	response.setHeader('X-Request-Id', requestId);
	logContext.run({ requestId }, () => next());
}
