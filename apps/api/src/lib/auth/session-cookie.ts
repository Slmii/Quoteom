import { getAuthSessionCookieOptions } from '@/lib/auth/session-cookie-options';
import { encode as encodeAuthJwt } from '@auth/core/jwt';
import type { Request, Response } from 'express';

const DAYS_30_SECONDS = 30 * 24 * 60 * 60;

interface IssueSessionCookieInput {
	authSecret: string;
	email: string;
	userId: string;
	request: Request;
	response: Response;
	authUrl?: string;
}

/**
 * Issue an Auth.js-compatible session cookie programmatically — used by paths that
 * already prove email ownership through another channel (today: the invitation accept
 * flow, which redeems a 256-bit secret sent to the user's verified inbox).
 *
 * **Why we can do this safely:** an invitation token in the URL is the same proof
 * of inbox possession that a magic link provides — both arrive in the inbox of the
 * email being verified, and both are unguessable random secrets. Once the user redeems
 * the token, asking them to also click a magic link is redundant friction; the second
 * round-trip doesn't add a new credential, it just performs the same check twice.
 *
 * **Compatibility:** matches the exact shape Auth.js's own session-creation produces.
 * Auth.js chooses `__Secure-authjs.session-token` when the resolved auth URL is HTTPS and
 * `authjs.session-token` otherwise, then uses that cookie name as the JWT salt. Mirror
 * that protocol-based choice here so `/api/auth/session` can decode the cookie after the
 * browser lands back on `/`.
 */
export async function issueSessionCookie(params: IssueSessionCookieInput): Promise<void> {
	const { authSecret, authUrl, email, request, response, userId } = params;

	const cookie = getAuthSessionCookieOptions({ authUrl, request });

	const token = await encodeAuthJwt({
		secret: authSecret,
		salt: cookie.name,
		maxAge: DAYS_30_SECONDS,
		token: {
			userId,
			email,
			sub: userId
		}
	});

	response.cookie(cookie.name, token, {
		httpOnly: true,
		sameSite: 'lax',
		secure: cookie.secure,
		path: '/',
		maxAge: DAYS_30_SECONDS * 1000
	});
}
