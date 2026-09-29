import { describe, expect, it } from 'vitest'
import type { JevJudgement } from 'shared/jev'
import { route } from './routing.js'

const t = { intentMin: 0.6, praiseMin: 0.7, addressedMin: 0.6 }
const noFlags = { mentionsOwner: false, mentionsOther: false, quotesOwner: false, namesOwner: false }

function j(
  intent: string,
  confidence: number,
  extra: Record<string, JevJudgement> = {},
): Record<string, JevJudgement> {
  return {
    intent: { label: intent, confidence },
    addressed: { label: 'false', confidence: 0.9 },
    needs_history: { label: 'false', confidence: 0.9 },
    ...extra,
  }
}

describe('route', () => {
  it('alerts on an ai_probe and never drafts', () => {
    expect(route(noFlags, j('ai_probe', 0.8), t)).toMatchObject({ route: 'alert', stage: 'jev' })
  })

  it('alerts on a critical message', () => {
    expect(route(noFlags, j('critical', 0.9), t).route).toBe('alert')
  })

  it('alerts when addressed to the owner but the intent is uncertain', () => {
    expect(route({ ...noFlags, mentionsOwner: true }, j('chitchat', 0.3), t).route).toBe('alert')
  })

  it('records a question that @s someone else', () => {
    expect(route({ ...noFlags, mentionsOther: true }, j('question', 0.9), t).route).toBe(
      'record_only',
    )
  })

  it('drafts a question addressed to the owner, carrying needsHistory', () => {
    const decision = route(
      { ...noFlags, mentionsOwner: true },
      j('question', 0.9, { needs_history: { label: 'true', confidence: 0.8 } }),
      t,
    )
    expect(decision).toEqual({ route: 'draft', stage: 'llm', needsHistory: true })
  })

  it('drafts a question that @s no one', () => {
    expect(route(noFlags, j('question', 0.9), t).route).toBe('draft')
  })

  it('still drafts a question that @s the owner and someone else', () => {
    expect(
      route({ ...noFlags, mentionsOwner: true, mentionsOther: true }, j('question', 0.9), t).route,
    ).toBe('draft')
  })

  it('templates confident praise addressed to the owner', () => {
    expect(route({ ...noFlags, mentionsOwner: true }, j('praise', 0.9), t).route).toBe('template')
  })

  it('does not template praise that is not addressed to the owner', () => {
    expect(route(noFlags, j('praise', 0.9), t).route).toBe('record_only')
  })

  it('records chitchat', () => {
    expect(route(noFlags, j('chitchat', 0.9), t).route).toBe('record_only')
  })

  it('records a low-confidence, unaddressed intent', () => {
    expect(route(noFlags, j('question', 0.4), t).route).toBe('record_only')
  })

  it('counts a high-confidence Jev "addressed" as addressed', () => {
    const decision = route(
      noFlags,
      j('praise', 0.9, { addressed: { label: 'true', confidence: 0.8 } }),
      t,
    )
    expect(decision.route).toBe('template')
  })
})
