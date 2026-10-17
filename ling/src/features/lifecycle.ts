import type { HarnessExtensionApi } from "../harness/index.js";

/**
 * Register feature teardown that runs at most once, however often the event fires.
 *
 * Pi raises `session_shutdown` on reload and on session replacement, and the
 * runner raises it explicitly because a one-shot task triggers neither. That
 * leaves the door open to a duplicate: a future Pi that also fires it from
 * `dispose()` would run every feature's cleanup twice. Teardown that closes a
 * browser or reports artifacts must not care, so idempotence lives here rather
 * than being re-derived in each feature.
 *
 * Concurrent events share the first call's promise, so a second event waits for
 * the in-flight teardown instead of starting its own.
 */
export function onShutdownOnce(
  pi: HarnessExtensionApi,
  teardown: () => Promise<void>,
): void {
  let started: Promise<void> | undefined;
  pi.on("session_shutdown", async () => {
    started ??= teardown();
    await started;
  });
}
