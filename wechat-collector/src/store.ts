/**
 * The collector's Postgres side: mark the allowlisted groups enabled, find
 * where each group's collection left off, and insert new messages.
 *
 * Every write stamps `source = 'wechat'` itself, so a caller cannot mislabel a
 * row, and inserts are idempotent on `(source, message_id)` — re-reading an
 * overlap after a restart costs nothing.
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Pool } from 'pg'
import { createDb } from 'shared/db'
import { channels, messages } from 'shared/schema'
import type { DecodedMessage } from './decode.js'

export class CollectorStore {
  private readonly db: ReturnType<typeof createDb>

  constructor(pool: Pool) {
    this.db = createDb(pool)
  }

  /**
   * Record the allowlisted groups as enabled channels. The allowlist is the
   * switch: a group listed here is on, and this is the only place the column
   * is set true, so removing a group from the config does not disable it here
   * — that stays a deliberate, separate act.
   */
  async enableGroups(groupIds: string[]): Promise<void> {
    for (const channelId of groupIds) {
      await this.db
        .insert(channels)
        .values({ source: 'wechat', channelId, enabled: true })
        .onConflictDoUpdate({
          target: [channels.source, channels.channelId],
          set: { enabled: true },
        })
    }
  }

  /**
   * The newest stored message's time for a group, or null if none. Collection
   * resumes a little before this, so a message that arrived during the gap is
   * not skipped; the unique key drops the ones already stored.
   */
  async newestTimestamp(channelId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ ts: messages.timestamp })
      .from(messages)
      .where(
        and(eq(messages.source, 'wechat'), eq(messages.channelId, channelId)),
      )
      .orderBy(desc(messages.timestamp))
      .limit(1)
    return row?.ts ?? null
  }

  /**
   * Insert decoded messages, ignoring ones already stored. Returns how many
   * were actually new — `returning` yields only inserted rows, so a re-read of
   * an overlap reports 0.
   */
  async insertMessages(
    channelId: string,
    decoded: DecodedMessage[],
  ): Promise<number> {
    if (decoded.length === 0) return 0
    const inserted = await this.db
      .insert(messages)
      .values(
        decoded.map((message) => ({
          source: 'wechat' as const,
          messageId: message.messageId,
          channelId,
          // WeChat has no space layer; substitute rather than omit, as the
          // schema's other sources do.
          spaceId: '',
          authorId: message.authorId,
          // A readable name comes from contact.db later; until then the
          // username stands in rather than leaving the column null.
          authorName: message.authorId,
          content: message.content,
          timestamp: message.timestamp,
          rawData: message.rawData,
        })),
      )
      .onConflictDoNothing({ target: [messages.source, messages.messageId] })
      .returning({ id: messages.id })
    return inserted.length
  }
}
