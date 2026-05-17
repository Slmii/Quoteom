import {
	decodeOpportunityListCursor,
	encodeOpportunityListCursor
} from '@/modules/opportunities/opportunity-list-cursor';
import { describe, expect, it } from '@jest/globals';

describe('opportunity-list-cursor', () => {
	const sampleCursor = {
		createdAt: new Date('2026-05-17T10:00:00.000Z'),
		id: '11111111-1111-4111-8111-111111111111'
	};

	it('encode → decode round-trips identical values', () => {
		const encoded = encodeOpportunityListCursor(sampleCursor);
		const decoded = decodeOpportunityListCursor(encoded);

		expect(decoded).not.toBeNull();
		expect(decoded?.id).toBe(sampleCursor.id);
		expect(decoded?.createdAt.toISOString()).toBe(sampleCursor.createdAt.toISOString());
	});

	it('encodes to a URL-safe base64url string (no +/=)', () => {
		const encoded = encodeOpportunityListCursor(sampleCursor);
		expect(encoded).not.toMatch(/[+/=]/);
	});

	it('returns null for null / undefined / empty inputs (tolerant decoder)', () => {
		expect(decodeOpportunityListCursor(null)).toBeNull();
		expect(decodeOpportunityListCursor(undefined)).toBeNull();
		expect(decodeOpportunityListCursor('')).toBeNull();
	});

	it('returns null for garbage / unparseable cursors so a stale URL falls back to page 1', () => {
		expect(decodeOpportunityListCursor('totally-not-a-cursor')).toBeNull();
		// Decodes to a string with no separator.
		expect(decodeOpportunityListCursor(Buffer.from('no-pipe-here', 'utf8').toString('base64url'))).toBeNull();
		// Decodes but the date half is invalid.
		expect(decodeOpportunityListCursor(Buffer.from('not-a-date|some-id', 'utf8').toString('base64url'))).toBeNull();
		// Decodes but the id half is empty.
		expect(
			decodeOpportunityListCursor(Buffer.from('2026-05-17T10:00:00.000Z|', 'utf8').toString('base64url'))
		).toBeNull();
		// Decodes but the date half is empty (separator at index 0).
		expect(decodeOpportunityListCursor(Buffer.from('|some-id', 'utf8').toString('base64url'))).toBeNull();
	});
});
