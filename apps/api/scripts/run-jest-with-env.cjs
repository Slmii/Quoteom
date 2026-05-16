#!/usr/bin/env node
/**
 * Tiny launcher: load `.env` into process.env, then hand off to Jest's CLI.
 *
 * Why we need this:
 *  - `pnpm test:ai` runs the live-API accuracy specs which read `process.env.OPENAI_API_KEY`.
 *  - Jest config doesn't auto-load `.env` (deliberately — running normal `pnpm test` shouldn't
 *    silently burn OpenAI credit).
 *  - Pnpm's `.bin/jest` symlink layout differs from npm's, so `node -r dotenv/config
 *    node_modules/.bin/jest` (the npm-style invocation) breaks under pnpm.
 *
 * This script uses Node's standard module resolver to find Jest (which pnpm + npm both
 * support), so it works under either package manager.
 */

require('dotenv').config();
require('jest/bin/jest');
