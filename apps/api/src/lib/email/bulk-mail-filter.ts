import { EmailProvider } from '@/generated/prisma/enums';

/**
 * Heuristic pre-filter that short-circuits the classifier for emails that are
 * unambiguously bulk/marketing — the kind that uses quote-request vocabulary
 * ("offerte aanvragen", "free quotes") to bait clicks but is sent by a vendor, not
 * a prospective customer.
 *
 * Conservative by design: we only mark `isBulk: true` on STRONG signals because a
 * false positive here means dropping a real customer's quote request on the floor —
 * much worse than a few marketing emails sneaking through to the classifier. If you
 * tighten the rules later, run the classifier accuracy harness first to confirm no
 * regression on the positive fixtures.
 */

export interface BulkMailFilterInput {
	provider: EmailProvider;
	raw: unknown;
}

export interface BulkMailFilterResult {
	isBulk: boolean;
	/** Why we decided it's bulk — stored as `metadata.reason` on the skip log. */
	reason: 'list_unsubscribe_header' | 'body_unsubscribe_phrase' | 'tracking_link_density' | null;
}

const TRACKING_LINK_THRESHOLD = 2;

// Phrases that almost only appear in bulk-mail footers. Lowercased; we match
// case-insensitively against the rendered text. Keep this list signal-dense — generic
// phrases like "click here" alone are NOT enough; the surrounding "unsubscribe" /
// "remove yourself" context is what makes it a bulk-mail tell.
const BULK_FOOTER_PHRASES = [
	'unsubscribe',
	'remove yourself from',
	'remove me from this list',
	'manage your preferences',
	'manage your email preferences',
	'manage subscription',
	'opt out of these emails',
	'uitschrijven',
	'afmelden voor deze e-mails',
	'afmelden van deze mailing',
	'je voorkeuren beheren',
	'verwijder mij van deze lijst'
];

// URL-shortener / tracking domains commonly used by bulk-mail platforms. Two or more
// of these in one body is a high-confidence "bulk send" signal — real one-to-one
// emails don't usually contain multiple tracking redirects.
const TRACKING_HOST_PATTERNS = [
	/bit\.ly/i,
	/t\.co/i,
	/tinyurl\.com/i,
	/ow\.ly/i,
	/buff\.ly/i,
	/list-manage\.com/i,
	/mailchi\.mp/i,
	/sendgrid\.net/i,
	/hubspot(?:links|email)/i,
	/click\.[\w-]+\.[\w.-]+/i, // common pattern: click.exacttarget.com etc.
	/track\.[\w-]+\.[\w.-]+/i,
	/email\.[\w-]+\.[\w.-]+\/c\//i // generic email tracking redirect path
];

export function detectBulkMail(input: BulkMailFilterInput): BulkMailFilterResult {
	if (input.provider === EmailProvider.GMAIL && hasGmailListUnsubscribeHeader(input.raw)) {
		return { isBulk: true, reason: 'list_unsubscribe_header' };
	}

	if (input.provider === EmailProvider.MICROSOFT && hasMicrosoftListUnsubscribeHeader(input.raw)) {
		return { isBulk: true, reason: 'list_unsubscribe_header' };
	}

	const body = extractRawBody(input);
	if (!body) {
		return { isBulk: false, reason: null };
	}

	if (containsBulkFooterPhrase(body)) {
		return { isBulk: true, reason: 'body_unsubscribe_phrase' };
	}

	if (trackingLinkCount(body) >= TRACKING_LINK_THRESHOLD) {
		return { isBulk: true, reason: 'tracking_link_density' };
	}

	return { isBulk: false, reason: null };
}

function hasGmailListUnsubscribeHeader(raw: unknown): boolean {
	const headers = asRecord(raw)?.payload as { headers?: unknown } | undefined;
	const headerArray = headers?.headers;
	if (!Array.isArray(headerArray)) {
		return false;
	}
	return headerArray.some(h => {
		const header = asRecord(h);
		const name = typeof header?.name === 'string' ? header.name.toLowerCase() : '';
		const value = typeof header?.value === 'string' ? header.value : '';
		return name === 'list-unsubscribe' && value.trim().length > 0;
	});
}

function hasMicrosoftListUnsubscribeHeader(raw: unknown): boolean {
	const headers = asRecord(raw)?.internetMessageHeaders;
	if (!Array.isArray(headers)) {
		return false;
	}
	return headers.some(h => {
		const header = asRecord(h);
		const name = typeof header?.name === 'string' ? header.name.toLowerCase() : '';
		const value = typeof header?.value === 'string' ? header.value : '';
		return name === 'list-unsubscribe' && value.trim().length > 0;
	});
}

function extractRawBody(input: BulkMailFilterInput): string {
	const record = asRecord(input.raw);
	if (!record) {
		return '';
	}

	if (input.provider === EmailProvider.MICROSOFT) {
		const body = asRecord(record.body);
		const content = typeof body?.content === 'string' ? body.content : '';
		const preview = typeof record.bodyPreview === 'string' ? record.bodyPreview : '';
		return `${content}\n${preview}`;
	}

	// Gmail: walk the (potentially nested) payload bodies. Heuristic doesn't need
	// HTML-stripped clean text — the link/phrase patterns work on raw HTML too.
	const collected: string[] = [];
	const snippet = typeof record.snippet === 'string' ? record.snippet : '';
	if (snippet) {
		collected.push(snippet);
	}
	collectGmailBodySegments(record.payload, collected, 0);
	return collected.join('\n');
}

interface GmailPayload {
	body?: { data?: unknown };
	parts?: unknown;
}

const MAX_MIME_DEPTH = 20;

function collectGmailBodySegments(payload: unknown, sink: string[], depth: number): void {
	if (depth > MAX_MIME_DEPTH) {
		return;
	}
	const node = asRecord(payload) as GmailPayload | null;
	if (!node) {
		return;
	}
	const data = typeof node.body?.data === 'string' ? decodeBase64Url(node.body.data) : '';
	if (data) {
		sink.push(data);
	}
	if (Array.isArray(node.parts)) {
		for (const part of node.parts) {
			collectGmailBodySegments(part, sink, depth + 1);
		}
	}
}

function decodeBase64Url(value: string): string {
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	return Buffer.from(padded, 'base64').toString('utf8');
}

function containsBulkFooterPhrase(body: string): boolean {
	const lower = body.toLowerCase();
	return BULK_FOOTER_PHRASES.some(phrase => lower.includes(phrase));
}

function trackingLinkCount(body: string): number {
	let count = 0;
	for (const pattern of TRACKING_HOST_PATTERNS) {
		if (pattern.test(body)) {
			count++;
		}
		if (count >= TRACKING_LINK_THRESHOLD) {
			return count;
		}
	}
	return count;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}
