/**
 * The cheap first pass over a stored message: decide whether it leaves the
 * pipeline at once (the owner's own message, a system notice, a sticker) and,
 * if not, compute the flags routing needs — whether it @s the owner, @s
 * someone else, quotes the owner, or names the owner. No network, no model.
 */

/** The stored fields the rules read. */
export interface MessageInput {
  authorId: string
  content: string
  rawData: { kind?: string; mentions?: string[] } | null
  /** The author of the message this one quotes, if any. */
  replyToAuthorId: string | null
}

export interface RuleFlags {
  mentionsOwner: boolean
  /** @s a specific person who is not the owner. */
  mentionsOther: boolean
  quotesOwner: boolean
  namesOwner: boolean
}

export type RuleOutcome =
  | { drop: 'own' | 'system' | 'sticker' }
  | { flags: RuleFlags }

export interface Owner {
  id: string
  names: string[]
}

export function applyRules(message: MessageInput, owner: Owner): RuleOutcome {
  // The owner's own messages are style samples, kept in `messages`, but never
  // something to draft a reply *to*.
  if (message.authorId === owner.id) return { drop: 'own' }

  const kind = message.rawData?.kind
  if (kind === 'system') return { drop: 'system' }
  if (kind === 'sticker') return { drop: 'sticker' }

  const mentions = message.rawData?.mentions ?? []
  return {
    flags: {
      mentionsOwner: mentions.includes(owner.id),
      mentionsOther: mentions.some((id) => id !== owner.id),
      quotesOwner: message.replyToAuthorId === owner.id,
      namesOwner: owner.names.some((name) => name && message.content.includes(name)),
    },
  }
}
