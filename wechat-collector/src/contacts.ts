/**
 * Resolves a WeChat username to a readable name from contact.db, so a stored
 * message carries "小李" rather than "wxid_r00rgq011d0n11". Prefers the
 * member's own nickname — that is closest to what the group shows — and falls
 * back to the owner's remark for them, then, at the call site, to the username.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { join } from 'node:path'
import { WechatDbError } from './shard.js'

interface NameRow {
  username: string
  remark: string | null
  nick_name: string | null
}

/**
 * username → display name, for everyone contact.db names. A member is in
 * `contact` if the owner has them, in `stranger` otherwise — group members are
 * often the latter — so both are read. Names are dropped when empty, leaving
 * the caller to fall back to the username.
 */
export function loadContactNames(
  dbDir: string,
  rawKey: string,
): Map<string, string> {
  const path = join(dbDir, 'contact/contact.db')
  let db: Database.Database
  try {
    db = new Database(path, { readonly: true, fileMustExist: true })
  } catch (error) {
    throw new WechatDbError(`Cannot open contact.db at ${path}`, { cause: error })
  }
  try {
    db.pragma("cipher = 'sqlcipher'")
    db.pragma('legacy = 4')
    db.pragma(`key = "x'${rawKey}'"`)

    const names = new Map<string, string>()
    for (const table of ['contact', 'stranger']) {
      const rows = db
        .prepare(`SELECT username, remark, nick_name FROM ${table}`)
        .all() as NameRow[]
      for (const row of rows) {
        const name = row.nick_name?.trim() || row.remark?.trim()
        if (name) names.set(row.username, name)
      }
    }
    return names
  } catch (error) {
    if (error instanceof WechatDbError) throw error
    throw new WechatDbError('The key for contact.db did not fit', { cause: error })
  } finally {
    db.close()
  }
}
