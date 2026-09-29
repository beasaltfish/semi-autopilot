/**
 * The driver ships an `index.d.ts`, but its package.json `exports` map has no
 * `types` condition, so under `moduleResolution: nodenext` TypeScript cannot
 * reach it. Re-export the shipped declarations under the bare specifier.
 */
declare module 'better-sqlite3-multiple-ciphers' {
  import Database = require('better-sqlite3-multiple-ciphers/index.js')
  export = Database
}
