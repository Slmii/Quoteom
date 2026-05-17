import { EmailProvider } from '@/generated/prisma/enums';
import { detectBulkMail } from '@/lib/email/bulk-mail-filter';
import { describe, expect, it } from '@jest/globals';

function encodeGmailBody(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

describe('detectBulkMail', () => {
	it('flags Gmail messages with a non-empty List-Unsubscribe header', () => {
		const result = detectBulkMail({
			provider: EmailProvider.GMAIL,
			raw: {
				payload: {
					headers: [
						{ name: 'From', value: 'newsletter@vendor.example' },
						{ name: 'List-Unsubscribe', value: '<mailto:unsub@vendor.example>' }
					]
				}
			}
		});
		expect(result).toEqual({ isBulk: true, reason: 'list_unsubscribe_header' });
	});

	it('flags Microsoft messages with List-Unsubscribe in internetMessageHeaders', () => {
		const result = detectBulkMail({
			provider: EmailProvider.MICROSOFT,
			raw: {
				internetMessageHeaders: [
					{ name: 'List-Unsubscribe', value: '<https://vendor.example/unsub?u=123>' }
				],
				body: { contentType: 'text', content: 'irrelevant' }
			}
		});
		expect(result).toEqual({ isBulk: true, reason: 'list_unsubscribe_header' });
	});

	it('flags bodies containing an unsubscribe phrase (Dutch or English)', () => {
		const englishResult = detectBulkMail({
			provider: EmailProvider.MICROSOFT,
			raw: {
				body: {
					contentType: 'html',
					content: '<p>Some marketing copy</p><a href="https://x.example/u">click here to remove yourself from our emails list</a>'
				}
			}
		});
		expect(englishResult).toEqual({ isBulk: true, reason: 'body_unsubscribe_phrase' });

		const dutchResult = detectBulkMail({
			provider: EmailProvider.MICROSOFT,
			raw: {
				body: {
					contentType: 'html',
					content: '<p>Marketing copy</p><a href="https://x.example/u">Uitschrijven</a>'
				}
			}
		});
		expect(dutchResult).toEqual({ isBulk: true, reason: 'body_unsubscribe_phrase' });
	});

	it('flags bodies with two or more tracking-domain links', () => {
		const result = detectBulkMail({
			provider: EmailProvider.MICROSOFT,
			raw: {
				body: {
					contentType: 'html',
					content: '<a href="https://bit.ly/abc">CTA</a><a href="https://mailchi.mp/xyz">More</a>'
				}
			}
		});
		expect(result.isBulk).toBe(true);
		expect(result.reason).toBe('tracking_link_density');
	});

	it('does NOT flag a single tracking link (real customers occasionally use bit.ly too)', () => {
		const result = detectBulkMail({
			provider: EmailProvider.MICROSOFT,
			raw: {
				body: {
					contentType: 'text',
					content: 'Hi, can you send me a quote? Reference site: https://bit.ly/our-project'
				}
			}
		});
		expect(result).toEqual({ isBulk: false, reason: null });
	});

	it('does NOT flag a plain customer message with no bulk signals', () => {
		const result = detectBulkMail({
			provider: EmailProvider.MICROSOFT,
			raw: {
				body: {
					contentType: 'text',
					content: 'Goedemiddag, wij willen graag een offerte ontvangen voor een nieuwe CV-ketel.'
				}
			}
		});
		expect(result).toEqual({ isBulk: false, reason: null });
	});

	it('finds bulk phrases inside Gmail multi-part base64-encoded bodies', () => {
		const result = detectBulkMail({
			provider: EmailProvider.GMAIL,
			raw: {
				payload: {
					mimeType: 'multipart/alternative',
					parts: [
						{
							mimeType: 'text/plain',
							body: {
								data: encodeGmailBody(
									'Aanbieding voor isolatie\n\nKlik hier om u uit te schrijven (unsubscribe)'
								)
							}
						}
					]
				}
			}
		});
		expect(result).toEqual({ isBulk: true, reason: 'body_unsubscribe_phrase' });
	});
});
