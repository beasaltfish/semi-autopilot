/**
 * The hand-written interfaces are gone; `types.ts` derives them. What is
 * still worth proving is that the derived shapes carry the fields the
 * services actually read, so a column renamed in the schema fails here rather
 * than at whichever call site notices first.
 */
import type { channels } from './schema.js'
import type {
  DiscordMessage,
  ReplyDecision,
  ReplyFeedback,
  ReplyRoute,
  Source,
  Tweet,
  TweetArchetype,
} from './types.js'

const _tweetHasWhatTheQueueReads: Pick<
  Tweet,
  'id' | 'content' | 'status' | 'dedupeKey' | 'attempts' | 'scheduledAt'
> = {} as Tweet

const _messageHasWhatTheAssistantReads: Pick<
  DiscordMessage,
  'messageId' | 'channelId' | 'content' | 'timestamp'
> = {} as DiscordMessage

// The archetype union must stay closed: adding a value to the schema without
// teaching ARCHETYPES about it should not compile.
const _archetypes: Record<TweetArchetype, true> = {
  digest: true,
  metric: true,
  take: true,
  question: true,
}

// A source added to SOURCES without a place to go should not compile.
const _sources: Record<Source, true> = { discord: true, wechat: true }

// The allowlist switch is NOT NULL, so readers never have to guess.
const _enabled: boolean = ({} as typeof channels.$inferSelect).enabled

const _decisionHasWhatTheResponderWrites: Pick<
  ReplyDecision,
  | 'messageId'
  | 'stage'
  | 'route'
  | 'jev'
  | 'retrievedIds'
  | 'mentionAuthorId'
  | 'draft'
  | 'telegramMessageId'
  | 'feedback'
  | 'editedText'
  | 'expiredAt'
  | 'feedbackAt'
> = {} as ReplyDecision

const _routes: Record<ReplyRoute, true> = {
  drop: true,
  alert: true,
  template: true,
  draft: true,
  record_only: true,
}

const _feedback: Record<ReplyFeedback, true> = {
  approve: true,
  reject: true,
  edit: true,
  ack: true,
}

export type _Assertions = [
  typeof _tweetHasWhatTheQueueReads,
  typeof _messageHasWhatTheAssistantReads,
  typeof _archetypes,
  typeof _sources,
  typeof _enabled,
  typeof _decisionHasWhatTheResponderWrites,
  typeof _routes,
  typeof _feedback,
]
