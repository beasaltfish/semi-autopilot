/**
 * Connectivity check, run by hand:
 *
 *   WECHAT_DB_DIR=/path/to/db_storage WECHAT_KEYS_PATH=/path/to/keys.json \
 *     pnpm --filter wechat-collector probe
 *
 * Opens the LIVE encrypted message_0.db read-only with the raw key and counts
 * rows. Prints counts only — never a name or a message — so its output is safe
 * to paste. A real driver reads the -wal alongside the .db automatically, so a
 * message just sent shows up here without WeChat checkpointing first.
 */
import 'dotenv/config'
import Database from 'better-sqlite3-multiple-ciphers'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dbDir = process.env.WECHAT_DB_DIR
const keysPath = process.env.WECHAT_KEYS_PATH
if (!dbDir || !keysPath) {
  throw new Error('Set WECHAT_DB_DIR and WECHAT_KEYS_PATH.')
}

const rel = 'message/message_0.db'
const entry = (
  JSON.parse(readFileSync(keysPath, 'utf8')) as Record<
    string,
    { enc_key: string; salt: string }
  >
)[rel]
if (!entry) throw new Error(`No key for ${rel} in ${keysPath}`)

// 96 hex digits: the 32-byte key, then the file's 16-byte salt. SQLCipher's
// raw-key syntax then skips key derivation entirely.
const rawKey = `${entry.enc_key}${entry.salt}`.toLowerCase()

const db = new Database(join(dbDir, rel), {
  readonly: true,
  fileMustExist: true,
})
try {
  db.pragma("cipher = 'sqlcipher'")
  db.pragma('legacy = 4')
  db.pragma(`key = "x'${rawKey}'"`)

  // The pragmas above return ok even on a wrong key; the first real query is
  // what proves the key. An escaped LIKE finds the per-conversation tables.
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name LIKE 'Msg\\_%' ESCAPE '\\'",
    )
    .all() as { name: string }[]

  let total = 0
  for (const { name } of tables) {
    const { n } = db.prepare(`SELECT count(*) AS n FROM "${name}"`).get() as {
      n: number
    }
    total += n
  }
  console.log(`opened ok — ${tables.length} conversation tables, ${total} rows`)
} finally {
  db.close()
}
