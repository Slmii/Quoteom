import type { Request } from 'express';

interface AuthSessionCookieOptionsInput {
	request: Request;
	authUrl?: string;
}

interface AuthSessionCookieOptions {
	name: string;
	secure: boolean;
}

function readHeader(request: Request, name: string): string | undefined {
	const value = request.headers[name.toLowerCase()];
	if (Array.isArray(value)) {
		return value[0];
	}

	return value;
}

function shouldUseSecureCookie(request: Request, authUrl?: string): boolean {
	if (authUrl) {
		return new URL(authUrl).protocol === 'https:';
	}

	const forwardedProto = readHeader(request, 'x-forwarded-proto');
	const protocol = forwardedProto ?? request.protocol;
	return protocol === 'https' || protocol === 'https:';
}

export function getAuthSessionCookieOptions(params: AuthSessionCookieOptionsInput): AuthSessionCookieOptions {
	const secure = shouldUseSecureCookie(params.request, params.authUrl);

	return {
		name: secure ? '__Secure-authjs.session-token' : 'authjs.session-token',
		secure
	};
}
