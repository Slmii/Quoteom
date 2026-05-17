#!/usr/bin/env node
/**
 * Reads `apps/api/.ai-reports/runs.jsonl` (appended to by the accuracy specs) and writes
 * a freshly-rendered `apps/api/.ai-reports/index.html` you can open in a browser to
 * review accuracy runs grouped by date.
 *
 * Each fixture renders as ONE unified row that combines:
 *  - The email input (subject + from + body)
 *  - The classifier result (expected/got/confidence/reason)
 *  - The extractor result, when present (per-field table)
 *
 * Negatives only have classifier data; positives + edge-positives have both. Matching is
 * by `subject` since the two specs use the same source fixtures.
 *
 * Local-only — both the JSONL and HTML are gitignored. Safe to delete `.ai-reports/`
 * any time; the next harness run regenerates it.
 *
 * No external dependencies; pure Node + inline CSS. Use `<details>` for collapsibility
 * so no JavaScript is needed in the rendered page.
 */

const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const REPORTS_DIR = join(__dirname, '..', '.ai-reports');
const JSONL_PATH = join(REPORTS_DIR, 'runs.jsonl');
const HTML_PATH = join(REPORTS_DIR, 'index.html');

if (!existsSync(JSONL_PATH)) {
	console.log('[build-ai-report] No runs.jsonl found — skipping HTML build.');
	process.exit(0);
}

const entries = readFileSync(JSONL_PATH, 'utf8')
	.split('\n')
	.filter(line => line.trim().length > 0)
	.map(line => {
		try {
			return JSON.parse(line);
		} catch (err) {
			console.warn('[build-ai-report] Skipping malformed JSONL line:', err.message);
			return null;
		}
	})
	.filter(Boolean);

// Group entries into runs by runId.
const runsById = new Map();
for (const e of entries) {
	if (!runsById.has(e.runId)) {
		runsById.set(e.runId, { runId: e.runId, timestamp: e.timestamp, classifier: null, extractor: null });
	}
	const run = runsById.get(e.runId);
	if (e.kind === 'classifier') run.classifier = e;
	if (e.kind === 'extractor') run.extractor = e;
	if (e.timestamp > run.timestamp) run.timestamp = e.timestamp;
}

const allRuns = Array.from(runsById.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));

// Group by calendar date.
const byDate = new Map();
for (const run of allRuns) {
	const date = run.timestamp.slice(0, 10);
	if (!byDate.has(date)) byDate.set(date, []);
	byDate.get(date).push(run);
}

const html = renderHtml(byDate, allRuns.length);
writeFileSync(HTML_PATH, html);
console.log(`[build-ai-report] HTML written to ${HTML_PATH} (${allRuns.length} runs total)`);

// ─── Rendering helpers ──────────────────────────────────────────────────────────────

function escapeHtml(str) {
	if (str === null || str === undefined) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function fmtTime(iso) {
	return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtPct(n) {
	return (n * 100).toFixed(1) + '%';
}

function classifierSummaryLine(c) {
	if (!c) return '<span class="muted">Classifier: not run</span>';
	const s = c.summary;
	return `<span><strong>Classifier:</strong> ${fmtPct(s.overall)} <span class="muted">(${s.correct}/${s.total})</span></span>`;
}

function extractorSummaryLine(e) {
	if (!e) return '<span class="muted">Extractor: not run</span>';
	const s = e.summary;
	return `<span><strong>Extractor:</strong> ${fmtPct(s.overall)} <span class="muted">(${s.passed}/${s.total} fixtures passed)</span></span>`;
}

/**
 * Build the unified per-fixture list for one run. Each row has a classifier slot and an
 * extractor slot. Negatives only have classifier; positives/edge-positives have both
 * (assuming both kinds ran in this session).
 */
function buildUnifiedFixtures(run) {
	const classifierFixtures = run.classifier?.fixtures ?? [];
	const extractorFixtures = run.extractor?.fixtures ?? [];

	const extractorBySubject = new Map(extractorFixtures.map(f => [f.subject ?? '', f]));
	const unified = [];
	const seenSubjects = new Set();

	for (const cf of classifierFixtures) {
		seenSubjects.add(cf.subject);
		unified.push({
			subject: cf.subject,
			category: cf.category,
			notes: cf.notes,
			input: cf.input,
			classifier: cf,
			extractor: extractorBySubject.get(cf.subject ?? '') ?? null
		});
	}

	// Extractor-only fixtures (rare — only if user ran `:extractor` alone after deleting
	// the classifier JSONL row, but we should still display them).
	for (const ef of extractorFixtures) {
		if (seenSubjects.has(ef.subject ?? '')) continue;
		unified.push({
			subject: ef.subject,
			category: 'edge', // unknown without classifier — assume edge
			notes: ef.notes,
			input: ef.input,
			classifier: null,
			extractor: ef
		});
	}

	return unified;
}

function fixtureSummaryRow(f) {
	const classifierMark = f.classifier
		? f.classifier.correct
			? '<span class="pass">✓</span>'
			: '<span class="fail">✗</span>'
		: '<span class="muted">—</span>';

	const extractorMark = f.extractor
		? f.extractor.error
			? '<span class="fail">!</span>'
			: f.extractor.acceptable
				? `<span class="pass">✓ ${f.extractor.fieldsPassing}/${f.extractor.totalFields}</span>`
				: `<span class="fail">✗ ${f.extractor.fieldsPassing}/${f.extractor.totalFields}</span>`
		: '<span class="muted">—</span>';

	const categoryPill = `<span class="pill pill-${f.category}">${f.category}</span>`;

	return `
		<div class="fixture-summary">
			<span class="marks">
				<span class="mark-group">cls ${classifierMark}</span>
				<span class="mark-group">ext ${extractorMark}</span>
			</span>
			${categoryPill}
			<span class="subject">${escapeHtml(f.subject || '(geen onderwerp)')}</span>
		</div>
	`;
}

function emailInputBlock(input) {
	if (!input) return '';
	const fromLine = input.fromName
		? `${escapeHtml(input.fromName)} &lt;${escapeHtml(input.fromEmail || '?')}&gt;`
		: escapeHtml(input.fromEmail || '?');
	return `
		<div class="email-input">
			<div class="meta-row"><span class="meta-label">Subject:</span> ${escapeHtml(input.subject || '(geen onderwerp)')}</div>
			<div class="meta-row"><span class="meta-label">From:</span> ${fromLine}</div>
			<pre class="body">${escapeHtml(input.bodyText || '')}</pre>
		</div>
	`;
}

function classifierResultBlock(c) {
	if (!c) return '<p class="muted">Classifier not run for this fixture.</p>';
	const mark = c.correct ? '<span class="pass">✓ correct</span>' : '<span class="fail">✗ incorrect</span>';
	return `
		<div class="result-block">
			<div class="result-header">
				<strong>Classifier</strong> ${mark}
			</div>
			<table class="result-table">
				<tr><td>expected</td><td><code>${c.expected}</code></td></tr>
				<tr><td>got</td><td><code>${c.got === null ? 'null' : c.got}</code></td></tr>
				<tr><td>confidence</td><td><code>${c.confidence != null ? c.confidence.toFixed(2) : 'n/a'}</code></td></tr>
				<tr><td>reason</td><td class="reason">${escapeHtml(c.reason || '')}</td></tr>
			</table>
		</div>
	`;
}

function extractorResultBlock(e) {
	if (!e) {
		return `
			<div class="result-block muted">
				<div class="result-header"><strong>Extractor</strong> not run (negative classifications skip the extractor)</div>
			</div>
		`;
	}

	if (e.error) {
		return `
			<div class="result-block">
				<div class="result-header"><strong>Extractor</strong> <span class="fail">! extraction failed</span></div>
				<p class="error">${escapeHtml(e.error)}</p>
			</div>
		`;
	}

	const mark = e.acceptable
		? `<span class="pass">✓ ${e.fieldsPassing}/${e.totalFields} fields</span>`
		: `<span class="fail">✗ only ${e.fieldsPassing}/${e.totalFields} fields</span>`;

	const fieldRows = e.fields
		.map(field => {
			const fieldMark = field.ok ? '<span class="pass">✓</span>' : '<span class="fail">✗</span>';
			const actual = `<code>${escapeHtml(JSON.stringify(field.actual))}</code>`;
			if (field.ok) {
				return `<tr><td>${fieldMark}</td><td><strong>${field.name}</strong></td><td colspan="2">${actual}</td></tr>`;
			}
			const expected = `<code>${escapeHtml(JSON.stringify(field.expected))}</code>`;
			return `<tr class="row-fail"><td>${fieldMark}</td><td><strong>${field.name}</strong></td><td>expected: ${expected}</td><td>got: ${actual}</td></tr>`;
		})
		.join('');

	return `
		<div class="result-block">
			<div class="result-header"><strong>Extractor</strong> ${mark}</div>
			<table class="result-table extractor-fields">
				<thead><tr><th></th><th>Field</th><th colspan="2">Value</th></tr></thead>
				<tbody>${fieldRows}</tbody>
			</table>
		</div>
	`;
}

function fixtureBlock(f) {
	// Auto-expand if either side failed.
	const failed =
		(f.classifier && !f.classifier.correct) || (f.extractor && (f.extractor.error || !f.extractor.acceptable));
	const openAttr = failed ? 'open' : '';
	const rowClass = failed ? 'fixture row-fail' : 'fixture';

	return `
		<details class="${rowClass}" ${openAttr}>
			<summary>${fixtureSummaryRow(f)}</summary>
			<div class="fixture-detail">
				${emailInputBlock(f.input)}
				<div class="result-columns">
					${classifierResultBlock(f.classifier)}
					${extractorResultBlock(f.extractor)}
				</div>
				${f.notes ? `<p class="notes"><strong>Fixture notes:</strong> ${escapeHtml(f.notes)}</p>` : ''}
			</div>
		</details>
	`;
}

function runBlock(run) {
	const fixtures = buildUnifiedFixtures(run);
	return `
		<section class="run">
			<header>
				<h3>Run @ ${fmtTime(run.timestamp)} <span class="muted">(${escapeHtml(run.runId)})</span></h3>
				<p class="run-summary">
					${classifierSummaryLine(run.classifier)} &nbsp;·&nbsp;
					${extractorSummaryLine(run.extractor)}
				</p>
			</header>
			<div class="fixtures">
				${fixtures.map(fixtureBlock).join('')}
			</div>
		</section>
	`;
}

function dateBlock(date, runs, isLatest) {
	// Latest date opens automatically; older dates collapse to keep the page scannable
	// after weeks of iteration. Click any date header to expand/collapse.
	const openAttr = isLatest ? 'open' : '';
	return `
		<details class="date" ${openAttr}>
			<summary><h2>${date} <span class="muted">(${runs.length} run${runs.length === 1 ? '' : 's'})</span></h2></summary>
			<div class="date-runs">
				${runs.map(runBlock).join('')}
			</div>
		</details>
	`;
}

function renderHtml(byDate, totalRuns) {
	const dates = Array.from(byDate.entries()).sort((a, b) => b[0].localeCompare(a[0]));
	const generatedAt = new Date().toISOString();

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<title>Quoteom — AI Accuracy Reports</title>
	<style>
		body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1300px; margin: 2rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
		h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
		h2 { font-size: 1.15rem; border-bottom: 2px solid #ddd; padding-bottom: 0.3rem; margin-top: 2rem; }
		h3 { font-size: 1rem; margin: 0.5rem 0; }
		details.date { margin-top: 2rem; }
		details.date > summary { list-style: none; cursor: pointer; }
		details.date > summary::-webkit-details-marker { display: none; }
		details.date > summary h2 { margin-top: 0; display: flex; align-items: center; }
		details.date > summary h2::before { content: '▶'; display: inline-block; transform: rotate(0deg); transition: transform 0.1s; margin-right: 0.5rem; color: #888; font-size: 0.85rem; }
		details.date[open] > summary h2::before { transform: rotate(90deg); }
		details.date > summary:hover h2 { color: #000; }
		.date-runs { margin-top: 0.25rem; }
		.muted { color: #888; font-weight: normal; }
		.pass { color: #1f8a3e; font-weight: bold; }
		.fail { color: #c63a3a; font-weight: bold; }
		.error { color: #c63a3a; font-style: italic; }
		.pill { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 10px; background: #eef; font-size: 0.75rem; margin-right: 0.5rem; font-weight: 500; }
		.pill-positive { background: #d4f0d4; }
		.pill-negative { background: #f5d4d4; }
		.pill-edge { background: #f0e4d4; }
		section.run { border: 1px solid #ddd; border-radius: 6px; padding: 1rem 1.25rem; margin: 1rem 0; background: #fafafa; }
		section.run > header { border-bottom: 1px solid #eee; margin-bottom: 0.75rem; padding-bottom: 0.5rem; }
		.run-summary { margin: 0.25rem 0; font-size: 0.9rem; }
		details.fixture { margin: 0.4rem 0; border: 1px solid #e3e3e3; border-radius: 4px; background: #fff; }
		details.fixture > summary { cursor: pointer; padding: 0.5rem 0.75rem; list-style: none; }
		details.fixture > summary::-webkit-details-marker { display: none; }
		details.fixture > summary::before { content: '▶'; display: inline-block; transform: rotate(0deg); transition: transform 0.1s; margin-right: 0.5rem; color: #888; font-size: 0.75rem; }
		details.fixture[open] > summary::before { transform: rotate(90deg); }
		details.fixture:hover > summary { background: #f8f8f8; }
		details.fixture.row-fail { border-color: #f0b3b3; background: #fffafa; }
		details.fixture.row-fail > summary { background: #fff3f0; }
		.fixture-summary { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
		.marks { font-family: monospace; font-size: 0.85rem; }
		.mark-group { display: inline-block; padding: 0.05rem 0.4rem; background: #f0f0f0; border-radius: 3px; margin-right: 0.3rem; }
		.subject { font-weight: 500; }
		.fixture-detail { padding: 0 1rem 1rem 1rem; }
		.email-input { background: #f5f7fa; border-left: 3px solid #b0c4de; padding: 0.75rem 1rem; margin-bottom: 1rem; border-radius: 0 4px 4px 0; }
		.email-input .meta-row { font-size: 0.85rem; margin: 0.15rem 0; }
		.email-input .meta-label { color: #666; font-weight: 500; display: inline-block; min-width: 60px; }
		.email-input .body { background: #fff; border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem; margin-top: 0.5rem; font-size: 0.85rem; font-family: -apple-system, sans-serif; white-space: pre-wrap; word-wrap: break-word; max-height: 400px; overflow-y: auto; }
		.result-columns { display: grid; grid-template-columns: 1fr 1.5fr; gap: 1rem; }
		@media (max-width: 900px) { .result-columns { grid-template-columns: 1fr; } }
		.result-block { background: #fff; border: 1px solid #e3e3e3; border-radius: 4px; padding: 0.75rem; }
		.result-block.muted { background: #fafafa; }
		.result-header { font-size: 0.9rem; margin-bottom: 0.5rem; padding-bottom: 0.3rem; border-bottom: 1px solid #eee; }
		.result-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
		.result-table td, .result-table th { padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; border-bottom: 1px solid #f0f0f0; }
		.result-table th { background: #f5f5f5; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
		.result-table tr.row-fail td { background: #fff7f5; }
		.extractor-fields code { word-break: break-word; }
		code { background: #f5f5f5; padding: 0.05rem 0.3rem; border-radius: 3px; font-size: 0.85rem; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
		.reason { color: #555; max-width: 30rem; }
		.notes { font-size: 0.85rem; color: #666; background: #fffce8; border-left: 3px solid #e4c14a; padding: 0.4rem 0.75rem; margin-top: 0.75rem; border-radius: 0 4px 4px 0; }
		footer { color: #888; font-size: 0.8rem; margin-top: 3rem; text-align: center; border-top: 1px solid #eee; padding-top: 1rem; }
	</style>
</head>
<body>
	<h1>Quoteom — AI Accuracy Reports</h1>
	<p class="muted">${totalRuns} total run${totalRuns === 1 ? '' : 's'} across ${dates.length} day${dates.length === 1 ? '' : 's'}. Local-only; not pushed to GitHub.</p>
	${dates.map(([date, runs], index) => dateBlock(date, runs, index === 0)).join('')}
	<footer>Generated ${escapeHtml(generatedAt)} · scripts/build-ai-report.cjs</footer>
</body>
</html>`;
}
