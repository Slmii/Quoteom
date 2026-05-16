import { validateEnv } from '@/config/env.schema';
import { NL_CLASSIFIER_FIXTURES } from '@/modules/ai/classifier/fixtures/nl-quote-requests.fixtures';
import { AI_CLIENT } from '@/modules/ai/clients/ai-client.interface';
import { OpenAIClient } from '@/modules/ai/clients/openai-client.service';
import { ExtractorService } from '@/modules/ai/extractor/extractor.service';
import type { ExtractorResult, Urgency } from '@/modules/ai/extractor/extractor.types';
import {
	FIELDS_PER_FIXTURE,
	MIN_FIELDS_PASSING,
	MIN_OVERALL_ACCURACY,
	NL_EXTRACTOR_EXPECTED,
	REFERENCE_DATE_ISO
} from '@/modules/ai/extractor/fixtures/nl-extraction-expected.fixtures';
import { AICallLogger } from '@/modules/ai/logging/ai-call-logger.service';
import { LogService } from '@/modules/logger/log.service';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

/**
 * W4.3 — Live-API accuracy harness for the Dutch extractor.
 *
 * Runs against the real OpenAI API; costs ~€0.10 per run (~14 fixtures × gpt-4o × ~1500
 * tokens each). Skipped automatically when `OPENAI_API_KEY` isn't set.
 *
 * **Grading is per-field, fuzzy where appropriate:**
 *  - `customerEmail` / `urgency`: exact match
 *  - `customerName` / `address` / `requestType`: tokenized overlap ≥50%
 *  - `customerDeadline`: ±2 days, or both null
 *  - `deliverableHints`: ≥50% of expected hints appear as substrings in extracted list
 *
 * Per the W4.3 plan: ≥25/30 cases produce stable, schema-valid extractions. Our corpus
 * is 18 positives, so the equivalent gate is ≥0.85 pass rate (~15/18).
 */

const hasApiKey = !!process.env.OPENAI_API_KEY;
const describeIfKey = hasApiKey ? describe : describe.skip;

describeIfKey('ExtractorService — live OpenAI accuracy', () => {
	jest.setTimeout(180_000); // ~18 calls × up to ~5s each, plus retries

	it(`hits ≥${(MIN_OVERALL_ACCURACY * 100).toFixed(0)}% per-fixture pass rate on the Dutch extraction corpus`, async () => {
		const moduleRef = await Test.createTestingModule({
			imports: [
				ConfigModule.forRoot({
					isGlobal: true,
					validate: validateEnv,
					cache: true
				})
			],
			providers: [
				OpenAIClient,
				{ provide: AI_CLIENT, useExisting: OpenAIClient },
				ExtractorService,
				{ provide: AICallLogger, useValue: { record: () => Promise.resolve() } },
				{ provide: LogService, useValue: { logAction: () => undefined } }
			]
		}).compile();

		const extractor = moduleRef.get(ExtractorService);

		// Pair each expected extraction with its source fixture (looked up by subjectKey).
		const pairs = NL_EXTRACTOR_EXPECTED.map(expected => {
			const fixture = NL_CLASSIFIER_FIXTURES.find(f => f.input.subject === expected.subjectKey);
			if (!fixture) {
				throw new Error(`Extractor fixture references unknown classifier subjectKey: ${expected.subjectKey}`);
			}
			return { expected, fixture };
		});

		const results = await Promise.all(
			pairs.map(async ({ expected, fixture }) => {
				try {
					const result = await extractor.extract(fixture.input, REFERENCE_DATE_ISO);
					return {
						expected,
						subject: fixture.input.subject,
						result,
						error: null as string | null
					};
				} catch (error) {
					return {
						expected,
						subject: fixture.input.subject,
						result: null,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			})
		);

		let passed = 0;
		console.log(`\nExtractor accuracy (Dutch corpus, ${results.length} positives):`);

		for (const r of results) {
			if (!r.result) {
				console.log(`  ❌ "${r.subject}" — extraction failed: ${r.error}`);
				continue;
			}
			const grade = gradeExtraction(r.result, r.expected.expected);
			const acceptable = grade.fieldsPassing >= MIN_FIELDS_PASSING;
			if (acceptable) {
				passed += 1;
				console.log(`  ✅ "${r.subject}" — ${grade.fieldsPassing}/${FIELDS_PER_FIXTURE} fields passed`);
			} else {
				console.log(`  ❌ "${r.subject}" — only ${grade.fieldsPassing}/${FIELDS_PER_FIXTURE} fields passed`);
				for (const miss of grade.misses) {
					console.log(`       ${miss}`);
				}
			}
		}

		const accuracy = passed / results.length;
		console.log(`\n  Overall: ${(accuracy * 100).toFixed(1)}% (${passed}/${results.length} fixtures passed)\n`);

		expect(accuracy).toBeGreaterThanOrEqual(MIN_OVERALL_ACCURACY);
	});
});

if (!hasApiKey) {
	console.log('\n[extractor.accuracy.spec] OPENAI_API_KEY not set — skipping live accuracy test.\n');
}

// ─── Grading helpers ────────────────────────────────────────────────────────────────

interface Grade {
	fieldsPassing: number;
	misses: string[];
}

function gradeExtraction(actual: ExtractorResult, expected: ExtractorResult): Grade {
	const misses: string[] = [];
	let passing = 0;

	const checks: Array<[string, boolean]> = [
		['customerName', fuzzyMatch(actual.customerName, expected.customerName)],
		['customerEmail', exactNullable(actual.customerEmail, expected.customerEmail)],
		['address', fuzzyMatch(actual.address, expected.address)],
		['requestType', fuzzyMatch(actual.requestType, expected.requestType)],
		['urgency', exactUrgency(actual.urgency, expected.urgency)],
		['customerDeadline', dateMatch(actual.customerDeadline, expected.customerDeadline)],
		['deliverableHints', hintsMatch(actual.deliverableHints, expected.deliverableHints)]
	];

	for (const [name, ok] of checks) {
		if (ok) {
			passing += 1;
		} else {
			const actualVal = (actual as unknown as Record<string, unknown>)[name];
			const expectedVal = (expected as unknown as Record<string, unknown>)[name];
			misses.push(`${name}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`);
		}
	}

	return { fieldsPassing: passing, misses };
}

function exactNullable(actual: string | null, expected: string | null): boolean {
	if (actual === null && expected === null) {
		return true;
	}
	if (actual === null || expected === null) {
		return false;
	}
	return actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

function exactUrgency(actual: Urgency, expected: Urgency): boolean {
	return actual === expected;
}

/** Tokenized overlap — accept if ≥50% of expected's tokens appear in actual (case-insensitive). */
function fuzzyMatch(actual: string | null, expected: string | null): boolean {
	if (actual === null && expected === null) {
		return true;
	}
	if (actual === null || expected === null) {
		return false;
	}
	const tokenize = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9À-ſ\s]/g, ' ')
			.split(/\s+/)
			.filter(t => t.length >= 3);
	const actualTokens = new Set(tokenize(actual));
	const expectedTokens = tokenize(expected);
	if (expectedTokens.length === 0) {
		// Expected was punctuation-only or all stopwords; if actual is similarly minimal accept.
		return actual.trim().length === 0 || actual === expected;
	}
	const hits = expectedTokens.filter(t => actualTokens.has(t)).length;
	return hits / expectedTokens.length >= 0.5;
}

/** ±2 days, or both null. */
function dateMatch(actual: string | null, expected: string | null): boolean {
	if (actual === null && expected === null) {
		return true;
	}
	if (actual === null || expected === null) {
		return false;
	}
	const a = Date.parse(actual);
	const e = Date.parse(expected);
	if (Number.isNaN(a) || Number.isNaN(e)) {
		return false;
	}
	const diffDays = Math.abs(a - e) / (1000 * 60 * 60 * 24);
	return diffDays <= 2;
}

/**
 * ≥50% of expected hints have at least one extracted hint that contains them as a
 * case-insensitive substring (or vice-versa). Lenient on purpose — phrasings vary.
 */
function hintsMatch(actual: string[], expected: string[]): boolean {
	if (expected.length === 0) {
		return true; // Nothing required; pass.
	}
	const lowerActual = actual.map(h => h.toLowerCase());
	let hits = 0;
	for (const e of expected) {
		const expectedLower = e.toLowerCase();
		const found = lowerActual.some(a => a.includes(expectedLower) || expectedLower.includes(a));
		if (found) {
			hits += 1;
		}
	}
	return hits / expected.length >= 0.5;
}
