/**
 * The database schema — the actual contract between the four services, which
 * never call each other and only meet in Postgres.
 *
 * This file is the single source of truth. `types.ts` derives its row types
 * from it, and `db/migrations/` is generated from it. Change a column here and
 * run `pnpm db:generate`; never write DDL by hand elsewhere.
 *
 * Timestamps deliberately omit `mode`, so they infer as `Date`. `drizzle-kit
 * pull` defaults them to `mode: 'string'`, which every consumer of these types
 * would have to undo.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
  vector,
} from 'drizzle-orm/pg-core'

/**
 * Every message source the system supports. One list, because `channels`,
 * `messages` and `threads` each carry the column and a source that exists in
 * one table but not another is a join that silently drops rows.
 */
export const SOURCES = ['discord', 'wechat'] as const

/**
 * The source's own message payload, stored whole in `messages.raw_data`.
 *
 * Only fields something actually reads are declared, each owned by one
 * source. The index signature keeps the rest addressable without pretending
 * we know its shape, which we do not: it is whatever the source handed over
 * that day.
 */
export interface MessageRawData {
  /** Discord: the bot flag the filter checks. */
  author?: { bot?: boolean }
  /**
   * WeChat: the wxids the message @-mentions, normalised by the collector
   * from whatever chatlog names the field, so readers never depend on it.
   */
  mentions?: string[]
  [key: string]: unknown
}

export const channels = pgTable(
  'channels',
  {
    id: serial('id').primaryKey(),
    /** Which message source this row came from. See `messages.source`. */
    source: varchar('source', { length: 20, enum: SOURCES }).notNull(),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    channelName: varchar('channel_name', { length: 255 }),
    spaceId: varchar('space_id', { length: 255 }),
    spaceName: varchar('space_name', { length: 255 }),
    /**
     * Whether the services act on this channel at all. Off by default: a
     * group the owner has not chosen is ignored, not merely deprioritised.
     */
    enabled: boolean('enabled').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    unique('channels_source_channel_id_unique').on(
      table.source,
      table.channelId,
    ),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    /**
     * Which message source wrote this row. Every id below is unique only
     * within its source — two sources have two id spaces — so the uniqueness
     * constraints are composite. The enum is the list of sources the system
     * supports; adding one is deliberately a schema change.
     *
     * No default: a default would let a writer omit the column and be quietly
     * labelled Discord. Without one, omitting it is a compile error.
     */
    source: varchar('source', { length: 20, enum: SOURCES }).notNull(),
    messageId: varchar('message_id', { length: 255 }).notNull(),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    /**
     * The container the channel belongs to: a Discord guild, a Slack
     * workspace. `''` for a source that has no such layer, such as Telegram,
     * following the convention of the columns below — the writer substitutes
     * rather than omits.
     */
    spaceId: varchar('space_id', { length: 255 }).notNull(),
    // NOT NULL because the observer that writes these rows cannot produce a
    // null: it falls back to 'unknown' for the author, '' for the content and
    // the current time for the timestamp. They were nullable for as long as
    // the table existed, and every consumer quietly assumed otherwise. The
    // constraint puts the guarantee where both sides can see it — an absent
    // author reads as 'unknown', an attachment-only message as '', neither of
    // which needs null to say it.
    authorId: varchar('author_id', { length: 255 }).notNull(),
    authorName: varchar('author_name', { length: 255 }).notNull(),
    content: text('content').notNull(),
    timestamp: timestamp('timestamp').notNull(),
    // Genuinely optional: most messages are neither a reply nor in a thread.
    replyToMessageId: varchar('reply_to_message_id', { length: 255 }),
    threadId: varchar('thread_id', { length: 255 }),
    isFiltered: boolean('is_filtered').default(false),
    // `$type` is a TypeScript annotation only — the SQL type stays jsonb.
    // Without it the column infers as `unknown` and every reader needs a cast
    // to say what the monitor has always put there.
    rawData: jsonb('raw_data').$type<MessageRawData>(),
    embedding: vector('embedding', { dimensions: 1536 }),
    processed: boolean('processed').default(false),
    isQuestion: boolean('is_question'),
    questionConfidence: integer('question_confidence'),
    questionType: varchar('question_type', { length: 50 }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    index('idx_messages_channel_id').on(table.channelId),
    index('idx_messages_timestamp').on(table.timestamp),
    index('idx_messages_processed').on(table.processed, table.timestamp),
    index('idx_messages_is_question').on(table.isQuestion),
    index('idx_messages_author_id').on(table.authorId),
    index('idx_messages_thread_id').on(table.threadId),
    index('idx_messages_reply_to').on(table.replyToMessageId),
    index('idx_messages_channel_timestamp').on(table.channelId, table.timestamp),
    index('idx_messages_context_search').on(
      table.channelId,
      table.isQuestion,
      table.timestamp,
    ),
    index('idx_messages_space_id').on(table.spaceId),
    // Full-text search over message content. An expression index, so it is
    // written as raw SQL rather than a column list.
    index('idx_messages_content_fts').using(
      'gin',
      sql`to_tsvector('english', ${table.content})`,
    ),
    unique('messages_source_message_id_unique').on(
      table.source,
      table.messageId,
    ),
  ],
)

export const threads = pgTable(
  'threads',
  {
    id: serial('id').primaryKey(),
    /** Which message source this row came from. See `messages.source`. */
    source: varchar('source', { length: 20, enum: SOURCES }).notNull(),
    threadId: varchar('thread_id', { length: 255 }).notNull(),
    originalMessageId: varchar('original_message_id', {
      length: 255,
    }).notNull(),
    channelId: varchar('channel_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => [
    unique('threads_source_thread_id_unique').on(table.source, table.threadId),
  ],
)

/**
 * The queue the x-poster drains and the tweet-generator fills.
 *
 * Time columns are TIMESTAMPTZ, unlike the tables above, because every one of
 * them feeds a scheduling decision — active-hours window, minimum interval,
 * daily cap — where a naive timestamp is a correctness bug.
 */
export const tweets = pgTable(
  'tweets',
  {
    id: serial('id').primaryKey(),
    content: text('content').notNull(),
    /**
     * `uncertain` is not a flavour of failure. It means submit was clicked but
     * the outcome could not be confirmed — the tweet may well be live. Such
     * rows are never retried: the queue prefers a missed tweet to a duplicate.
     */
    status: varchar('status', {
      length: 20,
      enum: ['pending', 'sending', 'posted', 'failed', 'uncertain'],
    })
      .notNull()
      .default('pending'),
    /**
     * Idempotency key supplied by whoever enqueued the tweet. UNIQUE, so
     * enqueueing the same logical tweet twice is rejected by Postgres rather
     * than by application logic.
     */
    dedupeKey: varchar('dedupe_key', { length: 255 }).notNull().unique(),
    source: varchar('source', { length: 50 }),
    sourceRef: varchar('source_ref', { length: 255 }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedUrl: text('posted_url'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Path to the card image, if this tweet has one. */
    mediaPath: text('media_path'),
    /**
     * The shape the post takes. Stored rather than held in memory because the
     * "never the same archetype twice in a row" rule has to survive a restart.
     */
    archetype: varchar('archetype', {
      length: 20,
      enum: ['digest', 'metric', 'take', 'question'],
    }),
    /**
     * Which tier's allowance this post spent. Stored because the quota
     * picker counts a day's usage from these rows after a restart.
     */
    tier: varchar('tier', { length: 10, enum: ['project', 'hot', 'labs'] }),
    /**
     * The searchable names this post is about.
     *
     * Write-only for now. A comparison post has to ask what we have already
     * covered, and that history only exists if it was being recorded before
     * the feature that reads it shipped.
     */
    entities: text('entities').array(),
  },
  (table) => [
    index('idx_tweets_claim').on(table.status, table.scheduledAt),
    index('idx_tweets_posted_at').on(table.postedAt),
  ],
)

/**
 * One row per candidate the tweet-generator has tried and failed to write up.
 * Without it, a candidate the model cannot handle sits at the top of its pool
 * and consumes every slot that source has, every cycle, until it ages out of
 * the freshness window.
 */
export const generationAttempts = pgTable('generation_attempts', {
  externalId: varchar('external_id', { length: 255 }).primaryKey(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/** One judgement a `jev` entry records: which label won, and how sure. */
export interface JevJudgement {
  label: string
  confidence: number
}

/**
 * One row per message the wechat-responder judged — what it decided, what it
 * would have said, and what the owner said about that.
 *
 * This is the calibration dataset. Phase one sends nothing; the rows are the
 * product. That is why a message dropped by the rules still gets a row: a
 * wrong drop is invisible unless it was written down.
 */
export const replyDecisions = pgTable(
  'reply_decisions',
  {
    id: serial('id').primaryKey(),
    messageId: integer('message_id')
      .notNull()
      .unique()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** The furthest layer the message reached. */
    stage: varchar('stage', {
      length: 20,
      enum: ['rule', 'jev', 'template', 'llm'],
    }).notNull(),
    route: varchar('route', {
      length: 20,
      enum: ['drop', 'alert', 'template', 'draft', 'record_only'],
    }).notNull(),
    /** Keyed by judgement name — `intent`, `addressed`, `needs_history`. */
    jev: jsonb('jev').$type<Record<string, JevJudgement>>(),
    retrievedIds: integer('retrieved_ids').array(),
    mentionAuthorId: varchar('mention_author_id', { length: 255 }),
    draft: text('draft'),
    telegramMessageId: integer('telegram_message_id'),
    feedback: varchar('feedback', {
      length: 10,
      enum: ['approve', 'reject', 'edit', 'ack'],
    }),
    editedText: text('edited_text'),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    feedbackAt: timestamp('feedback_at', { withTimezone: true }),
  },
  (table) => [
    // The expiry sweep: cards pushed, unanswered, not yet marked.
    index('idx_reply_decisions_pending').on(
      table.feedback,
      table.expiredAt,
      table.createdAt,
    ),
  ],
)
