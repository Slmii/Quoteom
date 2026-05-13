import type { EnvSchema } from '@/config/env.schema';
import { MicrosoftOAuthService } from '@/modules/email-accounts/microsoft-oauth.service';
import { describe, expect, it } from '@jest/globals';
import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

function makeService(env: Partial<Record<keyof EnvSchema, string>>): MicrosoftOAuthService {
	// ConfigService accepts a typed `get(key)` — a plain object whose keys match the env
	// schema is enough to satisfy `config.get('FOO', { infer: true })` in the service.
	const config = { get: (key: keyof EnvSchema) => env[key] } as unknown as ConfigService<EnvSchema, true>;
	return new MicrosoftOAuthService(config);
}

describe('MicrosoftOAuthService.buildAdminConsentUrl', () => {
	it('builds the admin-consent URL using the configured client id and computed redirect URI', () => {
		const service = makeService({
			MICROSOFT_CLIENT_ID: 'client-abc',
			MICROSOFT_CLIENT_SECRET: 'secret-xyz',
			MICROSOFT_TENANT_ID: 'common',
			WEB_ORIGIN: 'https://app.example.com'
		});

		const url = service.buildAdminConsentUrl();

		expect(url).toBe(
			'https://login.microsoftonline.com/common/adminconsent' +
				'?client_id=client-abc' +
				'&redirect_uri=https%3A%2F%2Fapp.example.com%2Fapi%2Femail%2Fmicrosoft%2Fcallback'
		);
	});

	it('throws when MICROSOFT_CLIENT_ID is not configured (delegated to credentials())', () => {
		const service = makeService({ MICROSOFT_CLIENT_SECRET: 'x', WEB_ORIGIN: 'https://app.example.com' });
		expect(() => service.buildAdminConsentUrl()).toThrow(InternalServerErrorException);
	});
});
