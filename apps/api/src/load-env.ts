// Side-effect-only module: loads apps/api/.env into process.env.
// Imported as the very first line of main.ts so any subsequent module
// (e.g. auth.config which builds a PrismaClient at module-init time)
// sees the env vars when its top-level code runs.
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env') });

// Diagnostic: log the auth-critical env values on every boot so it's obvious
// whether the running process has the values you expect after a .env edit.
// Remove these logs once the auth flow is settled.
console.log('[boot] AUTH_URL =', process.env.AUTH_URL);
console.log('[boot] WEB_ORIGIN =', process.env.WEB_ORIGIN);
