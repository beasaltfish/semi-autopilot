/**
 * Picking a praise reply from a small library without the LLM. The only rule
 * is a per-person cooldown: the same canned line to the same person twice in a
 * short window reads as a bot, so a template on cooldown for this person is
 * skipped, and if they are all on cooldown the caller gets null and pushes a
 * card without a template.
 */
import type { Rng } from 'shared/rng'

/**
 * Choose a template not recently used for this person. Random among the
 * eligible ones (seeded rng, for testability), so replies do not march down
 * the list in order.
 */
export function pickTemplate(
  templates: string[],
  recentlyUsed: Set<string>,
  rng: Rng,
): string | null {
  const eligible = templates.filter((template) => !recentlyUsed.has(template))
  if (eligible.length === 0) return null
  return eligible[Math.floor(rng() * eligible.length)]
}
