/**
 * Hang deadline for design-kit tests.
 *
 * design-kit is published as a standalone mirror tree (scripts/design-kit-mirror.mjs)
 * whose tests run without the rest of the monorepo, so they cannot import
 * scripts/test-helpers/timers.mjs. This keeps that helper's withTestDeadline
 * semantics inside the package: the result comes from the work, the timer is
 * unref'd and cleared as soon as the work settles, and a hang becomes a
 * TestDeadlineError naming the event that never arrived.
 */

export class TestDeadlineError extends Error {
  constructor(message, ms) {
    super(`${message} (nothing settled within ${ms} ms)`);
    this.name = "TestDeadlineError";
    this.deadlineMs = ms;
  }
}

export function withTestDeadline(work, { message, ms } = {}) {
  if (typeof message !== "string" || !message.trim())
    throw new TypeError(
      "withTestDeadline needs a message naming the event that did not arrive",
    );
  if (!(Number.isFinite(ms) && ms > 0))
    throw new TypeError("withTestDeadline needs a positive ms");
  const operation =
    typeof work === "function"
      ? Promise.resolve().then(work)
      : Promise.resolve(work);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TestDeadlineError(message, ms)), ms);
    timer?.unref?.();
  });
  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}
