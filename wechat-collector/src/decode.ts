/**
 * One raw WeChat message row → one row for the `messages` table. Pure: no
 * database, no decryption, no decompression. The shard reader hands this a
 * row whose blobs are already decompressed and whose sender is already
 * resolved to a username, and this decides what — if anything — to store.
 *
 * v1 stores text only. Images, stickers, video, system notices and quoted
 * replies are recognised (so the counts add up) but returned as `null`,
 * meaning "not stored". Storing them as context is a later addition; the
 * judgement pipeline reads text.
 */

/** A row as the shard reader produces it, blobs decompressed, sender named. */
export interface RawMessage {
  /** WeChat's global message id. Beyond 2^53, so it stays a bigint here. */
  serverId: bigint
  /** Low 32 bits are the type, high 32 the subtype. */
  localType: bigint
  /** The sender's username (wxid or a @chatroom-scoped id). */
  senderUsername: string
  /** Unix seconds. */
  createTime: number
  /** Decompressed text, or null for a row that carries none. */
  content: string | null
  /** Decompressed `<msgsource>` XML, or null. Carries the @-mention list. */
  source: string | null
}

/** What goes into `messages`, minus the columns the store stamps itself. */
export interface DecodedMessage {
  messageId: string
  authorId: string
  content: string
  timestamp: Date
  rawData: { kind: 'text'; mentions: string[] }
}

const TYPE_TEXT = 1

/** Split WeChat's packed `local_type` into its type and subtype halves. */
export function messageType(localType: bigint): {
  type: number
  subType: number
} {
  return {
    type: Number(localType & 0xffffffffn),
    subType: Number((localType >> 32n) & 0xffffffffn),
  }
}

/**
 * In a group, another member's text arrives as `"<username>:\n<text>"`. The
 * owner's own messages carry no prefix, so this strips only when the prefix is
 * exactly the sender — the owner writing `todo:\nbuy milk` keeps `todo`.
 */
function stripSenderPrefix(content: string, sender: string): string {
  const prefix = `${sender}:\n`
  return content.startsWith(prefix) ? content.slice(prefix.length) : content
}

/** The @-mentioned usernames, from `<atuserlist>…</atuserlist>` in the source. */
function parseMentions(source: string | null): string[] {
  if (!source) return []
  const match = source.match(/<atuserlist>([\s\S]*?)<\/atuserlist>/)
  if (!match) return []
  return match[1]
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/** A stored row, or null to skip this message. */
export function decodeMessage(raw: RawMessage): DecodedMessage | null {
  if (messageType(raw.localType).type !== TYPE_TEXT) return null
  if (raw.content === null) return null
  return {
    messageId: raw.serverId.toString(),
    authorId: raw.senderUsername,
    content: stripSenderPrefix(raw.content, raw.senderUsername),
    timestamp: new Date(raw.createTime * 1000),
    rawData: { kind: 'text', mentions: parseMentions(raw.source) },
  }
}
