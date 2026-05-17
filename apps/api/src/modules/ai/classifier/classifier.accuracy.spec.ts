import { validateEnv } from '@/config/env.schema';
import { ClassifierService } from '@/modules/ai/classifier/classifier.service';
import { NL_CLASSIFIER_FIXTURES } from '@/modules/ai/classifier/fixtures/nl-quote-requests.fixtures';
import { AI_CLIENT } from '@/modules/ai/clients/ai-client.interface';
import { OpenAIClient } from '@/modules/ai/clients/openai-client.service';
import { AICallLogger } from '@/modules/ai/logging/ai-call-logger.service';
import { LogService } from '@/modules/logger/log.service';
import { appendAiReportEntry } from '@/modules/ai/__test-utils/ai-report-writer';
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
				{ provide: AICallLogger, useValue: { record: () => Promise.resolve(null) } },
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
					const { value: result } = await classifier.classify(fixture.input);
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

		// Verbose per-fixture log so prompt iteration is fast: every fixture's actual vs
		// expected is visible, not just the ones that crossed the threshold. Lets you spot
		// fixtures that "passed" but with low confidence, or misses with high confidence
		// (both are interesting signals for prompt iteration).
		console.log(`\n${'─'.repeat(80)}`);
		console.log('Classifier accuracy — per-fixture results');
		console.log('─'.repeat(80));

		for (const r of results) {
			const expected = r.fixture.expectedIsQuote;
			const got = r.result?.isQuote;
			const conf = r.result?.confidence;
			const reason = r.result?.reason ?? r.error ?? '(no reason)';
			const mark = r.correct ? '✅' : '❌';
			console.log(`${mark} [${r.fixture.category.padEnd(8)}] "${r.fixture.input.subject}"`);
			console.log(`     expected=${expected}  got=${got}  conf=${conf !== undefined ? conf.toFixed(2) : 'n/a'}`);
			console.log(`     reason: ${reason}`);
		}

		console.log(`\n${'─'.repeat(80)}`);
		console.log('Summary');
		console.log('─'.repeat(80));
		console.log(
			`  Overall: ${(overall * 100).toFixed(1)}% (${results.filter(r => r.correct).length}/${results.length})`
		);
		for (const [name, c] of Object.entries(byCategory)) {
			console.log(`  ${name.padEnd(8)}: ${((c.correct / c.total) * 100).toFixed(1)}% (${c.correct}/${c.total})`);
		}
		console.log('');

		// Persist results for the local HTML report (no-op when AI_REPORT_RUN_ID is unset).
		appendAiReportEntry({
			kind: 'classifier',
			summary: {
				overall,
				correct: results.filter(r => r.correct).length,
				total: results.length,
				byCategory: Object.fromEntries(
					Object.entries(byCategory).map(([k, v]) => [k, { correct: v.correct, total: v.total }])
				)
			},
			fixtures: results.map(r => ({
				category: r.fixture.category,
				subject: r.fixture.input.subject,
				notes: r.fixture.notes,
				input: {
					subject: r.fixture.input.subject,
					fromName: r.fixture.input.fromName,
					fromEmail: r.fixture.input.fromEmail,
					bodyText: r.fixture.input.bodyText
				},
				expected: r.fixture.expectedIsQuote,
				got: r.result?.isQuote ?? null,
				confidence: r.result?.confidence ?? null,
				reason: r.result?.reason ?? r.error ?? null,
				correct: r.correct
			}))
		});

		expect(overall).toBeGreaterThanOrEqual(MIN_ACCURACY);
	});
});

if (!hasApiKey) {
	console.log('\n[classifier.accuracy.spec] OPENAI_API_KEY not set — skipping live accuracy test.\n');
}
