// Entry point for the github-core-clone-01 forge.
//
// This process is the bridge between the forge and the trial harness. It does
// three things, in order, and nothing else:
//
//   1. It starts the forge's HTTP server on a port the kernel chooses.
//   2. It tells the harness which port that is, so the suite can dial it.
//   3. It waits until the harness says the trial is over, then shuts down.
//
// The harness address comes from MAKEFUN_ENV_URL. With no such variable there
// is nobody to talk to, so the process gives up immediately with exit code 1.
//
// The forge itself lives in app.ts; this file only owns the lifecycle above.
// It uses nothing but the Node standard library (plus the app it starts).

import { createApp } from './app.ts';

/** The harness origin, with any trailing slashes stripped. Empty when unset. */
const harnessOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (harnessOrigin === '') {
  process.stderr.write('no harness to register with: set MAKEFUN_ENV_URL\n');
  process.exit(1);
}

/** Longest a single harness request may run before it is abandoned. */
const CALL_TIMEOUT_MS = 30_000;
/** Pause before the first retry, and the longest pause between retries. */
const PAUSE_FIRST_MS = 250;
const PAUSE_LIMIT_MS = 2_000;

/** Resolve after `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long to wait before the `n`th retry (n starts at 0): double each time
 * from PAUSE_FIRST_MS, never longer than PAUSE_LIMIT_MS.
 */
function pauseFor(n: number): number {
  let wait = PAUSE_FIRST_MS;
  for (let i = 0; i < Math.min(n, 8); i += 1) wait *= 2;
  return Math.min(wait, PAUSE_LIMIT_MS);
}

/**
 * Tell the harness the port the forge is listening on. Keep trying until the
 * harness accepts it. A 200 means the port was recorded; a 409 means some
 * other entry registered first, which is fine — this process still waits like
 * any other. A 400 or 405 means the request itself was wrong, so there is no
 * point retrying. Anything else (a refused connection, a timeout, an odd
 * status) just means the harness is not ready yet, so wait and try again.
 */
async function announce(port: number): Promise<void> {
  for (let n = 0; ; n += 1) {
    let reply: Response | null = null;
    try {
      reply = await fetch(`${harnessOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // No answer at all: the harness may still be starting. Retry below.
    }
    if (reply !== null) {
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`harness refused the register call with HTTP ${reply.status}`);
      }
    }
    await pause(pauseFor(n));
  }
}

/**
 * Ask the harness, over and over, whether the trial is finished. It answers
 * {"done": false} while the suite is still running and {"done": true} once
 * the export is written. This function only returns on the true answer; a
 * dropped or timed-out request is treated as "not done yet" and retried.
 */
async function waitUntilDone(): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const reply = await fetch(`${harnessOrigin}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Unreachable or slow: still running, so poll again.
    }
    await pause(pauseFor(n));
  }
}

/** Start the forge, announce it, wait for the trial to end, then shut down. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the kernel picks a free one. The harness owns 8080; never bind it.
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind a TCP port');
  }
  process.stdout.write(`forge listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('forge announced; waiting for the trial to finish\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('trial finished\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`entry failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
