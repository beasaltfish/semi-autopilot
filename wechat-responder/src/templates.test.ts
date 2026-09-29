import { describe, expect, it } from 'vitest'
import { mulberry32 } from 'shared/rng'
import { pickTemplate } from './templates.js'

const templates = ['a', 'b', 'c']

describe('pickTemplate', () => {
  it('picks a template not recently used', () => {
    const chosen = pickTemplate(templates, new Set(['a', 'b']), mulberry32(1))
    expect(chosen).toBe('c')
  })

  it('returns null when every template is on cooldown', () => {
    expect(pickTemplate(templates, new Set(['a', 'b', 'c']), mulberry32(1))).toBeNull()
  })

  it('is deterministic under a seeded rng', () => {
    const a = pickTemplate(templates, new Set(), mulberry32(42))
    const b = pickTemplate(templates, new Set(), mulberry32(42))
    expect(a).toBe(b)
  })

  it('chooses among all templates when none are used', () => {
    const chosen = pickTemplate(templates, new Set(), mulberry32(7))
    expect(templates).toContain(chosen)
  })
})
