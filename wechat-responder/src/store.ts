/**
 * The responder's Postgres side: pull WeChat messages that have not been
 * judged yet, gather a little context, write one `reply_decisions` row per
 * message, and fold the owner's Telegram feedback back in.
 *
 * "Judged" means "has a reply_decisions row", not `messages.processed` — that
 * column belongs to other consumers. A dropped message gets a row too, so a
 * wrong drop is visible in the calibration data.
 */
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm'
import type { Pool } from 'pg'
import { createDb } from 'shared/db'
import type { JevJudgement } from 'shared/jev'
import { messages, replyDecisions } from 'shared/schema'
import type { ReplyFeedback, ReplyRoute, ReplyStage } from 'shared'

export interface Candidate {
  id: number
  channelId: string
  authorId: string
  authorName: string
  content: string
  timestamp: Date
  embedding: number[] | null
  rawData: { kind?: string; mentions?: string[] } | null
  replyToAuthorId: string | null
}

export interface NewReplyDecision {
  messageId: number
  stage: ReplyStage
  route: ReplyRoute
  jev?: Record<string, JevJudgement> | null
  retrievedIds?: number[] | null
  mentionAuthorId?: string | null
  draft?: string | null
}

export class ResponderStore {
  private readonly db: ReturnType<typeof createDb>

  constructor(pool: Pool) {
    this.db = createDb(pool)
  }

  /**
   * WeChat messages with no decision yet, oldest first. The quoted author is
   * resolved with a self-join on `messages` by the reply's message id.
   */
  async claimUnjudged(limit: number): Promise<Candidate[]> {
    const quoted = this.db
      .select({
        messageId: messages.messageId,
        authorId: messages.authorId,
      })
      .from(messages)
      .where(eq(messages.source, 'wechat'))
      .as('quoted')

    const rows = await this.db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        authorId: messages.authorId,
        authorName: messages.authorName,
        content: messages.content,
        timestamp: messages.timestamp,
        embedding: messages.embedding,
        rawData: messages.rawData,
        replyToAuthorId: quoted.authorId,
      })
      .from(messages)
      .leftJoin(quoted, eq(quoted.messageId, messages.replyToMessageId))
      .where(
        and(
          eq(messages.source, 'wechat'),
          sql`NOT EXISTS (SELECT 1 FROM ${replyDecisions} rd WHERE rd.message_id = ${messages.id})`,
        ),
      )
      .orderBy(messages.timestamp)
      .limit(limit)

    return rows.map((row) => ({
      ...row,
      rawData: (row.rawData as Candidate['rawData']) ?? null,
    }))
  }

  /** The last `n` messages in the group before `before`, oldest first. */
  async recentContext(
    channelId: string,
    before: Date,
    n: number,
  ): Promise<{ authorName: string; content: string }[]> {
    const rows = await this.db
      .select({ authorName: messages.authorName, content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.source, 'wechat'),
          eq(messages.channelId, channelId),
          lt(messages.timestamp, before),
        ),
      )
      .orderBy(desc(messages.timestamp))
      .limit(n)
    return rows.reverse()
  }

  /** Write one decision. Idempotent on the message; returns its row id. */
  async recordDecision(row: NewReplyDecision): Promise<number> {
    const [inserted] = await this.db
      .insert(replyDecisions)
      .values({
        messageId: row.messageId,
        stage: row.stage,
        route: row.route,
        jev: row.jev ?? null,
        retrievedIds: row.retrievedIds ?? null,
        mentionAuthorId: row.mentionAuthorId ?? null,
        draft: row.draft ?? null,
      })
      .onConflictDoNothing({ target: replyDecisions.messageId })
      .returning({ id: replyDecisions.id })
    if (inserted) return inserted.id
    // A row already existed (a re-judged message): return the existing id.
    const [existing] = await this.db
      .select({ id: replyDecisions.id })
      .from(replyDecisions)
      .where(eq(replyDecisions.messageId, row.messageId))
    return existing.id
  }

  async attachTelegramId(decisionId: number, telegramMessageId: number): Promise<void> {
    await this.db
      .update(replyDecisions)
      .set({ telegramMessageId })
      .where(eq(replyDecisions.id, decisionId))
  }

  /** Record the owner's answer, found by the Telegram message it was on. */
  async recordFeedback(
    telegramMessageId: number,
    feedback: ReplyFeedback,
    editedText?: string,
  ): Promise<void> {
    await this.db
      .update(replyDecisions)
      .set({ feedback, editedText: editedText ?? null, feedbackAt: new Date() })
      .where(eq(replyDecisions.telegramMessageId, telegramMessageId))
  }

  /**
   * Cards pushed, unanswered and older than the cutoff: mark them expired and
   * return them so the bot can strike the buttons. Feedback on an expired card
   * is still recorded — it still shows whether the judgement was right.
   */
  async expireStale(
    olderThan: Date,
  ): Promise<{ id: number; telegramMessageId: number }[]> {
    const rows = await this.db
      .update(replyDecisions)
      .set({ expiredAt: new Date() })
      .where(
        and(
          isNull(replyDecisions.feedback),
          isNull(replyDecisions.expiredAt),
          lt(replyDecisions.createdAt, olderThan),
          sql`${replyDecisions.telegramMessageId} IS NOT NULL`,
        ),
      )
      .returning({
        id: replyDecisions.id,
        telegramMessageId: replyDecisions.telegramMessageId,
      })
    return rows.filter(
      (r): r is { id: number; telegramMessageId: number } =>
        r.telegramMessageId !== null,
    )
  }

  /** How many drafts/templates went to a group since `since`, for the rate limit. */
  async draftsInGroupSince(channelId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(replyDecisions)
      .innerJoin(messages, eq(messages.id, replyDecisions.messageId))
      .where(
        and(
          eq(messages.channelId, channelId),
          gte(replyDecisions.createdAt, since),
          sql`${replyDecisions.route} IN ('draft', 'template')`,
        ),
      )
    return row?.n ?? 0
  }

  /** Templates already sent to a person since `since`, for the cooldown. */
  async templatesUsedFor(authorId: string, since: Date): Promise<string[]> {
    const rows = await this.db
      .select({ draft: replyDecisions.draft })
      .from(replyDecisions)
      .innerJoin(messages, eq(messages.id, replyDecisions.messageId))
      .where(
        and(
          eq(messages.authorId, authorId),
          eq(replyDecisions.route, 'template'),
          gte(replyDecisions.createdAt, since),
        ),
      )
    return rows.map((r) => r.draft).filter((d): d is string => d !== null)
  }
}
