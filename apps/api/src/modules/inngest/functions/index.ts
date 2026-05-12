import { heartbeatFn } from '@/modules/inngest/functions/heartbeat.function';
import { helloFn } from '@/modules/inngest/functions/hello.function';

/**
 * Every Inngest function in the app, in the order Inngest expects them at the
 * `/api/inngest` discovery endpoint. New functions: import + add to this array; they'll
 * show up in the dev UI on next reload.
 *
 * Future W3.4 / W3.5 / W3.6 functions register here too — keep this list flat (no
 * per-domain nested arrays) so the registration surface stays trivially auditable.
 */
export const inngestFunctions = [helloFn, heartbeatFn];
