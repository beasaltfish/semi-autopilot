/**
 * Embedding search over the collected history, for two jobs a draft needs:
 *   - the owner's own past messages nearest this one, as few-shot voice, and
 *   - the person in this group who keeps answering questions like this one, as
 *     the @ candidate — used only when a specialised question has a recurring
 *     expert, never a one-off. The asker and the owner are always excluded.
 *
 * Uses pgvector's cosine distance (`<=>`). Raw SQL, because the vector literal
 * and the `<=>` operator are clearer here than through the query builder.
 */
import type { Pool } from 'pg'

/** A pgvector literal for a query embedding. */
function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

export interface Expert {
  authorId: string
  authorName: string
  /** Share of the nearest neighbours this person wrote, in (0, 1]. */
  score: number
}

export class Retrieval {
  constructor(private readonly pool: Pool) {}

  /** The owner's own messages nearest this embedding, for few-shot voice. */
  async similarOwnerReplies(
    embedding: number[],
    ownerId: string,
    limit: number,
  ): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT content FROM messages
       WHERE source = 'wechat' AND author_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [ownerId, vectorLiteral(embedding), limit],
    )
    return rows.map((row) => row.content as string)
  }

  /**
   * The recurring expert for a question like this one: among the `limit`
   * nearest messages in the group (excluding the given ids), the author who
   * wrote the most — but only if they wrote more than one, so a single nearby
   * message never nominates anyone. Null when no one stands out.
   */
  async expertFor(
    embedding: number[],
    channelId: string,
    exclude: string[],
    limit: number,
  ): Promise<Expert | null> {
    const { rows } = await this.pool.query(
      `SELECT author_id, author_name FROM messages
       WHERE source = 'wechat' AND channel_id = $1 AND embedding IS NOT NULL
         AND NOT (author_id = ANY($2))
       ORDER BY embedding <=> $3::vector
       LIMIT $4`,
      [channelId, exclude, vectorLiteral(embedding), limit],
    )
    if (rows.length === 0) return null

    const counts = new Map<string, { name: string; n: number }>()
    for (const row of rows) {
      const entry = counts.get(row.author_id) ?? { name: row.author_name, n: 0 }
      entry.n += 1
      counts.set(row.author_id, entry)
    }

    let best: Expert | null = null
    for (const [authorId, { name, n }] of counts) {
      if (n < 2) continue // a lone nearby message is not expertise
      if (!best || n / rows.length > best.score) {
        best = { authorId, authorName: name, score: n / rows.length }
      }
    }
    return best
  }
}
