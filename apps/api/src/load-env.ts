// Side-effect-only module: loads apps/api/.env into process.env.
// Imported as the very first line of main.ts so any subsequent module
// (e.g. auth.config which builds a PrismaClient at module-init time)
// sees the env vars when its top-level code runs.
import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../.env') });
