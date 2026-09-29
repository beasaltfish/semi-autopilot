import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadContactNames } from './contacts.js'
import { randomRawKey, writeContactDb } from './fixture.js'
import { WechatDbError } from './shard.js'

let dir: string
let key: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-contacts-'))
  mkdirSync(join(dir, 'contact'))
  key = randomRawKey()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(rows: Parameters<typeof writeContactDb>[2]): void {
  writeContactDb(join(dir, 'contact/contact.db'), key, rows)
}

describe('loadContactNames', () => {
  it('prefers the nickname, then the remark', () => {
    write([
      { username: 'wxid_a', remark: '李老师', nickName: '小李' },
      { username: 'wxid_b', remark: '老王' },
    ])
    const names = loadContactNames(dir, key)
    expect(names.get('wxid_a')).toBe('小李')
    expect(names.get('wxid_b')).toBe('老王')
  })

  it('reads group members from the stranger table too', () => {
    write([{ username: 'wxid_c', nickName: '路人', stranger: true }])
    expect(loadContactNames(dir, key).get('wxid_c')).toBe('路人')
  })

  it('omits anyone with no remark and no nickname', () => {
    write([{ username: 'wxid_d' }])
    expect(loadContactNames(dir, key).has('wxid_d')).toBe(false)
  })

  it('rejects a wrong key', () => {
    write([{ username: 'wxid_a', nickName: 'x' }])
    expect(() => loadContactNames(dir, randomRawKey())).toThrow(WechatDbError)
  })
})
