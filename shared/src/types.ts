/**
 * Row types, derived from `schema.ts` rather than restated. The schema is the
 * contract between the services — they never call each other, they only meet
 * in Postgres — so anything that can be read off it should be.
 *
 * What is left hand-written is what no table describes: the shape of a join,
 * and the columns a given consumer actually depends on.
 */
import type { messages, replyDecisions, SOURCES, tweets } from './schema.js'

/** One row of the `tweets` table. */
export type Tweet = typeof tweets.$inferSelect

/**
 * Where a queued tweet is in its lifecycle.
 *
 * `uncertain` is not a flavour of failure. It means the submit button was
 * clicked but the outcome could not be confirmed — the tweet may well be
 * live. Rows in this state are never retried automatically, because the
 * queue prefers a missed tweet over a duplicate one.
 */
export type TweetStatus = Tweet['status']

/**
 * The shape a tweet takes.
 *
 * Chosen by the generator and stored, because the "never the same archetype
 * twice in a row" rule has to survive a process restart — it cannot be held
 * in memory.
 */
export type TweetArchetype = NonNullable<Tweet['archetype']>

/**
 * The columns of `messages` the discord-monitor writes and the ai-assistant
 * reads. Narrower than the table on purpose: the analysis columns
 * (`processed`, `is_question`, `embedding`) belong to one consumer, and a
 * shared type that named them would invite the other to use them.
 *
 * Only `replyToMessageId` and `threadId` are nullable, because only they are
 * optional in Discord. The rest carry NOT NULL: the observer substitutes
 * 'unknown', '' or the current time rather than omit a field, and the schema
 * now says so instead of leaving every reader to assume it.
 */
export type DiscordMessage = Pick<
  typeof messages.$inferSelect,
  | 'source'
  | 'messageId'
  | 'channelId'
  | 'spaceId'
  | 'authorId'
  | 'authorName'
  | 'content'
  | 'timestamp'
  | 'replyToMessageId'
  | 'threadId'
  | 'rawData'
>

/**
 * A message joined with its channel.
 *
 * `channel_name` and `space_name` live on the `channels` table, not on
 * `messages`, so they are only available when the two are joined — and the
 * join is a LEFT JOIN, hence nullable: a caller that asked for the enriched
 * shape must acknowledge the name may be missing.
 *
 * `null` rather than `undefined`, which the hand-written version said: an
 * unmatched LEFT JOIN yields SQL NULL, and no driver turns that into
 * undefined.
 */
export interface DiscordMessageWithChannel extends DiscordMessage {
  channelName: string | null
  spaceName: string | null
}

/** A message source: `discord`, `wechat`. */
export type Source = (typeof SOURCES)[number]

/** One row of `reply_decisions`. */
export type ReplyDecision = typeof replyDecisions.$inferSelect

/** The furthest layer of the pipeline a message reached. */
export type ReplyStage = ReplyDecision['stage']

/** What the responder decided to do with a message. */
export type ReplyRoute = ReplyDecision['route']

/** The owner's answer on Telegram, or null while there is none. */
export type ReplyFeedback = NonNullable<ReplyDecision['feedback']>

export type { JevJudgement } from './schema.js'
