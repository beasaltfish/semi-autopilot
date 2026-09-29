/**
 * Reads one WeChat message database (a "shard": message_0.db, message_1.db, …)
 * opened read-only through its raw SQLCipher key. Turns stored rows into the
 * `RawMessage` shape `decode` consumes: blobs decompressed, sender resolved to
 * a username. It never writes to WeChat's files.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { createHash } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import type { RawMessage } from './decode.js'

/** A database could not be opened or its key did not fit. */
export class WechatDbError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WechatDbError'
  }
}

/** The per-conversation table name: `Msg_` + md5 of the conversation username. */
export function conversationTable(username: string): string {
  return `Msg_${createHash('md5').update(username).digest('hex')}`
}

/** A stored column: a plain string, a zstd blob (WCDB_CT = 4), or absent. */
function decompress(value: unknown, compressType: unknown): string | null {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    // Compressed content is stored as a blob; WCDB_CT = 4 marks zstd.
    return Number(compressType) === 4
      ? zstdDecompressSync(value).toString('utf8')
      : value.toString('utf8')
  }
  return String(value)
}

interface MessageRow {
  server_id: bigint
  local_type: bigint
  real_sender_id: bigint
  create_time: bigint
  message_content: unknown
  WCDB_CT_message_content: unknown
  source: unknown
  WCDB_CT_source: unknown
}

export class ShardReader {
  private senderNames?: Map<number, string>

  private constructor(
    private readonly db: Database.Database,
    /** The shard's path relative to db_storage, e.g. `message/message_0.db`. */
    readonly name: string,
  ) {}

  /** Open a shard and prove the key by touching the schema. */
  static open(path: string, rawKey: string, name: string): ShardReader {
    let db: Database.Database
    try {
      db = new Database(path, { readonly: true, fileMustExist: true })
    } catch (error) {
      throw new WechatDbError(`Cannot open ${name} at ${path}`, { cause: error })
    }
    try {
      db.pragma("cipher = 'sqlcipher'")
      db.pragma('legacy = 4')
      db.pragma(`key = "x'${rawKey}'"`)
      // The pragmas return ok even on a wrong key; the first real query is
      // what proves it.
      db.prepare('SELECT count(*) FROM sqlite_master').get()
    } catch (error) {
      db.close()
      throw new WechatDbError(
        `The key for ${name} did not fit — re-run key extraction`,
        { cause: error },
      )
    }
    return new ShardReader(db, name)
  }

  /** rowid → username, from Name2Id. Cached: it changes rarely and is small. */
  private name2id(): Map<number, string> {
    if (!this.senderNames) {
      this.senderNames = new Map(
        (
          this.db
            .prepare('SELECT rowid AS id, user_name AS name FROM Name2Id')
            .all() as { id: number; name: string }[]
        ).map((row) => [row.id, row.name]),
      )
    }
    return this.senderNames
  }

  /** Every conversation username Name2Id knows in this shard. */
  conversations(): string[] {
    return (
      this.db.prepare('SELECT user_name AS name FROM Name2Id').all() as {
        name: string
      }[]
    ).map((row) => row.name)
  }

  /** How many messages this shard holds for a conversation (0 if none). */
  messageCount(username: string): number {
    if (!this.hasConversation(username)) return 0
    const { n } = this.db
      .prepare(`SELECT count(*) AS n FROM "${conversationTable(username)}"`)
      .get() as { n: number }
    return n
  }

  /** True if this shard holds the conversation's table. */
  hasConversation(username: string): boolean {
    const table = conversationTable(username)
    return (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table) !== undefined
    )
  }

  /**
   * The conversation's messages with `create_time >= sinceSeconds`, oldest
   * first. Empty if this shard has no table for it.
   */
  readMessages(username: string, sinceSeconds: number): RawMessage[] {
    if (!this.hasConversation(username)) return []
    const names = this.name2id()
    const rows = this.db
      .prepare(
        `SELECT server_id, local_type, real_sender_id, create_time,
                message_content, WCDB_CT_message_content, source, WCDB_CT_source
         FROM "${conversationTable(username)}"
         WHERE create_time >= ?
         ORDER BY sort_seq ASC`,
      )
      // server_id and local_type exceed 2^53; read every integer as BigInt.
      .safeIntegers(true)
      .all(BigInt(sinceSeconds)) as MessageRow[]

    return rows.map((row) => ({
      serverId: row.server_id,
      localType: row.local_type,
      senderUsername: names.get(Number(row.real_sender_id)) ?? 'unknown',
      createTime: Number(row.create_time),
      content: decompress(row.message_content, row.WCDB_CT_message_content),
      source: decompress(row.source, row.WCDB_CT_source),
    }))
  }

  close(): void {
    this.db.close()
  }
}
