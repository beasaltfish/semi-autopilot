/**
 * Resolves a WeChat username to a readable name from contact.db, so a stored
 * message carries "李老师" rather than "wxid_r00rgq011d0n11". A member the
 * owner has renamed shows that remark; otherwise their own nickname; and when
 * contact.db has neither — or no key — the caller falls back to the username.
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
 * often the latter — so both are read. Empty names are dropped, leaving the
 * caller to fall back to the username.
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
        const name = row.remark?.trim() || row.nick_name?.trim()
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
