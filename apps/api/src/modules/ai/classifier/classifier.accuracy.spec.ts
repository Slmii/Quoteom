import { validateEnv } from '@/config/env.schema';
import { ClassifierService } from '@/modules/ai/classifier/classifier.service';
import { NL_CLASSIFIER_FIXTURES } from '@/modules/ai/classifier/fixtures/nl-quote-requests.fixtures';
import { AI_CLIENT } from '@/modules/ai/clients/ai-client.interface';
import { OpenAIClient } from '@/modules/ai/clients/openai-client.service';
import { AICallLogger } from '@/modules/ai/logging/ai-call-logger.service';
import { LogService } from '@/modules/logger/log.service';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';

/**
 * W4.2 — Live-API accuracy harness for the Dutch classifier.
 *
 * **Runs against the real OpenAI API.** This is the harness we use to iterate on the
 * prompt: change `prompts/nl.ts`, run this, see whether accuracy improved or regressed.
 * NOT a unit test of `ClassifierService` itself — that's mocked elsewhere if needed. This
 * test consumes real OpenAI tokens (~€0.01 per run on `gpt-4o-mini`).
 *
 * **Skipped automatically when `OPENAI_API_KEY` isn't set** so CI without a key, fresh
 * checkouts, and contributors without API access don't see false failures. Run manually
 * via `pnpm exec jest classifier.accuracy` once your key is in `.env`.
 *
 * Per the W4.2 plan acceptance criteria: ≥85% overall accuracy on the fixture set.
 * Per-category accuracy is also printed so we can see which slice the prompt struggles
 * with (typically the `edge` category — that's where prompt iteration pays off).
 */

const hasApiKey = !!process.env.OPENAI_API_KEY;
const describeIfKey = hasApiKey ? describe : describe.skip;

// Accuracy threshold for the overall corpus. Tune up as the prompt gets better, but ≥0.85
// is the W4.2 plan's baseline gate.
const MIN_ACCURACY = 0.85;

describeIfKey('ClassifierService — live OpenAI accuracy', () => {
	jest.setTimeout(120_000); // 30 calls × up to ~3s each, plus retries

	it(`hits ≥${(MIN_ACCURACY * 100).toFixed(0)}% accuracy on the Dutch fixture corpus`, async () => {
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
				ClassifierService,
				// Stub AICallLogger — no Prisma connection needed for the harness. Real prod
				// path logs through `AICallLogger` normally.
				{ provide: AICallLogger, useValue: { record: () => Promise.resolve() } },
				// Stub LogService — no Postgres needed.
				{ provide: LogService, useValue: { logAction: () => undefined } }
			]
		}).compile();

		const classifier = moduleRef.get(ClassifierService);

		// Run all fixtures in parallel for speed. The OpenAI SDK rate-limits internally
		// (and our retry budget covers 429s), so 30 concurrent requests is fine on the
		// classifier tier.
		const results = await Promise.all(
			NL_CLASSIFIER_FIXTURES.map(async fixture => {
				try {
					const result = await classifier.classify(fixture.input);
					return {
						fixture,
						result,
						correct: result.isQuote === fixture.expectedIsQuote,
						error: null as string | null
					};
				} catch (error) {
					return {
						fixture,
						result: null,
						correct: false,
						error: error instanceof Error ? error.message : String(error)
					};
				}
			})
		);

		// Per-category breakdown
		const byCategory: Record<string, { correct: number; total: number; misses: typeof results }> = {
			positive: { correct: 0, total: 0, misses: [] },
			negative: { correct: 0, total: 0, misses: [] },
			edge: { correct: 0, total: 0, misses: [] }
		};
		for (const r of results) {
			const c = byCategory[r.fixture.category];
			if (!c) {
				continue;
			}
			c.total += 1;
			if (r.correct) {
				c.correct += 1;
			} else {
				c.misses.push(r);
			}
		}

		const overall = results.filter(r => r.correct).length / results.length;

		// Tabular log so prompt iteration is fast: scan the misses, see why each one
		// flipped, tweak the prompt accordingly.
		console.log(`\nClassifier accuracy (Dutch corpus, ${results.length} fixtures):`);
		console.log(
			`  Overall: ${(overall * 100).toFixed(1)}% (${results.filter(r => r.correct).length}/${results.length})`
		);

		for (const [name, c] of Object.entries(byCategory)) {
			console.log(`  ${name.padEnd(8)}: ${((c.correct / c.total) * 100).toFixed(1)}% (${c.correct}/${c.total})`);
		}

		console.log('\nMisses:');

		for (const r of results.filter(rr => !rr.correct)) {
			const expected = r.fixture.expectedIsQuote;
			const got = r.result?.isQuote;
			const conf = r.result?.confidence;
			const reason = r.result?.reason ?? r.error;
			console.log(
				`  [${r.fixture.category}] subject="${r.fixture.input.subject}" — expected ${expected}, got ${got} (conf=${conf?.toFixed(2)}): ${reason}`
			);
		}

		expect(overall).toBeGreaterThanOrEqual(MIN_ACCURACY);
	});
});

if (!hasApiKey) {
	console.log('\n[classifier.accuracy.spec] OPENAI_API_KEY not set — skipping live accuracy test.\n');
}
