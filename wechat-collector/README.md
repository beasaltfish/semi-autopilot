# wechat-collector

Reads the allowlisted WeChat groups out of WeChat's local databases and stores
each message in Postgres `messages` with `source = 'wechat'`. Phase 1 of the
WeChat assistant; it only reads and stores, and never writes to WeChat.

## How it reads WeChat

WeChat 4.x keeps its chat history in per-conversation tables inside
SQLCipher-encrypted databases. The collector opens them **read-only** with a
raw key and reads the WAL alongside the main file, so new messages appear
without WeChat checkpointing first.

Extracting the key is a separate, occasional, by-hand step (see below); the
collector never does it.

## One-time setup: get the keys

The key is stable per account — extract it once, and again only if WeChat adds
a database shard or you log in afresh.

1. Read, then run, the extraction from
   [wechat-key-macos](https://github.com/3351666087/wechat-key-macos). It
   re-signs WeChat with `get-task-allow`, hooks it with Frida, and writes
   `keys.json`. **Reinstall WeChat afterwards** to restore its signature.
2. Keep `keys.json` **outside this repository**. It reads every chat you have.

## Configure

```bash
cp .env.example .env
# set WECHAT_DB_DIR and WECHAT_KEYS_PATH
```

Then find your group ids and add the ones you want:

```bash
pnpm --filter wechat-collector groups   # prints id, name, message count
# put the @chatroom ids into WECHAT_GROUPS in .env
```

## Run

```bash
pnpm db:up                          # from the repo root, once
pnpm --filter wechat-collector start
```

Keep WeChat running and logged in. The collector re-reads `keys.json` and
re-opens the shards every poll, so re-running the extraction takes effect
without a restart. If a shard has no key, or the databases stay unreadable for
ten minutes, it sends one Telegram/Discord alert and keeps going on what it can.

## Check it worked

```bash
pnpm --filter wechat-collector probe   # counts rows it can read, no content
```

## Scope

v1 stores text messages. Images, stickers, video, system notices and quoted
replies are recognised but skipped. Readable author names (from `contact.db`)
and embeddings are later additions.
