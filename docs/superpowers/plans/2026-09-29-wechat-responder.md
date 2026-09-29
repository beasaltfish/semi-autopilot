# WeChat Responder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Judge each collected WeChat message, decide whether the owner should reply and how, and — in shadow mode — push a draft or an alert to the owner on Telegram, recording the owner's feedback as the calibration dataset. Nothing is ever sent to WeChat.

**Architecture:** Plan 4 of 4, building on the `wechat-responder` package that plan 3 started (`questions.ts`, `config.ts` with `loadJevConfig`, the Jev accuracy eval). A service loop reads unjudged WeChat messages from Postgres, runs each through rules → Jev → routing → (retrieval / template / LLM draft) → validation, and writes one `reply_decisions` row per message. A Telegram bot (long polling, in the same process) pushes cards, records 👍/👎/✏️ feedback, and marks cards expired. Services still meet only in Postgres.

**Tech Stack:** TypeScript (nodenext ESM), Node 24, Postgres + pgvector via Drizzle, `shared/jev` and `shared/llm`, Telegram Bot API over `fetch`, vitest. HTTP is faked through an injected `fetch`, the pattern the workspace uses.

**Spec:** `docs/superpowers/specs/2026-09-28-wechat-assistant-design.md` — read "Judgement Pipeline", "Telegram", and "Error Handling". This plan refines the spec's routing with the owner's decisions (below).

## Global Constraints

- **Nothing is sent to WeChat.** The responder only reads the `messages` table and writes `reply_decisions` and Telegram.
- **One `reply_decisions` row per message**, including messages the rules drop — a wrong drop is invisible unless recorded. A message is "judged" iff it has a `reply_decisions` row; that, not `messages.processed`, is the done-marker (`messages.processed` belongs to other consumers).
- **`ai_probe` and `critical` are never auto-drafted**, in this phase or any later one. They alert only.
- Only the owner's Telegram `chat_id` is honoured; every other update is ignored.
- A Telegram message over 4096 chars is rejected — reuse `shared/notifier`'s truncation for free-text, and keep card bodies well under it.
- The owner's own messages, group nicknames aside, are style samples — never drop them from `messages`; the responder simply does not draft replies *to* them.
- No message content in logs; log ids, routes and counts.
- Comment density and voice match the surrounding code: comments explain *why*.

## Routing (the owner's decisions)

The routing function is pure. Inputs: the rule flags and the Jev judgements. It never waits to see whether someone else answered — that step is dropped.

| Condition (first match wins) | Route | Stage |
|---|---|---|
| Rules drop it (owner's own, system, sticker-only, group not enabled) | `drop` | `rule` |
| `intent = ai_probe` or `critical`, confidence ≥ `INTENT_MIN` | `alert` | `jev` |
| Addressed to the owner **and** intent below `INTENT_MIN` | `alert` | `jev` |
| `intent = question`, **@s a specific other person and not the owner** | `record_only` | `jev` |
| `intent = question` (addressed to owner, or @s no one) | `draft` | `llm` |
| `intent = praise`, addressed to the owner, confidence ≥ `PRAISE_MIN` | `template` | `template` |
| anything else (`chitchat`, low confidence, unaddressed praise) | `record_only` | `jev` |

- **Addressed to the owner** = the message @s the owner, quotes the owner, or Jev's `addressed` is `true` with confidence ≥ `ADDRESSED_MIN`.
- A **draft** either answers in the owner's voice (owner can answer) or proposes @-mentioning a **domain expert** — used only when the question is specialised and history shows a known person has answered such questions before. Retrieval decides which.

## Review Focus

1. **A message that @s the owner but Jev misreads as chitchat.** Being pinged and getting silence is the worst failure. The "addressed + low-confidence → alert" row catches it; test in Task 3.
2. **A draft that reveals the automation.** An `ai_probe` must never produce a draft, even if intent confidence is high on some other axis. Test the never-draft guard in Task 3.
3. **The @ target is the owner, or the message's own sender.** A draft that @s the person who just asked, or the owner, is nonsense. Retrieval must exclude both; test in Task 5.
4. **A duplicate Telegram push after a restart.** The decision is stored before the push; on restart a card already pushed (has `telegram_message_id`) must not be sent again. Test in Task 4/Task 10.
5. **A banned AI-sounding phrase slips through.** "作为一个 AI" / "希望对你有帮助" must trigger one regeneration, then a draft-less card. Test in Task 7.
6. **A Telegram callback from someone who is not the owner.** Honour only the owner's chat id; ignore the rest. Test in Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` | extend: LLM, notify, Telegram, owner identity, thresholds, rate limits |
| `src/rules.ts` | pure: a message row → drop reason or flags |
| `src/routing.ts` | pure: flags + judgements → route + stage + @-need |
| `src/store.ts` | claim unjudged messages with context; write/patch `reply_decisions`; feedback |
| `src/retrieval.ts` | embedding search: owner's similar past replies + expert @ candidate |
| `src/templates.ts` | praise template library + per-person cooldown selection |
| `src/draft.ts` | LLM draft compose + validate (length, banned phrases) + one retry |
| `src/telegram/card.ts` | pure: build draft/alert card payloads; parse callbacks |
| `src/telegram/bot.ts` | send/edit cards, long-poll updates, dispatch callbacks, expiry sweep |
| `src/pipeline.ts` | orchestrate one message through the stages → a decision |
| `src/index.ts` | the service loop + bot |
| `src/questions.ts`, `src/config.ts`, `src/eval.ts` | exist from plan 3 |

---

### Task 1: Extend config

**Files:** Modify `src/config.ts`, `src/config.test.ts` (new); `.env.example`.

**Interfaces:**
- Produces `loadConfig(env?): ResponderConfig` where
  `ResponderConfig = { db: DbConfig; jev: JevConfig; llm: LlmConfig; ownerId: string; ownerNames: string[]; telegram: { botToken: string; chatId: string }; notify: NotifyTarget | null; thresholds: { intentMin: number; praiseMin: number; addressedMin: number }; draftsPerGroupPerHour: number; templateCooldownMinutes: number; cardExpiryMinutes: number; pollSeconds: number }`.
- Keep `loadJevConfig` (plan 3) — `loadConfig` calls it.

- [ ] **Step 1: Write failing tests** for: requires `WECHAT_OWNER_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `OPENROUTER_API_KEY`; parses `WECHAT_OWNER_NAMES` comma list; defaults `INTENT_MIN=0.6`, `PRAISE_MIN=0.7`, `ADDRESSED_MIN=0.6`, `DRAFTS_PER_GROUP_PER_HOUR=4`, `TEMPLATE_COOLDOWN_MINUTES=180`, `CARD_EXPIRY_MINUTES=30`, `RESPONDER_POLL_SECONDS=15`; a threshold outside [0,1] throws.

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  OPENROUTER_API_KEY: 'k',
  WECHAT_OWNER_ID: 'wxid_me',
  TELEGRAM_BOT_TOKEN: 't',
  TELEGRAM_CHAT_ID: 'c',
  LLM_BASE_URL: 'http://localhost:20128/v1',
  LLM_MODEL: 'some-model',
} as NodeJS.ProcessEnv

it('reads owner names and applies threshold defaults', () => {
  const config = loadConfig({ ...base, WECHAT_OWNER_NAMES: '老张, 张老师' })
  expect(config.ownerId).toBe('wxid_me')
  expect(config.ownerNames).toEqual(['老张', '张老师'])
  expect(config.thresholds).toEqual({ intentMin: 0.6, praiseMin: 0.7, addressedMin: 0.6 })
})

it('rejects a threshold outside 0..1', () => {
  expect(() => loadConfig({ ...base, INTENT_MIN: '1.5' })).toThrow('INTENT_MIN')
})
```

- [ ] **Step 2:** Run — FAIL (fields missing).
- [ ] **Step 3: Implement.** Add a `fraction(env, key, fallback)` helper (0..1 inclusive), a `positiveInt`, and a `parseList`. Build `llm` from `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (required) like tweet-generator; `telegram` from the two vars; `notify` from `loadNotifyTarget`. Reuse `loadDbConfig` and `loadJevConfig`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Add all new vars to `.env.example` with one-line comments.
- [ ] **Step 6: Commit** `feat(wechat-responder): responder config`.

---

### Task 2: Rules layer

**Files:** Create `src/rules.ts`, `src/rules.test.ts`.

**Interfaces:**
- Consumes a stored message shape:
  `interface MessageInput { authorId: string; content: string; rawData: { kind?: string; mentions?: string[] } | null; replyToAuthorId: string | null }`
- Produces:
  - `interface RuleFlags { mentionsOwner: boolean; mentionsOther: boolean; quotesOwner: boolean; namesOwner: boolean }`
  - `type RuleOutcome = { drop: 'own' | 'system' | 'sticker' } | { flags: RuleFlags }`
  - `function applyRules(message: MessageInput, owner: { id: string; names: string[] }): RuleOutcome`

- [ ] **Step 1: Write failing tests:**

```ts
import { describe, expect, it } from 'vitest'
import { applyRules } from './rules.js'

const owner = { id: 'wxid_me', names: ['老张'] }
const base = { authorId: 'wxid_a', content: '你好', rawData: { kind: 'text', mentions: [] as string[] }, replyToAuthorId: null }

it("drops the owner's own message", () => {
  expect(applyRules({ ...base, authorId: 'wxid_me' }, owner)).toEqual({ drop: 'own' })
})

it('flags an @ of the owner', () => {
  const out = applyRules({ ...base, rawData: { mentions: ['wxid_me'] } }, owner)
  expect(out).toEqual({ flags: { mentionsOwner: true, mentionsOther: false, quotesOwner: false, namesOwner: false } })
})

it('flags an @ of someone else as mentionsOther', () => {
  const out = applyRules({ ...base, rawData: { mentions: ['wxid_b'] } }, owner)
  expect(out).toMatchObject({ flags: { mentionsOwner: false, mentionsOther: true } })
})

it('flags a reply that quotes the owner', () => {
  const out = applyRules({ ...base, replyToAuthorId: 'wxid_me' }, owner)
  expect(out).toMatchObject({ flags: { quotesOwner: true } })
})

it("flags the owner's name in the text", () => {
  const out = applyRules({ ...base, content: '这个问题问老张吧' }, owner)
  expect(out).toMatchObject({ flags: { namesOwner: true } })
})
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.** Own = `authorId === owner.id`. `kind === 'system'`/`'sticker'` → drop (v1 collector stores only text, but the shape is future-proofed). `mentions` split into owner vs other. `quotesOwner = replyToAuthorId === owner.id`. `namesOwner = owner.names.some(n => content.includes(n))`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(wechat-responder): rule flags and hard drops`.

---

### Task 3: Routing

**Files:** Create `src/routing.ts`, `src/routing.test.ts`.

**Interfaces:**
- Consumes `RuleFlags` (Task 2) and `Record<string, JevJudgement>` (from `shared/jev`), plus thresholds.
- Produces:
  - `type Route = 'drop' | 'alert' | 'template' | 'draft' | 'record_only'`
  - `type Stage = 'rule' | 'jev' | 'template' | 'llm'`
  - `interface Decision { route: Route; stage: Stage; needsHistory: boolean }`
  - `function route(flags: RuleFlags, jev: Record<string, JevJudgement>, thresholds: { intentMin: number; praiseMin: number; addressedMin: number }): Decision`
- `route` is only called when the rules did not drop; a drop is decided by the caller (stage `rule`).

- [ ] **Step 1: Write failing tests** — one per table row plus the review-focus cases:

```ts
import { describe, expect, it } from 'vitest'
import { route } from './routing.js'

const t = { intentMin: 0.6, praiseMin: 0.7, addressedMin: 0.6 }
const noFlags = { mentionsOwner: false, mentionsOther: false, quotesOwner: false, namesOwner: false }
const j = (intent: string, c: number, extra = {}) => ({ intent: { label: intent, confidence: c }, addressed: { label: 'false', confidence: 0.9 }, needs_history: { label: 'false', confidence: 0.9 }, ...extra })

it('alerts on an ai_probe and never drafts', () => {
  expect(route(noFlags, j('ai_probe', 0.8), t)).toMatchObject({ route: 'alert', stage: 'jev' })
})
it('alerts on a critical message', () => {
  expect(route(noFlags, j('critical', 0.9), t).route).toBe('alert')
})
it('alerts when addressed to the owner but the intent is uncertain', () => {
  expect(route({ ...noFlags, mentionsOwner: true }, j('chitchat', 0.3), t).route).toBe('alert')
})
it('records a question that @s someone else', () => {
  expect(route({ ...noFlags, mentionsOther: true }, j('question', 0.9), t).route).toBe('record_only')
})
it('drafts a question addressed to the owner', () => {
  const d = route({ ...noFlags, mentionsOwner: true }, j('question', 0.9, { needs_history: { label: 'true', confidence: 0.8 } }), t)
  expect(d).toMatchObject({ route: 'draft', stage: 'llm', needsHistory: true })
})
it('drafts a question that @s no one', () => {
  expect(route(noFlags, j('question', 0.9), t).route).toBe('draft')
})
it('templates confident praise addressed to the owner', () => {
  expect(route({ ...noFlags, mentionsOwner: true }, j('praise', 0.9), t).route).toBe('template')
})
it('records chitchat', () => {
  expect(route(noFlags, j('chitchat', 0.9), t).route).toBe('record_only')
})
it('records a low-confidence intent that is not addressed', () => {
  expect(route(noFlags, j('question', 0.4), t).route).toBe('record_only')
})
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** exactly the table, first-match-wins, with `addressedToOwner = flags.mentionsOwner || flags.quotesOwner || (jev.addressed.label === 'true' && jev.addressed.confidence >= thresholds.addressedMin)`. Guard: `ai_probe`/`critical` return `alert` before any draft branch. `needsHistory = jev.needs_history.label === 'true'`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(wechat-responder): routing`.

---

### Task 4: Store — claim, decide, feedback

**Files:** Create `src/store.ts`, `src/store.test.ts` (Postgres-backed).

**Interfaces:**
- `interface Candidate { id: number; channelId: string; authorId: string; authorName: string; content: string; timestamp: Date; embedding: number[] | null; rawData: {...} | null; replyToAuthorId: string | null }`
- `class ResponderStore`:
  - `claimUnjudged(limit: number): Promise<Candidate[]>` — WeChat messages with no `reply_decisions` row, oldest first. `replyToAuthorId` via a self-join on `messages` by `replyToMessageId`.
  - `recentContext(channelId: string, before: Date, n: number): Promise<{ authorName: string; content: string }[]>` — the last `n` messages before this one, for Jev state and the draft prompt.
  - `recordDecision(row: NewReplyDecision): Promise<number>` — insert one `reply_decisions` row (idempotent on `message_id`), return its id.
  - `attachTelegramId(decisionId: number, telegramMessageId: number): Promise<void>`
  - `recordFeedback(telegramMessageId: number, feedback: ReplyFeedback, editedText?: string): Promise<void>`
  - `expireStale(olderThan: Date): Promise<{ id: number; telegramMessageId: number }[]>` — pushed, unanswered, past expiry; set `expired_at`.
  - `draftsInGroupSince(channelId: string, since: Date): Promise<number>` — for the rate limit (counts `route in ('draft','template')`).

Test each against a live DB with a `test-resp-%` channel prefix and an id range disjoint from the other Postgres test files. Cover: a message with a decision is not re-claimed (Review Focus 4); feedback lands by `telegram_message_id`; `expireStale` skips ones already answered.

- [ ] Steps: failing tests → run → implement with Drizzle (`NOT EXISTS` sub-select on `replyDecisions`) → run → **Commit** `feat(wechat-responder): responder store`.

---

### Task 5: Retrieval — owner's replies and the expert

**Files:** Create `src/retrieval.ts`, `src/retrieval.test.ts` (Postgres + pgvector).

**Interfaces:**
- `class Retrieval`:
  - `similarOwnerReplies(embedding: number[], ownerId: string, limit: number): Promise<{ content: string }[]>` — the owner's own past messages nearest this one, for few-shot voice.
  - `expertFor(embedding: number[], channelId: string, exclude: string[], limit: number): Promise<{ authorId: string; authorName: string; score: number } | null>` — among messages nearest this one in the group, the non-excluded author who recurs most; `exclude` holds the owner and the asker (Review Focus 3). Returns null when no one stands out.
- Uses pgvector `<=>` (cosine) ordering. The query message's embedding is the input; the caller computes it (Task 10) if the row's is null.

Tests: seed messages with hand-set embeddings (unit vectors) so nearest-neighbour order is deterministic; assert the owner's replies come back, the asker and owner are excluded from `expertFor`, and a diffuse set yields null.

- [ ] Steps: failing tests → run → implement → run → **Commit** `feat(wechat-responder): embedding retrieval for voice and expert`.

---

### Task 6: Templates

**Files:** Create `src/templates.ts`, `src/templates.test.ts`; `templates.json` (a small starter library, git-tracked, no personal data).

**Interfaces:**
- `function pickTemplate(templates: string[], recentlyUsed: Set<string>, rng: () => number): string | null` — a template not used for this person within the cooldown; null if all are on cooldown.
- The cooldown set comes from the store: `recordDecision` writes the chosen template into `draft`, and a `templatesUsedFor(authorId, since)` store method returns them. (Add that method to Task 4 or here.)

Tests (pure): avoids a recently-used template; returns null when all are used; deterministic with a seeded rng (`shared/rng`).

- [ ] Steps → **Commit** `feat(wechat-responder): praise templates with per-person cooldown`.

---

### Task 7: LLM draft and validation

**Files:** Create `src/draft.ts`, `src/draft.test.ts`; `banned-phrases.json`.

**Interfaces:**
- `interface DraftInput { message: string; context: { authorName: string; content: string }[]; retrieved: string[]; mentionName: string | null; styleRules: string[]; fewShot: string[] }`
- `function buildPrompt(input: DraftInput): ChatMessage[]` — pure; a system message with the style rules and the shadow-mode instruction ("reply as the owner would: brief, encouraging or answering; no AI throat-clearing"), a user message with the context, the message, the retrieved history and the @ target.
- `function validate(reply: string, opts: { maxChars: number; banned: string[] }): { ok: true } | { ok: false; reason: string }` — pure; rejects over-length or a banned phrase.
- `async function draftReply(llm: Pick<LlmClient,'chat'>, input: DraftInput, opts): Promise<{ text: string } | { failed: true }>` — one regeneration on validation failure, then give up (a draft-less card).

Tests (fake `llm.chat`): a clean reply passes; a banned phrase ("作为一个 AI", "希望对你有帮助") triggers exactly one retry (Review Focus 5); a second failure returns `{ failed: true }`; `buildPrompt` includes the @ name and the style rules.

- [ ] Steps → **Commit** `feat(wechat-responder): llm draft with validation and one retry`.

---

### Task 8: Telegram cards (pure build + parse)

**Files:** Create `src/telegram/card.ts`, `src/telegram/card.test.ts`.

**Interfaces:**
- `function draftCard(d: { group: string; sender: string; message: string; jev: Record<string, JevJudgement>; mentionName: string | null; draft: string | null }): { text: string; reply_markup: object }` — buttons 👍/👎/✏️; a draft-less card still shows the message and judgements.
- `function alertCard(d: { group: string; sender: string; message: string; reason: 'ai_probe' | 'critical'; jev }): { text: string; reply_markup: object }` — single "知道了" button.
- `type Callback = { action: 'approve' | 'reject' | 'edit' | 'ack'; decisionId: number }`
- `function encodeCallback(cb: Callback): string` / `function parseCallback(data: string): Callback | null` — callback_data is ≤ 64 bytes, so encode compactly (e.g. `a:123`).

Tests (pure): the draft card carries three buttons and the judgements line (`question 0.91`); the alert card carries one button; `encode`/`parse` round-trip and reject junk.

- [ ] Steps → **Commit** `feat(wechat-responder): telegram card payloads`.

---

### Task 9: Telegram bot (IO)

**Files:** Create `src/telegram/bot.ts`, `src/telegram/bot.test.ts`.

**Interfaces:**
- `class TelegramBot` (constructed with `{ botToken; chatId }` and an injected `fetch`):
  - `send(card): Promise<number>` — returns the `message_id`.
  - `editExpired(messageId: number, text: string): Promise<void>` — strips the buttons.
  - `poll(offset: number): Promise<{ nextOffset: number; callbacks: { data: string; messageId: number; chatId: string; text?: string }[] }>` — `getUpdates`; drop any update whose chat is not the owner (Review Focus 6).
  - `answerCallback(id: string): Promise<void>` — clears the button spinner.
  - The ✏️ flow: a callback sets a pending-edit state keyed by message; the next text message from the owner is the edited draft. Keep the pending state in the bot; the loop (Task 10) persists it via `recordFeedback(..., 'edit', text)`.

Tests (fake `fetch`): `send` posts to `sendMessage` and returns the id; `poll` ignores a non-owner chat and returns owner callbacks; a text reply after an ✏️ callback is surfaced as an edit.

- [ ] Steps → **Commit** `feat(wechat-responder): telegram bot over long polling`.

---

### Task 10: Pipeline and service loop

**Files:** Create `src/pipeline.ts`, `src/pipeline.test.ts`, `src/index.ts`; `styleRules` in config or a git-tracked `style-rules.json`.

**Interfaces:**
- `async function judge(candidate, deps): Promise<NewReplyDecision>` — the orchestration: `applyRules` → if drop, a `drop`/`rule` row; else build Jev state `{ message, recent, ownerNames, addressedFlags }`, call `jev.decide(state, judgementQuestions)`, `route(...)`; then per route: `alert` (no draft), `template` (`pickTemplate`), `draft` (embed the message if needed → `similarOwnerReplies` + `expertFor` when specialised → `draftReply`), `record_only`. Returns the row to store, including `jev`, `retrievedIds`, `mentionAuthorId`, `draft`.
- The loop in `index.ts`: every `pollSeconds`, `claimUnjudged`, `judge` each, `recordDecision`, and for `alert`/`draft`/`template` within the per-group hourly rate limit push a card and `attachTelegramId`. Separately, poll Telegram for callbacks → `recordFeedback`; and each pass `expireStale` → `editExpired`. On Jev/LLM failure, alert once (reuse `shared/retry` policy + a `FailureWatch`-style latch) and leave the message unjudged to retry; a message older than `CARD_EXPIRY_MINUTES` becomes `record_only` rather than a stale draft.

Tests: `judge` with fakes (fake Jev, fake LLM, in-memory retrieval) for each route — a question addressed to the owner yields a `draft` row with a draft; an `ai_probe` yields an `alert` row with no draft (Review Focus 2); a decision already carrying a `telegram_message_id` is not re-pushed (Review Focus 4, tested at the loop's push guard).

- [ ] Steps → **Commit** `feat(wechat-responder): judgement pipeline and service loop`.

---

### Task 11: Docs and wiring

**Files:** `.env.example` (complete), `README.md`, root `README.md` (add the service).

- [ ] Document the Telegram bot setup (BotFather token, obtaining the owner chat id), the shadow-mode behaviour, the style-rules and templates files, and how feedback becomes the calibration dataset. **Commit** `docs(wechat-responder): how to run the responder`.

## Self-Review

- **Spec coverage:** rules (Task 2), Jev call (Task 10), routing incl. the owner's refinements (Task 3), retrieval for voice + expert (Task 5), templates + cooldown (Task 6), LLM draft + validate + retry (Task 7), rate limit (Task 10), Telegram draft/alert/expiry/feedback (Tasks 8–10), reply_decisions as the dataset (Task 4). The "wait to see if answered" step is intentionally omitted per the owner.
- **Review Focus** all mapped to tasks above.
- **Deferred to a later phase (not this plan):** sending to WeChat; automatic sending; an expert-profile table (expertise stays inferred from history).
