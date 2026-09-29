/**
 * Finds and opens the message shards under a `db_storage` directory. WeChat
 * keeps one `message/message_N.db` and adds more as the history grows, each
 * with its own key. A shard we have no key for is reported, not fatal: the
 * others keep collecting and the owner is asked to re-run key extraction.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ShardReader } from './shard.js'

/** The message shards present, as paths relative to `db_storage`, sorted. */
export function listShards(dbDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(join(dbDir, 'message'))
  } catch {
    return []
  }
  return names
    .filter((name) => /^message_\d+\.db$/.test(name))
    .sort()
    .map((name) => `message/${name}`)
}

export interface OpenedShards {
  readers: ShardReader[]
  /** Shard paths present on disk but absent from keys.json. */
  missing: string[]
}

/** Open every shard we hold a key for; list the rest as missing. */
export function openShards(
  dbDir: string,
  keys: Map<string, string>,
): OpenedShards {
  const readers: ShardReader[] = []
  const missing: string[] = []
  for (const rel of listShards(dbDir)) {
    const key = keys.get(rel)
    if (!key) {
      missing.push(rel)
      continue
    }
    readers.push(ShardReader.open(join(dbDir, rel), key, rel))
  }
  return { readers, missing }
}
