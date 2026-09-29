/**
 * Synthetic WeChat databases for tests: WeChat 4.x's own table shape,
 * encrypted the way WeChat encrypts (SQLCipher 4, raw key, WAL left
 * uncheckpointed), holding only made-up rows. The repository is public, so no
 * test may lean on a real database.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { randomBytes } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'
import { conversationTable } from './shard.js'

/** A fresh raw key in the shape the keys file yields: 32-byte key + 16-byte salt. */
export function randomRawKey(): string {
  return randomBytes(48).toString('hex')
}

export interface FixtureMessage {
  serverId: bigint
  /** Low half; the type. Defaults to 1 (text). */
  type?: number
  /** High half; the subtype. */
  subType?: number
  /** A username; registered in Name2Id on first use. */
  sender: string
  createTime: number
  content: string | null
  /** Store `content` as a zstd blob with WCDB_CT = 4, as WeChat often does. */
  compressContent?: boolean
  source?: string | null
  compressSource?: boolean
}

// A subset of contact/contact.db's columns, enough for name resolution.
const CONTACT_COLUMNS =
  'id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, remark TEXT, ' +
  'nick_name TEXT'

// Columns copied verbatim from message_0.db on the owner's Mac (WeChat 4.1.x).
const MSG_COLUMNS =
  'local_id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, ' +
  'local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, ' +
  'create_time INTEGER, status INTEGER, upload_status INTEGER, ' +
  'download_status INTEGER, server_seq INTEGER, origin_source INTEGER, ' +
  'source TEXT, message_content TEXT, compress_content TEXT, ' +
  'packed_info_data BLOB, WCDB_CT_message_content INTEGER DEFAULT NULL, ' +
  'WCDB_CT_source INTEGER DEFAULT NULL'

function openForWriting(path: string, rawKey: string): Database.Database {
  const db = new Database(path)
  db.pragma("cipher = 'sqlcipher'")
  db.pragma('legacy = 4')
  db.pragma(`key = "x'${rawKey}'"`)
  db.pragma('journal_mode = WAL')
  // Leave writes in the WAL, as a running WeChat does between checkpoints —
  // that is the state the reader must cope with.
  db.pragma('wal_autocheckpoint = 0')
  return db
}

function pack(text: string | null, compress?: boolean): string | Buffer | null {
  if (text === null) return null
  return compress ? zstdCompressSync(Buffer.from(text)) : text
}

/** A message database, held open so tests can add rows that stay in the WAL. */
export class MessageDbWriter {
  private readonly db: Database.Database
  private seq = 0

  constructor(path: string, rawKey: string) {
    this.db = openForWriting(path, rawKey)
    this.db.exec(
      'CREATE TABLE Name2Id(user_name TEXT PRIMARY KEY, is_session INTEGER)',
    )
  }

  private idOf(username: string): number {
    this.db
      .prepare('INSERT OR IGNORE INTO Name2Id(user_name, is_session) VALUES (?, 0)')
      .run(username)
    const row = this.db
      .prepare('SELECT rowid AS id FROM Name2Id WHERE user_name = ?')
      .get(username) as { id: number }
    return row.id
  }

  add(conversation: string, m: FixtureMessage): void {
    const table = conversationTable(conversation)
    this.db.exec(`CREATE TABLE IF NOT EXISTS "${table}"(${MSG_COLUMNS})`)
    this.idOf(conversation)
    this.db
      .prepare(
        `INSERT INTO "${table}" (server_id, local_type, sort_seq,
           real_sender_id, create_time, message_content,
           WCDB_CT_message_content, source, WCDB_CT_source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.serverId,
        (BigInt(m.subType ?? 0) << 32n) | BigInt(m.type ?? 1),
        BigInt(++this.seq),
        BigInt(this.idOf(m.sender)),
        BigInt(m.createTime),
        pack(m.content, m.compressContent),
        m.compressContent ? 4 : 0,
        pack(m.source ?? null, m.compressSource),
        m.compressSource ? 4 : 0,
      )
  }

  close(): void {
    this.db.close()
  }
}

export interface FixtureContact {
  username: string
  remark?: string
  nickName?: string
  /** Written to `stranger` rather than `contact`, as group members often are. */
  stranger?: boolean
}

/** Write a synthetic contact.db with the given rows. */
export function writeContactDb(
  path: string,
  rawKey: string,
  rows: FixtureContact[],
): void {
  const db = openForWriting(path, rawKey)
  db.exec(
    `CREATE TABLE contact(${CONTACT_COLUMNS}); CREATE TABLE stranger(${CONTACT_COLUMNS});`,
  )
  for (const row of rows) {
    db.prepare(
      `INSERT INTO ${row.stranger ? 'stranger' : 'contact'} (username, remark, nick_name)
       VALUES (?, ?, ?)`,
    ).run(row.username, row.remark ?? '', row.nickName ?? '')
  }
  db.close()
}
