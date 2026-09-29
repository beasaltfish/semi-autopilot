# WeChat Group Assistant, Phase 1 — Design

- **Date:** 2026-09-28
- **Status:** Approved in conversation, awaiting written-spec review

## Goal

Build an assistant that reads the WeChat groups the owner is in and decides,
for each message, whether the owner should reply and what they would say. The
assistant is meant to reply the way the owner does: briefly, mostly
encouraging people or answering their questions, and sometimes @-mentioning a
member who has answered something similar before.

Phase 1 runs in **shadow mode**. It reads, judges and drafts, then pushes the
draft to the owner on Telegram, and it sends nothing to WeChat. The owner's
feedback on each draft (👍 / 👎 / an edited version) is stored, and that
feedback becomes the data used to calibrate the judgement before anything is
sent automatically.

The repository is also renamed to `semi-autopilot`, a name for a set of
automations where the machine proposes and a person decides.

## Non-Goals (Phase 1)

- **Sending anything to WeChat.** The next phase adds sending after the owner
  confirms a draft. Fully automatic sending comes after that, if it comes at
  all.
- **Private chats.** Group chats only.
- **Groups outside the allowlist.** They are ignored entirely.
- **An expert-profile table.** Expertise is inferred by searching the history
  with embeddings. A table is added only if that proves insufficient.
- **Moving the other services' notifications to Telegram.** They stay on
  Discord.
- **Replacing ai-assistant's Fireworks client.** It duplicates `shared/llm`,
  but it is left as it is for now.

## Context

The workspace is a pnpm monorepo of services that never call each other. They
meet only in Postgres, which already has pgvector enabled and a `messages`
table with a `source` column and a 1536-dimension `embedding` column. Two new
services join the workspace on the same terms:

```
 WeChat (Mac) ─▶ SQLCipher DBs ─▶ wechat-collector ─┐
                                                     ▼
                                              ┌──────────────┐
                                              │  PostgreSQL  │
                                              │  messages    │
                                              │  channels    │
                                              │  reply_      │
                                              │  decisions   │
                                              └──────────────┘
                                                     │
                     rules ─▶ Jev ─▶ embedding ─▶ LLM
                                                     ▼
                                          wechat-responder ◀─▶ Telegram bot
```

### Why read the local database rather than use a WeChat protocol

The owner keeps WeChat running on a Mac. Reading its local database and, in a
later phase, sending by driving the UI through macOS Accessibility leaves the
WeChat client unmodified. To WeChat, the owner is simply using it. Protocol
based approaches such as Wechaty's pad puppets, and client hooks, carry a
materially higher risk of getting the account banned.

### Why the collector reads the databases itself

*Revised 2026-09-29.* The original design read through
[chatlog](https://github.com/sjzar/chatlog). Its author deleted the code in
October 2025 after WeChat raised compliance concerns, and the forks that
followed are being taken down one by one; at least one surviving "fork" is a
malware lure. A running service cannot depend on any of them.

The work splits in two, along how often each part runs:

- **Key extraction** runs once per account, and again only when WeChat adds a
  database shard or the owner logs in afresh. It uses a third-party script,
  [wechat-key-macos](https://github.com/3351666087/wechat-key-macos)'s
  `scripts/extract_key.py`, which the owner has read, forked and runs by hand.
  It hooks CommonCrypto with Frida, which needs WeChat ad-hoc re-signed with
  `get-task-allow`; the owner reinstalls WeChat afterwards to restore the
  original signature. It writes `keys.json`, one raw key per database file.
  SIP stays enabled.
- **Reading** runs continuously and is ours. The collector opens WeChat's
  SQLCipher 4 databases read-only with those raw keys, through
  `better-sqlite3-multiple-ciphers`, which also reads the uncommitted WAL —
  where the newest messages are. If the extraction script disappears too, only
  the manual step is affected; the collector keeps working on the keys it has.

`keys.json` reads every chat the owner has. It lives outside the repository.

### WeChat 4.x storage, as observed on the owner's Mac

- `db_storage/message/message_N.db` holds one table per conversation, named
  `Msg_` + md5(conversation username). Group usernames end in `@chatroom`.
  WeChat adds `message_1.db` and onward as the history grows, each with its
  own key.
- `local_type` packs the type in its low 32 bits and the subtype in the high
  32: `1` text, `3` image, `47` sticker, `43` video, `10000` system,
  `49/57` a quoted reply, other `49/*` links, files and mini-programs.
- `real_sender_id` is the rowid of the sender's username in `Name2Id`.
- In a group, another member's text arrives as `"<username>:\n<text>"`; the
  owner's own messages carry no prefix.
- `message_content` and `source` are zstd-compressed when their
  `WCDB_CT_*` column is `4`. `source` is an XML blob whose `<atuserlist>`
  lists the @-mentioned usernames.
- `server_id` is a 64-bit integer, beyond JavaScript's safe integer range.
- `contact/contact.db` gives names: `contact` and `stranger` rows by
  `username`, with `remark` and `nick_name`.

## Data Model

### `messages` (existing)

- `source` gains `'wechat'`. The same enum change applies to `channels` and
  `threads`.
- Field mapping: `channelId` is the group's chatroom id, `spaceId` is `''`
  because WeChat has no space layer, `authorId` is the member's wxid,
  `authorName` is their group nickname, and `replyToMessageId` holds the
  message being quoted, if any.
- The table stores every member's messages, the owner's included, because the
  owner's own messages are the style samples.
- `rawData` is widened from `DiscordRawData` to a per-source type. WeChat's raw
  payload carries the @-mention list.
- The `embedding` column is filled only for messages with content. Stickers
  and bare interjections such as "哈哈" are not embedded.

### `channels` (existing)

It stores the group name and gains `enabled boolean NOT NULL DEFAULT false`,
the allowlist switch. The collector reads only enabled groups.

### `reply_decisions` (new)

One row per message that reached the judgement pipeline:

| column | meaning |
|---|---|
| `message_id` | FK to `messages.id`, unique |
| `stage` | furthest layer reached: `rule`, `jev`, `template`, `llm` |
| `route` | `drop`, `alert`, `template`, `draft`, `record_only` |
| `jev` | jsonb: each judgement with its label and confidence |
| `retrieved_ids` | ids of the history messages that were retrieved |
| `mention_author_id` | who the draft proposes to @, if anyone |
| `draft` | the proposed reply text |
| `telegram_message_id` | the card that was pushed |
| `feedback` | `approve`, `reject`, `edit`, `ack`, or null |
| `edited_text` | the owner's version, when `feedback = 'edit'` |
| `expired_at` | when the card was marked expired |
| timestamps | `created_at`, `feedback_at` (TIMESTAMPTZ) |

The table is the calibration dataset. Its columns are what later phases will
train or tune against.

### Config (not in the database, git-ignored)

- The group allowlist is seeded from config into `channels.enabled`.
- The style rules are a short list of hard "never" rules in the owner's voice.
- The praise templates are the library of short replies used without the LLM.

These files hold personal information, and the repository is public.

## Judgement Pipeline (`wechat-responder`)

0. **Wait.** A message is judged only once it is 1–2 minutes old, which
   leaves time to see whether someone else has already answered it.
1. **Hard rules** (code, no cost).
   - Drop: the owner's own messages, groups that are not enabled, system
     messages, and sticker-only messages.
   - Flag: @-mentions the owner, quotes the owner, contains the owner's name.
2. **Jev** makes one call that returns several typed judgements:
   - intent: `question`, `praise`, `chitchat`, `ai_probe`, `critical`
   - addressed to the owner: yes or no
   - needs history: yes or no
3. **Routing.**
   - `ai_probe` or `critical` → **alert**. No draft is written; the owner is
     notified on Telegram.
   - `praise` with high confidence → **template**. A reply is picked from the
     template library without calling the LLM. The same template is not used
     for the same person within a cooldown window.
   - `question` → if history is needed, run an embedding search for similar
     past discussions and note who answered them, which gives the @
     candidate. Then **draft**.
   - `chitchat`, or low confidence → **record_only**.
4. **LLM drafts.** The LLM only phrases the reply; every decision has already
   been made. Its input is the message, the last few messages in the group,
   the retrieved history, the @ target, the style rules, and a few of the
   owner's past replies that are similar to this one (few-shot). Its output is
   one short reply.
5. **Validate.** Check a length cap and a banned-phrase list that catches
   AI-sounding phrases such as "作为一个 AI" or "希望对你有帮助". On failure,
   regenerate once. If it fails again, push the card without a draft.
6. **Rate limit.** Allow at most N drafts per group per hour. This applies in
   shadow mode too, so the recorded data matches what live sending would have
   produced.

Every Jev judgement is also recorded, so the owner can later see why a
message was dropped.

## Telegram

- The bot uses Bot API long polling, so the Mac does not need a public
  endpoint. Only the owner's chat id is honoured, and everything else is
  ignored. The bot runs inside `wechat-responder`.
- **Draft card:** group, sender, the original message, the Jev judgements
  (for example `question 0.91`), the @ target and the draft, with buttons
  👍 / 👎 / ✏️. Pressing ✏️ makes the bot ask for the edited text as a reply,
  which it then stores.
- **Alert card:** an AI probe or a critical item, with no draft and a single
  "知道了" button that records `ack`.
- **Expiry:** a card that has had no response after 30 minutes is edited to
  show that it expired. Feedback on it is still recorded, because it still
  shows whether the judgement was right. In the next phase, an expired card is
  never sent.
- **System notifications** go through `shared/notifier`, which gains a
  Telegram channel. Each service chooses its channel in its config.

## Shared Modules

Following the existing convention, these are subpath exports of `shared`
rather than new packages:

- **`shared/llm`:** tweet-generator's `LlmClient`, `extractJson`, the
  error classes and its retry policy move here unchanged, and an `embed()`
  method for an OpenAI-compatible `/embeddings` endpoint is added, with
  1536 dimensions to match the column. tweet-generator imports from `shared`,
  and its tests must still pass.
- **`shared/jev`:** new. A single interface:
  `decide(task, input) → { label, confidence }`. Jev's actual API is checked
  against its official documentation before this is written.
- **`shared/notifier`:** gains a Telegram channel alongside Discord.

Modules are extracted only when the WeChat services need them. There is no
separate refactoring pass beforehand.

## Rename and Database Rebuild

- The local directory and the GitHub repository are renamed to
  `semi-autopilot`. Renaming the GitHub repository is an outward-facing change
  and is confirmed with the owner at the time it is done.
- The database, the Docker container and the volume are renamed to
  `semi_autopilot` / `semi-autopilot`. **The database is rebuilt from scratch,
  and the existing Discord messages and the tweet queue are discarded.** The
  owner has agreed to this. It is still confirmed once more immediately before
  it runs.
- The defaults in `shared/src/db.ts`, the healthcheck in `docker-compose.yml`,
  `.env.example` files and the READMEs are updated to match.

## Error Handling

- **Databases unreadable** (a wrong or stale key, a missing file, no Full Disk
  Access): the collector retries with backoff. After 10 minutes of continuous
  failure it sends a Telegram attention notification. It resumes from the
  newest message it has stored for each group, re-reading a short overlap, so
  on recovery it loses nothing.
- **A shard with no key:** WeChat has started a new `message_N.db`. The
  collector keeps reading the shards it can and asks the owner, once, to
  re-run key extraction.
- **Duplicates:** the unique constraint on `(source, message_id)` makes
  inserts idempotent.
- **Jev or LLM down:** the message stays unprocessed and is retried, and the
  owner is alerted once rather than once per message. After recovery, a
  message older than 30 minutes becomes `record_only` rather than a draft,
  so the owner is not flooded with stale drafts.
- **Telegram down:** the decision is already stored, and the push is
  retried.

## Testing

- Each layer has vitest unit tests: the rules, the routing, template selection
  with its cooldown, the validator, and the Telegram callback handling. HTTP is
  faked through injected `fetchImpl`, the pattern the repository already uses.
- Tests build synthetic SQLCipher databases with WeChat's schema, so no test
  needs a live WeChat and no fixture carries a real message. The repository is
  public.
- **First milestone: Jev accuracy on Chinese.** Hand-label 50–100 real
  messages from the owner's groups by intent, run Jev over them and measure its
  accuracy. Any judgement that falls short is moved to the LLM. That is a
  swap behind the `decide()` interface and leaves the rest of the design
  unchanged.

## Privacy

Group messages are sent to the third-party Jev and LLM APIs. The owner has
been told about this trade-off.
