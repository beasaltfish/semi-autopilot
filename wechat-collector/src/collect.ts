/**
 * One collection pass. For each enabled group it works out where to resume,
 * reads that group's new messages across every open shard, decodes them and
 * inserts the ones worth storing. Resuming from the newest stored message with
 * an overlap — rather than a saved cursor — means a crash loses nothing: the
 * unique key drops whatever the overlap re-reads.
 */
import { decodeMessage, type DecodedMessage } from './decode.js'
import type { ShardReader } from './shard.js'
import type { CollectorStore } from './store.js'

const SECONDS = 1000
const DAY_SECONDS = 24 * 60 * 60

export interface CollectOptions {
  overlapSeconds: number
  backfillDays: number
}

/** How many new messages a pass stored, per group. */
export type CollectResult = Map<string, number>

/**
 * The unix second to read a group from: a little before its newest stored
 * message, or `backfillDays` back when it has none yet.
 */
export function resumeSecond(
  newest: Date | null,
  now: Date,
  options: CollectOptions,
): number {
  const ms = newest
    ? newest.getTime() - options.overlapSeconds * SECONDS
    : now.getTime() - options.backfillDays * DAY_SECONDS * SECONDS
  return Math.floor(ms / SECONDS)
}

/** Collect one group across all shards. Returns how many new rows were stored. */
export async function collectGroup(
  readers: ShardReader[],
  store: CollectorStore,
  group: string,
  now: Date,
  options: CollectOptions,
  names: Map<string, string> = new Map(),
): Promise<number> {
  const since = resumeSecond(await store.newestTimestamp(group), now, options)
  const decoded: DecodedMessage[] = []
  for (const reader of readers) {
    for (const raw of reader.readMessages(group, since)) {
      const message = decodeMessage(raw)
      if (message) decoded.push(message)
    }
  }
  return store.insertMessages(group, decoded, names)
}

/** Collect every enabled group once. */
export async function collectOnce(
  readers: ShardReader[],
  store: CollectorStore,
  groups: string[],
  now: Date,
  options: CollectOptions,
  names: Map<string, string> = new Map(),
): Promise<CollectResult> {
  const result: CollectResult = new Map()
  for (const group of groups) {
    result.set(
      group,
      await collectGroup(readers, store, group, now, options, names),
    )
  }
  return result
}
