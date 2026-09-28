/**
 * How long waiting can plausibly help.
 *
 * The whole taxonomy turns on one question: would the same request produce a
 * different answer later, and on what scale? Retrying anything else is noise,
 * and waiting out something that will never recover is silence.
 *
 *  - `fast`   transport failed — DNS, refused connection, timeout. The cause
 *             is a process or a route, and those come back in seconds. A
 *             proxy that was not up yet when the service started is the
 *             common one, and it costs a two-hour cycle to sit it out.
 *  - `slow`   the server answered, badly (5xx). Recovery is somebody else's
 *             deploy — minutes to hours, which the cycle interval already is.
 *  - `quota`  429. The server is telling us the pace; retrying sooner is how
 *             the window gets extended rather than reset.
 *  - `never`  4xx that is not 429. A wrong key, a wrong path, a deleted item.
 *             Identical in six hours, so the only useful action is to shout.
 */
export type RetryPolicy = 'fast' | 'slow' | 'quota' | 'never'

const POLICIES: readonly RetryPolicy[] = ['fast', 'slow', 'quota', 'never']

/** Spacing for the in-cycle retries a `fast` failure gets, in order. */
export const FAST_RETRY_DELAYS_MS = [10_000, 30_000, 90_000] as const

/** Consecutive failed cycles before a recoverable outage is worth an alert. */
const ALERT_AFTER_CYCLES = 3

export function policyForStatus(status: number): RetryPolicy {
  if (status >= 500) return 'slow'
  if (status === 429) return 'quota'
  if (status >= 400) return 'never'
  // A non-2xx outside both ranges is odd rather than diagnostic — a redirect
  // we did not follow, most likely. Treat it as the server's problem.
  return 'slow'
}

/**
 * The wait before attempt `attempt + 1`, or null to stop retrying in-cycle.
 *
 * Only `fast` retries here. Everything slower recovers on a scale the cycle
 * interval already covers, so retrying inside the cycle would burn requests
 * without changing the outcome.
 */
export function fastRetryDelayMs(
  policy: RetryPolicy,
  attempt: number,
): number | null {
  if (policy !== 'fast') return null
  return FAST_RETRY_DELAYS_MS[attempt - 1] ?? null
}

/**
 * Alerts once per outage, and immediately when waiting cannot help.
 *
 * The delay before alerting exists to filter blips, so it is worth nothing on
 * a failure that has no chance of clearing itself.
 */
export function shouldAlert(policy: RetryPolicy, consecutive: number): boolean {
  if (policy === 'never') return consecutive === 1
  return consecutive === ALERT_AFTER_CYCLES
}

/**
 * `Retry-After`, in milliseconds from now.
 *
 * Both forms the header is allowed to take, because the two services this
 * talks to do not agree on which to send. Null means the header was absent or
 * unusable and the caller should fall back to its own schedule.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
): number | null {
  if (header === null || header === undefined) return null

  const trimmed = header.trim()
  if (trimmed === '') return null

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  // A bare integer that failed that test is a malformed delay, not a date.
  // Left to Date.parse, `-5` becomes the year 5 BC.
  if (/^[+-]?\d+$/.test(trimmed)) return null

  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  // A date already in the past means "now", not "negative time".
  return Math.max(0, at - Date.now())
}

/**
 * `Retry-After` off a response that may not have a header bag at all.
 *
 * Every client is constructed with an injected `fetch`, and the stand-ins
 * are not obliged to build a real `Response`. A missing bag has to degrade to
 * "the server said nothing" — throwing here would replace a diagnosable 429
 * with a `TypeError` raised inside the error path.
 */
export function retryAfterMsOf(response: Response): number | null {
  try {
    return parseRetryAfterMs(response.headers?.get('retry-after'))
  } catch {
    return null
  }
}

/**
 * The policy an error carries, or null when it is not an upstream failure.
 *
 * Read structurally rather than by class, because the error classes live in
 * the modules that import this one and asking by name would close the loop.
 * The structural test also draws the line in the right place on its own:
 * `LlmError` — a reply the pipeline re-asks and the service loop never sees —
 * has no `retry` field, so it cannot be mistaken for an outage.
 */
export function retryPolicyOf(error: unknown): RetryPolicy | null {
  if (!(error instanceof Error)) return null
  const { retry } = error as Error & { retry?: unknown }
  return POLICIES.includes(retry as RetryPolicy) ? (retry as RetryPolicy) : null
}

/** The pace the server named, when the error carried one. */
export function retryAfterMsOfError(error: unknown): number | null {
  if (!(error instanceof Error)) return null
  const { retryAfterMs } = error as Error & { retryAfterMs?: unknown }
  return typeof retryAfterMs === 'number' ? retryAfterMs : null
}
