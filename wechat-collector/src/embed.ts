/**
 * Fills in embeddings for stored WeChat messages, so the responder can later
 * search history by meaning. It only phrases the request to an
 * OpenAI-compatible endpoint and writes the vectors back; the store decides
 * which messages qualify.
 */
import type { PendingEmbedding } from './store.js'

/** One vector per input, in input order — `LlmClient.embed` bound, in the loop. */
export type Embed = (texts: string[]) => Promise<number[][]>

/** Just the two store methods embedding needs, so it is easy to fake. */
export interface EmbedStore {
  pendingEmbedding(minChars: number, limit: number): Promise<PendingEmbedding[]>
  setEmbeddings(entries: { id: number; vector: number[] }[]): Promise<void>
}

export interface EmbedOptions {
  minChars: number
  batchSize: number
}

/**
 * Embed one batch of pending messages. Returns how many were embedded, so the
 * caller can drain a backlog by calling again while it returns a full batch.
 */
export async function embedPending(
  embed: Embed,
  store: EmbedStore,
  options: EmbedOptions,
): Promise<number> {
  const pending = await store.pendingEmbedding(options.minChars, options.batchSize)
  if (pending.length === 0) return 0
  const vectors = await embed(pending.map((row) => row.content))
  await store.setEmbeddings(
    pending.map((row, i) => ({ id: row.id, vector: vectors[i] })),
  )
  return pending.length
}
