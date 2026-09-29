import { describe, expect, it } from 'vitest'
import { FailureWatch } from './watch.js'

describe('FailureWatch', () => {
  it('stays quiet while failures are below the threshold', () => {
    const watch = new FailureWatch(600_000) // 10 minutes
    expect(watch.fail(0)).toBe(false)
    expect(watch.fail(300_000)).toBe(false)
  })

  it('alerts once when the run passes the threshold', () => {
    const watch = new FailureWatch(600_000)
    watch.fail(0)
    expect(watch.fail(600_000)).toBe(true)
    // No repeat alert while the run continues.
    expect(watch.fail(900_000)).toBe(false)
  })

  it('re-arms after a success', () => {
    const watch = new FailureWatch(600_000)
    watch.fail(0)
    expect(watch.fail(600_000)).toBe(true)
    watch.succeed()
    expect(watch.fail(700_000)).toBe(false) // a fresh run starts here
    expect(watch.fail(1_300_000)).toBe(true)
  })
})
