import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KeysFileError, loadKeys } from './keys.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-keys-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(content: string): string {
  const path = join(dir, 'keys.json')
  writeFileSync(path, content)
  return path
}

const KEY = 'AB'.repeat(32)
const SALT = 'cd'.repeat(16)

describe('loadKeys', () => {
  it('joins each key and salt into one lower-case raw key', () => {
    const path = write(
      JSON.stringify({
        'message/message_0.db': { enc_key: KEY, salt: SALT, size_mb: 3.1 },
      }),
    )
    expect(loadKeys(path)).toEqual(
      new Map([['message/message_0.db', `${'ab'.repeat(32)}${SALT}`]]),
    )
  })

  it('says where the file was looked for when it is missing', () => {
    expect(() => loadKeys(join(dir, 'nope.json'))).toThrow(KeysFileError)
    expect(() => loadKeys(join(dir, 'nope.json'))).toThrow('nope.json')
  })

  it('refuses a key that is not 64 hex digits', () => {
    const path = write(
      JSON.stringify({ 'message/message_0.db': { enc_key: "x'; --", salt: SALT } }),
    )
    expect(() => loadKeys(path)).toThrow('message/message_0.db')
  })

  it('refuses a file that is not an object', () => {
    expect(() => loadKeys(write('[]'))).toThrow(KeysFileError)
  })
})
