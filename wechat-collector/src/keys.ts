/**
 * Reads the `keys.json` that wechat-key-macos's extraction writes: one raw
 * SQLCipher key per database file. Read on every pass rather than once, so
 * re-running the extraction after WeChat adds a shard takes effect without a
 * restart.
 */
import { readFileSync } from 'node:fs'

/** keys.json is missing, unreadable, or not what the extraction writes. */
export class KeysFileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'KeysFileError'
  }
}

const HEX = /^[0-9a-f]+$/i

function isHex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && HEX.test(value)
}

/**
 * Raw keys by database path relative to `db_storage`, each the 96 hex digits
 * SQLCipher's raw-key syntax takes: the 32-byte key, then the file's 16-byte
 * salt. A key that is not hex is refused here rather than trusted in the
 * PRAGMA it is interpolated into.
 */
export function loadKeys(path: string): Map<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new KeysFileError(`Cannot read the WeChat keys file at ${path}`, {
      cause: error,
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KeysFileError(`${path} is not a JSON object of keys`)
  }

  const keys = new Map<string, string>()
  for (const [rel, entry] of Object.entries(parsed)) {
    const { enc_key: key, salt } = (entry ?? {}) as Record<string, unknown>
    if (!isHex(key, 64) || !isHex(salt, 32)) {
      throw new KeysFileError(
        `${path}: the entry for ${rel} is not a 64-digit hex key and a 32-digit hex salt`,
      )
    }
    keys.set(rel, `${key}${salt}`.toLowerCase())
  }
  return keys
}
