/**
 * Turns a run of failures into a single alert. The databases can be
 * unreadable for a while — WeChat is closing, a key has gone stale — and the
 * owner wants to hear about that once, after it has clearly persisted, not on
 * every poll. A success clears the run.
 */
export class FailureWatch {
  private firstFailureMs: number | null = null
  private alerted = false

  /** @param thresholdMs how long failures must persist before it alerts. */
  constructor(private readonly thresholdMs: number) {}

  /** A pass succeeded: forget the run and re-arm. */
  succeed(): void {
    this.firstFailureMs = null
    this.alerted = false
  }

  /**
   * A pass failed. Returns true exactly once per run — the first failure at or
   * past the threshold — so the caller alerts a single time until recovery.
   */
  fail(nowMs: number): boolean {
    this.firstFailureMs ??= nowMs
    if (this.alerted) return false
    if (nowMs - this.firstFailureMs >= this.thresholdMs) {
      this.alerted = true
      return true
    }
    return false
  }
}
