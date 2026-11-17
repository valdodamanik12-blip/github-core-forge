// Process lifecycle for the forge entry: how this program and the trial
// harness (the "env") divide the work, as the kit's wire contract settles it.
//
//   - The env names its own origin in MAKEFUN_ENV_URL. With no origin there
//     is nobody to register with, so the program refuses to start.
//   - The forge server binds port 0 and lets the kernel pick a free port.
//     Port 8080 is the env's own listener and is never ours to take.
//   - We announce the bound port with POST /register. The env pairs the
//     announced port with the source address of that request and treats the
//     combination as our base URL for the rest of the trial.
//   - From then on we poll GET /done. While the suite is still running the
//     answer is {"done": false}; only {"done": true} ends the trial, and
//     only then do we close the server and exit 0.
//
// The overriding rule is that this process must not die early: a crash, an
// early exit, or a registration that never lands leaves the env with no
// working forge and scores zero everywhere. So every network step retries
// through transient trouble, and only an answer the contract declares
// unrecoverable is allowed to end the program (with exit 1).

import { createApp } from './app.ts';

/** An env answer the contract treats as final: retrying cannot change it. */
class Unrecoverable extends Error {}

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  console.error('[forge-entry] MAKEFUN_ENV_URL is not set, so there is no env to register with');
  process.exit(1);
}

/** Longest a single register or done request may run before we abandon it. */
const REQUEST_BUDGET_MS = 30_000;
/** Wait after the first failure, and the ceiling the wait grows to. */
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait following `failures` consecutive failures: doubling, capped. */
function waitAfter(failures: number): number {
  let ms = FIRST_WAIT_MS;
  for (let i = 0; i < failures && ms < LONGEST_WAIT_MS; i += 1) ms *= 2;
  return Math.min(ms, LONGEST_WAIT_MS);
}

/**
 * Tell the env which port we bound, retrying until it accepts the news.
 * 200 means the env recorded us; 409 means an earlier register already won
 * the slot, which is the env's settled state rather than our error, so it
 * also ends the announcements. 400 and 405 are contract violations and are
 * unrecoverable. Anything else — a refused connection while the env is
 * still starting, a timeout, a 5xx — is retried after a growing wait.
 */
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let accepted = false;
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (reply.status === 200 || reply.status === 409) {
        accepted = true;
      } else if (reply.status === 400 || reply.status === 405) {
        throw new Unrecoverable(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Unrecoverable) throw err;
      // The request itself failed; the env may not be up yet. Retry below.
    }
    if (accepted) return;
    await wait(waitAfter(failures));
  }
}

/**
 * Ask the env whether the trial is over, and keep asking until it says so.
 * A poll that fails, times out, or answers anything but {"done": true}
 * simply means "not yet": this function returns only on a true answer.
 */
async function awaitTrialEnd(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let finished = false;
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        finished =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      }
    } catch {
      // No usable answer yet: the trial is not over, so poll again.
    }
    if (finished) return;
    await wait(waitAfter(failures));
  }
}

/** Bind, announce, wait: the whole life of the process, in that order. */
async function run(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge server bound without an ephemeral TCP port'));
      } else {
        resolve(address.port);
      }
    });
  });
  console.log(`[forge-entry] listening on port ${port}`);
  // The bind-time error listener above has done its job by now; from here a
  // server error is worth a log line, never a reason to abandon the trial.
  server.on('error', (err) => {
    console.error(`[forge-entry] server error after bind: ${err.message}`);
  });

  await announcePort(port);
  console.log('[forge-entry] registered with the env; waiting for the trial to end');

  await awaitTrialEnd();
  // Close the listener and drop any idle keep-alive sockets the suite left
  // open, so shutdown is not held up by connections nobody will use again.
  server.close();
  server.closeIdleConnections();
  console.log('[forge-entry] the env says done; exiting');
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[forge-entry] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
