import {
	buildMicrosoftAdminConsentUrl,
	MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX
} from '@/lib/errors';
import { describe, expect, it } from '@jest/globals';

describe('MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX', () => {
	it('matches AADSTS65001 (user/admin has not consented)', () => {
		const description =
			"AADSTS65001: The user or administrator has not consented to use the application with ID 'abc' named 'Quoteom'.";
		expect(MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test(description)).toBe(true);
	});

	it('matches AADSTS90094 (admin permission required)', () => {
		const description = 'AADSTS90094: The grant requires admin permission.';
		expect(MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test(description)).toBe(true);
	});

	it('matches AADSTS900971 (no reply address — admin-consent variant)', () => {
		const description = 'AADSTS900971: No reply address provided.';
		expect(MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test(description)).toBe(true);
	});

	it('does NOT match unrelated AADSTS codes', () => {
		// AADSTS70008 = expired refresh token; AADSTS50105 = user not assigned to app role.
		expect(MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test('AADSTS70008: refresh token expired')).toBe(false);
		expect(MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test('AADSTS50105: user not assigned to app role')).toBe(false);
	});

	it('does NOT match an empty description', () => {
		expect(MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test('')).toBe(false);
	});

	it('uses a word boundary so AADSTS650019 is not a false positive', () => {
		// Guards against a substring match — only the literal codes in the alternation should fire.
		expect(MICROSOFT_ADMIN_CONSENT_ERROR_CODE_REGEX.test('AADSTS650019: something else')).toBe(false);
	});
});

describe('buildMicrosoftAdminConsentUrl', () => {
	it('builds the /common/adminconsent URL with client_id and redirect_uri', () => {
		const url = buildMicrosoftAdminConsentUrl('client-abc', 'https://app.example.com/api/email/microsoft/callback');
		expect(url).toBe(
			'https://login.microsoftonline.com/common/adminconsent' +
				'?client_id=client-abc' +
				'&redirect_uri=https%3A%2F%2Fapp.example.com%2Fapi%2Femail%2Fmicrosoft%2Fcallback'
		);
	});

	it('uses /common so Entra resolves the tenant from the admin sign-in', () => {
		const url = buildMicrosoftAdminConsentUrl('x', 'https://y');
		expect(url.startsWith('https://login.microsoftonline.com/common/adminconsent')).toBe(true);
	});

	it('URL-encodes the redirect URI', () => {
		const url = buildMicrosoftAdminConsentUrl('x', 'https://y/with space');
		expect(url).toContain('redirect_uri=https%3A%2F%2Fy%2Fwith+space');
	});
});
