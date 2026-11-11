/**
 * Deterministic crash injection for the crash harness. With SIFT_CRASH_AT=<point>:<n>, the process
 * kills itself with SIGKILL the n-th time it reaches <point>. Unset, this is a no-op.
 */
export type CrashPoint =
  | "wal.beforeFsync"
  | "wal.afterFsync"
  | "store.afterSegment"
  | "store.afterManifest"
  | "store.midCompaction";

const spec = process.env.SIFT_CRASH_AT ?? "";
const [target, nth] = spec.split(":");
const limit = Number(nth ?? 1);
let hits = 0;

/**
 * Known-bad recovery for checking that the crash harness can see a bug: with
 * SIFT_FAULT=skip-wal-replay, records acknowledged after the last flush are not rebuilt on open.
 * The harness must then report lost records. Never set outside that check.
 */
export const skipWalReplay = process.env.SIFT_FAULT === "skip-wal-replay";

export function crashPoint(point: CrashPoint): void {
  if (!spec || point !== target) return;
  hits += 1;
  if (hits >= limit) process.kill(process.pid, "SIGKILL");
}
