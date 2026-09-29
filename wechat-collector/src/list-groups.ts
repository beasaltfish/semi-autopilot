/**
 * Lists the groups this account is in, so the owner can pick which to put in
 * WECHAT_GROUPS:
 *
 *   pnpm --filter wechat-collector groups
 *
 * Prints each group's @chatroom id, its name (from contact.db, if its key is
 * present) and a message count. Run privately — group names are the owner's
 * own data.
 */
import 'dotenv/config'
import Database from 'better-sqlite3-multiple-ciphers'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { loadKeys } from './keys.js'
import { openShards } from './shards.js'

const config = loadConfig()
const keys = loadKeys(config.keysPath)

/** username → display name, from contact.db when we hold its key. */
function contactNames(): Map<string, string> {
  const key = keys.get('contact/contact.db')
  if (!key) return new Map()
  const db = new Database(join(config.dbDir, 'contact/contact.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    db.pragma("cipher = 'sqlcipher'")
    db.pragma('legacy = 4')
    db.pragma(`key = "x'${key}'"`)
    const names = new Map<string, string>()
    for (const table of ['contact', 'stranger']) {
      const rows = db
        .prepare(
          `SELECT username, nick_name AS nick, remark FROM ${table} ` +
            "WHERE username LIKE '%@chatroom'",
        )
        .all() as { username: string; nick: string | null; remark: string | null }[]
      for (const row of rows) {
        names.set(row.username, row.remark || row.nick || '')
      }
    }
    return names
  } finally {
    db.close()
  }
}

const names = contactNames()
const { readers, missing } = openShards(config.dbDir, keys)
if (missing.length) {
  console.log(`(no key for ${missing.join(', ')} — those shards are skipped)\n`)
}

// Sum a group's messages across every shard.
const counts = new Map<string, number>()
for (const reader of readers) {
  for (const username of reader.conversations()) {
    if (!username.endsWith('@chatroom')) continue
    counts.set(username, (counts.get(username) ?? 0) + reader.messageCount(username))
  }
}
readers.forEach((reader) => reader.close())

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
console.log(`${rows.length} groups:\n`)
for (const [username, count] of rows) {
  const name = names.get(username) || '(name unavailable)'
  console.log(`${count.toString().padStart(6)}  ${username}  ${name}`)
}
