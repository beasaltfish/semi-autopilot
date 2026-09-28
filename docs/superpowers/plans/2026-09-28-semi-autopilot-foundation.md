# Semi-Autopilot Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the workspace for the WeChat assistant. That means renaming the database and the repo to `semi-autopilot`, adding the WeChat columns and tables to the schema, moving the LLM client into `shared` (with embeddings added), and teaching the notifier to send to Telegram.

**Architecture:** This is plan 1 of 4. Plan 2 is `wechat-collector`, plan 3 is the Jev client with its accuracy check, and plan 4 is `wechat-responder`. This plan adds no service. It changes only `shared`, the schema and migrations, the tweet-generator imports, and the naming. When it is done, every existing service still passes its tests against a freshly built database.

**Tech Stack:** TypeScript (nodenext ESM), pnpm workspaces, Drizzle ORM + drizzle-kit, Postgres 15 + pgvector (Docker), vitest.

**Spec:** `docs/superpowers/specs/2026-09-28-wechat-assistant-design.md`

## Global Constraints

- New name: `semi-autopilot` for the repo, the directory and the Docker project, and `semi_autopilot` for the database.
- **The database is rebuilt from scratch and the existing data is discarded. Confirm with the owner immediately before running any destructive command.**
- **Renaming the GitHub repository is outward-facing. Confirm with the owner immediately before running it.**
- Modules move into `shared` as subpath exports (`shared/llm`, `shared/retry`), not as new packages.
- Embedding dimension: 1536, which matches `messages.embedding`.
- `messages.source` gains `'wechat'`. So do `channels.source` and `threads.source`.
- `channels` gains `enabled boolean NOT NULL DEFAULT false`, which is the group allowlist switch.
- The existing Discord notifications keep working without any change at their call sites.
- Comment density and voice match the surrounding code: comments explain *why*, as in `shared/src/notifier.ts`.

## Review Focus

1. **A Telegram message over 4096 characters.** Telegram rejects it. A notification carrying a long stack trace should arrive truncated, not vanish. Test in Task 5.
2. **An embedding of the wrong dimension.** Switching the embedding model can silently change the dimension. `embed()` must throw `LlmError` rather than return a vector the column will reject later, far from the cause. Test in Task 4.
3. **Embeddings returned out of order.** The OpenAI-compatible API tags each vector with its `index`. Results must line up with the inputs even when the server reorders them. Test in Task 4.
4. **The existing string-webhook callers.** `notifyFailure(config.discordWebhookUrl, ...)` in x-poster and tweet-generator must behave exactly as before. Test in Task 5.
5. **An orphaned Docker volume after the directory rename.** The Compose project name defaults to the directory name, so renaming the directory would silently point at a new, empty volume. Pin `name:` in `docker-compose.yml`. Verified in Task 1.

---

## File Structure

| File | Responsibility |
|---|---|
| `docker-compose.yml` | pinned project name, new container and DB names |
| `shared/src/db.ts` | default DB name |
| `shared/src/schema.ts` | `SOURCES`, `channels.enabled`, `MessageRawData`, `replyDecisions` |
| `shared/src/types.ts` | `ReplyDecision` row type |
| `shared/src/retry.ts` | moved from tweet-generator, unchanged |
| `shared/src/llm.ts` | moved `LlmClient` + `extractJson` + errors, plus `embed()` |
| `shared/src/notifier.ts` | `NotifyTarget`, Telegram channel, `loadNotifyTarget()` |
| `db/migrations/0002_*.sql` | generated |

---

### Task 1: Rename the database and rebuild it

**Files:**
- Modify: `docker-compose.yml`
- Modify: `shared/src/db.ts:33`
- Modify: `shared/src/db.test.ts:28,72,90`
- Modify: `tweet-generator/src/store.test.ts:8`
- Modify: `x-poster/src/queue/tweet-queue.test.ts:8`
- Modify: `ai-assistant/.env.example:4`, `discord-monitor/.env.example:4`, `tweet-generator/.env.example:4`, `x-poster/.env.example:4`
- Modify: `README.md` (title, clone path, `DB_NAME` default, project-structure root)

**Interfaces:**
- Produces: a running Postgres at `localhost:5432`, database `semi_autopilot`, user `app_user`, with all migrations applied.

- [ ] **Step 1: Update the default-name test first**

In `shared/src/db.test.ts`, change the three occurrences of `database: 'multi_tab_listening',` to `database: 'semi_autopilot',`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter shared exec vitest run src/db.test.ts`
Expected: FAIL. The defaults test receives `'multi_tab_listening'`.

- [ ] **Step 3: Change the default**

In `shared/src/db.ts`:

```ts
    database: env.DB_NAME ?? 'semi_autopilot',
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter shared exec vitest run src/db.test.ts`
Expected: PASS.

- [ ] **Step 5: Tear down the old database (DESTRUCTIVE: confirm first)**

Ask the owner: "This deletes the `multi-tab-postgres` container and its volume, which hold all Discord messages and the tweet queue. Proceed?" Continue only after an explicit yes.

Run this while `docker-compose.yml` is still the old one, so that Compose finds the old volume:

```bash
docker compose down -v
```

Expected: the container `multi-tab-postgres` and the volume `multi-tab-listening_postgres_data` are removed.

- [ ] **Step 6: Rename in Compose and pin the project name**

Replace the head of `docker-compose.yml` up to `environment:` and the healthcheck test so that they read:

```yaml
# Pinned, because Compose otherwise names the project — and so the volume —
# after the directory. Renaming the checkout would then silently start a new,
# empty database next to the old one.
name: semi-autopilot

services:
  postgres:
    image: pgvector/pgvector:pg15
    container_name: semi-autopilot-postgres
    restart: unless-stopped
    environment:
      POSTGRES_DB: semi_autopilot
```

```yaml
      test: ["CMD-SHELL", "pg_isready -U app_user -d semi_autopilot"]
```

- [ ] **Step 7: Rename everything else**

- Change `database: 'multi_tab_listening',` to `database: 'semi_autopilot',` in `tweet-generator/src/store.test.ts` and `x-poster/src/queue/tweet-queue.test.ts`.
- Change `DB_NAME=multi_tab_listening` to `DB_NAME=semi_autopilot` in the four `.env.example` files.
- Also check the untracked `.env` files: `ls .env */.env`. For each one that sets `DB_NAME=multi_tab_listening`, change it the same way. They are git-ignored, so git grep misses them.
- In `README.md`, make the title `# semi-autopilot`, the clone lines `.../semi-autopilot.git` and `cd semi-autopilot`, the `DB_NAME` default `` `semi_autopilot` ``, and the tree root `semi-autopilot/`.

Confirm nothing is left:

```bash
git grep -n "multi_tab_listening\|multi-tab-postgres" -- . ':!docs/' ':!pnpm-lock.yaml'
```

Expected: no output.

- [ ] **Step 8: Build the new database**

```bash
pnpm db:up
docker volume ls | grep semi-autopilot
```

Expected: the migrations apply cleanly, and the volume `semi-autopilot_postgres_data` exists.

- [ ] **Step 9: Run the database-backed suites**

```bash
pnpm --filter shared test && pnpm --filter tweet-generator test && pnpm --filter x-poster test
```

Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
git add -A docker-compose.yml shared/src/db.ts shared/src/db.test.ts tweet-generator/src/store.test.ts x-poster/src/queue/tweet-queue.test.ts '*.env.example' README.md
git commit -m "chore: rename the database to semi_autopilot"
```

---

### Task 2: Schema for WeChat

**Files:**
- Modify: `shared/src/schema.ts`
- Modify: `shared/src/types.ts`
- Modify: `shared/src/schema.test-d.ts`
- Create: `db/migrations/0002_*.sql` (generated)

**Interfaces:**
- Consumes: `EMBEDDING_DIMENSIONS` does not exist yet, so the column keeps its literal `1536` in this task. Task 4 swaps it for the constant.
- Produces:
  - `export const SOURCES = ['discord', 'wechat'] as const` and `export type Source = (typeof SOURCES)[number]`
  - `export interface MessageRawData` (replaces `DiscordRawData`)
  - `channels.enabled: boolean` (NOT NULL, default false)
  - `export const replyDecisions` table
  - `export type ReplyDecision`, `ReplyStage`, `ReplyRoute`, `ReplyFeedback`, `JevJudgement` from `shared`

- [ ] **Step 1: Write the failing type assertions**

Append this to `shared/src/schema.test-d.ts`, before `export type _Assertions`:

```ts
import type { channels } from './schema.js'
import type { ReplyDecision, ReplyFeedback, ReplyRoute, Source } from './types.js'

// A source added to SOURCES without a place to go should not compile.
const _sources: Record<Source, true> = { discord: true, wechat: true }

// The allowlist switch is NOT NULL, so readers never have to guess.
const _enabled: boolean = ({} as typeof channels.$inferSelect).enabled

const _decisionHasWhatTheResponderWrites: Pick<
  ReplyDecision,
  | 'messageId'
  | 'stage'
  | 'route'
  | 'jev'
  | 'retrievedIds'
  | 'mentionAuthorId'
  | 'draft'
  | 'telegramMessageId'
  | 'feedback'
  | 'editedText'
  | 'expiredAt'
  | 'feedbackAt'
> = {} as ReplyDecision

const _routes: Record<ReplyRoute, true> = {
  drop: true,
  alert: true,
  template: true,
  draft: true,
  record_only: true,
}

const _feedback: Record<ReplyFeedback, true> = {
  approve: true,
  reject: true,
  edit: true,
  ack: true,
}
```

Then extend the tuple:

```ts
export type _Assertions = [
  typeof _tweetHasWhatTheQueueReads,
  typeof _messageHasWhatTheAssistantReads,
  typeof _archetypes,
  typeof _sources,
  typeof _enabled,
  typeof _decisionHasWhatTheResponderWrites,
  typeof _routes,
  typeof _feedback,
]
```

Move the two new `import type` lines up beside the existing import at the top of the file.

- [ ] **Step 2: Run the typecheck and watch it fail**

Run: `pnpm --filter shared typecheck`
Expected: FAIL. `ReplyDecision`, `Source` and the rest are not exported, and `enabled` does not exist.

- [ ] **Step 3: Add `SOURCES` and use it in all three tables**

In `shared/src/schema.ts`, directly after the imports:

```ts
/**
 * Every message source the system supports. One list, because `channels`,
 * `messages` and `threads` each carry the column and a source that exists in
 * one table but not another is a join that silently drops rows.
 */
export const SOURCES = ['discord', 'wechat'] as const
```

Then, in each of `channels`, `messages` and `threads`, replace

```ts
source: varchar('source', { length: 20, enum: ['discord'] }).notNull(),
```

with

```ts
source: varchar('source', { length: 20, enum: SOURCES }).notNull(),
```

- [ ] **Step 4: Widen the raw-data type**

Replace the `DiscordRawData` interface and its doc comment with:

```ts
/**
 * The source's own message payload, stored whole in `messages.raw_data`.
 *
 * Only fields something actually reads are declared, each owned by one
 * source. The index signature keeps the rest addressable without pretending
 * we know its shape, which we do not: it is whatever the source handed over
 * that day.
 */
export interface MessageRawData {
  /** Discord: the bot flag the filter checks. */
  author?: { bot?: boolean }
  /**
   * WeChat: the wxids the message @-mentions, normalised by the collector
   * from whatever chatlog names the field, so readers never depend on it.
   */
  mentions?: string[]
  [key: string]: unknown
}
```

and change the column to `rawData: jsonb('raw_data').$type<MessageRawData>(),`.

- [ ] **Step 5: Add the allowlist switch to `channels`**

Add this after `spaceName` in `channels`:

```ts
    /**
     * Whether the services act on this channel at all. Off by default: a
     * group the owner has not chosen is ignored, not merely deprioritised.
     */
    enabled: boolean('enabled').notNull().default(false),
```

- [ ] **Step 6: Add `reply_decisions`**

Append this to `shared/src/schema.ts`:

```ts
/** One judgement a `jev` entry records: which label won, and how sure. */
export interface JevJudgement {
  label: string
  confidence: number
}

/**
 * One row per message the wechat-responder judged — what it decided, what it
 * would have said, and what the owner said about that.
 *
 * This is the calibration dataset. Phase one sends nothing; the rows are the
 * product. That is why a message dropped by the rules still gets a row: a
 * wrong drop is invisible unless it was written down.
 */
export const replyDecisions = pgTable(
  'reply_decisions',
  {
    id: serial('id').primaryKey(),
    messageId: integer('message_id')
      .notNull()
      .unique()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** The furthest layer the message reached. */
    stage: varchar('stage', {
      length: 20,
      enum: ['rule', 'jev', 'template', 'llm'],
    }).notNull(),
    route: varchar('route', {
      length: 20,
      enum: ['drop', 'alert', 'template', 'draft', 'record_only'],
    }).notNull(),
    /** Keyed by judgement name — `intent`, `addressed`, `needs_history`. */
    jev: jsonb('jev').$type<Record<string, JevJudgement>>(),
    retrievedIds: integer('retrieved_ids').array(),
    mentionAuthorId: varchar('mention_author_id', { length: 255 }),
    draft: text('draft'),
    telegramMessageId: integer('telegram_message_id'),
    feedback: varchar('feedback', {
      length: 10,
      enum: ['approve', 'reject', 'edit', 'ack'],
    }),
    editedText: text('edited_text'),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    feedbackAt: timestamp('feedback_at', { withTimezone: true }),
  },
  (table) => [
    // The expiry sweep: cards pushed, unanswered, not yet marked.
    index('idx_reply_decisions_pending').on(
      table.feedback,
      table.expiredAt,
      table.createdAt,
    ),
  ],
)
```

- [ ] **Step 7: Export the row types**

In `shared/src/types.ts`, change the import line to

```ts
import type { messages, replyDecisions, SOURCES, tweets } from './schema.js'
```

and append:

```ts
/** A message source: `discord`, `wechat`. */
export type Source = (typeof SOURCES)[number]

/** One row of `reply_decisions`. */
export type ReplyDecision = typeof replyDecisions.$inferSelect

/** The furthest layer of the pipeline a message reached. */
export type ReplyStage = ReplyDecision['stage']

/** What the responder decided to do with a message. */
export type ReplyRoute = ReplyDecision['route']

/** The owner's answer on Telegram, or null while there is none. */
export type ReplyFeedback = NonNullable<ReplyDecision['feedback']>

export type { JevJudgement } from './schema.js'
```

Also change the `DiscordMessage` doc comment's mention of "the observer" only if it now reads wrong. The type itself is unchanged.

- [ ] **Step 8: Run the typecheck and watch it pass**

Run: `pnpm --filter shared typecheck`
Expected: PASS.

- [ ] **Step 9: Generate and apply the migration**

```bash
pnpm db:generate
cat db/migrations/0002_*.sql
pnpm db:migrate
```

Expected: the SQL adds `channels.enabled`, creates `reply_decisions` with its FK, unique constraint and index, and applies without error. The enum widening is TypeScript-only, because drizzle `varchar` enums emit no CHECK constraint, so no `ALTER` for it is expected.

- [ ] **Step 10: Run every suite that touches the schema**

```bash
pnpm --filter shared test && pnpm --filter discord-monitor test && pnpm --filter ai-assistant test && pnpm --filter tweet-generator test && pnpm --filter x-poster test
```

Expected: all PASS.

- [ ] **Step 11: Commit**

```bash
git add shared/src/schema.ts shared/src/types.ts shared/src/schema.test-d.ts db/migrations
git commit -m "feat(shared): schema for WeChat sources and reply decisions"
```

---

### Task 3: Move the LLM client and retry policy into `shared`

A pure move. No behaviour changes, and every existing test must keep passing unedited apart from its import paths.

**Files:**
- Move: `tweet-generator/src/retry.ts` → `shared/src/retry.ts`
- Move: `tweet-generator/src/llm/client.ts` → `shared/src/llm.ts`
- Move: `tweet-generator/src/llm/client.test.ts` → `shared/src/llm.test.ts`
- Modify: `shared/package.json` (exports)
- Modify: `tweet-generator/src/config.ts:40-45`
- Modify: `tweet-generator/src/index.ts:10,20-25`
- Modify: `tweet-generator/src/llm/pipeline.ts:4-9`
- Modify: `tweet-generator/src/llm/pipeline.test.ts:3`
- Modify: `tweet-generator/src/retry.test.ts:2-12`
- Modify: `tweet-generator/src/sources/agentlens.ts:2`

**Interfaces:**
- Produces, from `shared/llm`: `LlmConfig`, `LlmClient`, `LlmError`, `LlmUnavailableError`, `ChatMessage`, `extractJson`.
- Produces, from `shared/retry`: `RetryPolicy`, `FAST_RETRY_DELAYS_MS`, `policyForStatus`, `fastRetryDelayMs`, `shouldAlert`, `parseRetryAfterMs`, `retryAfterMsOf`, `retryPolicyOf`, `retryAfterMsOfError`. The names are unchanged from the tweet-generator originals.

- [ ] **Step 1: Move the files with history**

```bash
git mv tweet-generator/src/retry.ts shared/src/retry.ts
git mv tweet-generator/src/llm/client.ts shared/src/llm.ts
git mv tweet-generator/src/llm/client.test.ts shared/src/llm.test.ts
```

`tweet-generator/src/retry.test.ts` stays where it is, because it also exercises `AgentLensError`, which belongs to tweet-generator.

- [ ] **Step 2: Watch everything fail to resolve**

Run: `pnpm --filter shared typecheck; pnpm --filter tweet-generator exec tsc --noEmit`
Expected: FAIL, with unresolved `../config.js`, `../retry.js`, `./client.js` and `./retry.js`.

- [ ] **Step 3: Make `shared/src/llm.ts` self-contained**

Replace its first two lines:

```ts
import type { LlmConfig } from '../config.js'
import { policyForStatus, retryAfterMsOf, type RetryPolicy } from '../retry.js'
```

with:

```ts
import { policyForStatus, retryAfterMsOf, type RetryPolicy } from './retry.js'

/** Where the OpenAI-compatible endpoint is and which model to pin. */
export interface LlmConfig {
  baseUrl: string
  apiKey: string | null
  model: string
  timeoutMs: number
}
```

In `shared/src/llm.test.ts`, replace

```ts
import { extractJson, LlmClient, LlmError } from './client.js'
import type { LlmConfig } from '../config.js'
```

with

```ts
import { extractJson, LlmClient, LlmError, type LlmConfig } from './llm.js'
```

- [ ] **Step 4: Export the new subpaths**

In `shared/package.json` `exports`, add:

```json
    "./llm": "./src/llm.ts",
    "./retry": "./src/retry.ts",
```

- [ ] **Step 5: Point tweet-generator at `shared`**

- `tweet-generator/src/config.ts`: delete the `LlmConfig` interface (lines 40–45) and add `import type { LlmConfig } from 'shared/llm'` to the imports. `GeneratorConfig.llm: LlmConfig` stays as it is.
- `tweet-generator/src/index.ts`: `import { LlmClient } from 'shared/llm'`, and change the `from './retry.js'` block to `from 'shared/retry'`.
- `tweet-generator/src/llm/pipeline.ts`: change `from './client.js'` to `from 'shared/llm'`.
- `tweet-generator/src/llm/pipeline.test.ts`: change `from './client.js'` to `from 'shared/llm'`.
- `tweet-generator/src/retry.test.ts`: change `from './llm/client.js'` to `from 'shared/llm'`, and `from './retry.js'` to `from 'shared/retry'`.
- `tweet-generator/src/sources/agentlens.ts`: change `from '../retry.js'` to `from 'shared/retry'`.

Then fix the one comment in `shared/src/retry.ts` that is no longer true. The `retryAfterMsOf` doc says "Both clients", so change it to "Every client".

- [ ] **Step 6: Run both suites and watch them pass**

```bash
pnpm --filter shared typecheck && pnpm --filter shared test
pnpm --filter tweet-generator exec tsc --noEmit && pnpm --filter tweet-generator test
```

Expected: all PASS, with the same number of tests as before the move (count with `git stash` if in doubt).

- [ ] **Step 7: Commit**

```bash
git add -A shared tweet-generator
git commit -m "refactor: move the LLM client and retry policy into shared"
```

---

### Task 4: `embed()` on the LLM client

**Files:**
- Modify: `shared/src/llm.ts`
- Modify: `shared/src/llm.test.ts`
- Modify: `shared/src/schema.ts` (define the constant)

**Interfaces:**
- Consumes: `LlmClient`, `LlmConfig`, `LlmError`, `LlmUnavailableError` from Task 3.
- Produces:
  - `export const EMBEDDING_DIMENSIONS = 1536`, defined in `shared/src/schema.ts` beside the column it sizes and re-exported from `shared/llm`
  - `LlmConfig.embeddingModel?: string`, an optional field, so tweet-generator's config is untouched
  - `LlmClient.embed(input: string[]): Promise<number[][]>`, which returns one vector per input, in input order

- [ ] **Step 1: Write the failing tests**

Append this to `shared/src/llm.test.ts`. It needs `EMBEDDING_DIMENSIONS` and `LlmUnavailableError` added to the import from `./llm.js`:

```ts
describe('LlmClient.embed', () => {
  const embedConfig: LlmConfig = { ...config, embeddingModel: 'embed-model' }
  const vec = (fill: number) =>
    Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill)

  function stubEmbed(data: unknown, status = 200) {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ data }),
    })
  }

  it('posts every input to /embeddings with the embedding model', async () => {
    const fetchImpl = stubEmbed([
      { index: 0, embedding: vec(0.1) },
      { index: 1, embedding: vec(0.2) },
    ])
    const client = new LlmClient(embedConfig, fetchImpl as never)

    const vectors = await client.embed(['a', 'b'])

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://localhost:20128/v1/embeddings')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toEqual({ model: 'embed-model', input: ['a', 'b'] })
    expect(vectors).toEqual([vec(0.1), vec(0.2)])
  })

  it('returns vectors in input order when the server reorders them', async () => {
    const fetchImpl = stubEmbed([
      { index: 1, embedding: vec(0.2) },
      { index: 0, embedding: vec(0.1) },
    ])
    const vectors = await new LlmClient(embedConfig, fetchImpl as never).embed(
      ['a', 'b'],
    )
    expect(vectors).toEqual([vec(0.1), vec(0.2)])
  })

  it('rejects a vector of the wrong dimension', async () => {
    // A model swap can change the dimension silently. Better to fail here
    // than at an INSERT three calls away from the cause.
    const fetchImpl = stubEmbed([{ index: 0, embedding: [0.1, 0.2] }])
    await expect(
      new LlmClient(embedConfig, fetchImpl as never).embed(['a']),
    ).rejects.toThrow(LlmError)
  })

  it('rejects a reply that is missing a vector', async () => {
    const fetchImpl = stubEmbed([{ index: 0, embedding: vec(0.1) }])
    await expect(
      new LlmClient(embedConfig, fetchImpl as never).embed(['a', 'b']),
    ).rejects.toThrow(LlmError)
  })

  it('makes no request for an empty input', async () => {
    const fetchImpl = vi.fn()
    expect(
      await new LlmClient(embedConfig, fetchImpl as never).embed([]),
    ).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses to guess a model when none is configured', async () => {
    const fetchImpl = vi.fn()
    await expect(
      new LlmClient(config, fetchImpl as never).embed(['a']),
    ).rejects.toThrow(/embedding model/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('classifies an outage the same way chat does', async () => {
    const fetchImpl = stubEmbed(null, 503)
    await expect(
      new LlmClient(embedConfig, fetchImpl as never).embed(['a']),
    ).rejects.toBeInstanceOf(LlmUnavailableError)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter shared exec vitest run src/llm.test.ts`
Expected: FAIL. `EMBEDDING_DIMENSIONS` is not exported and `embed` is not a function.

- [ ] **Step 3: Implement**

In `shared/src/llm.ts`, add `embeddingModel` to the config:

```ts
export interface LlmConfig {
  baseUrl: string
  apiKey: string | null
  model: string
  timeoutMs: number
  /**
   * Optional because only some services embed. Absent means `embed()`
   * refuses rather than guessing, since a guessed model is a guessed
   * dimension.
   */
  embeddingModel?: string
}

// Defined beside the column it sizes. Not the other way round: drizzle-kit
// loads schema.ts on its own, and a relative import from it is one more thing
// its loader has to resolve.
import { EMBEDDING_DIMENSIONS } from './schema.js'
export { EMBEDDING_DIMENSIONS }
```

Replace the body of `LlmClient` with one shared `post()` that both methods use, so that transport and status handling stay identical:

```ts
interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
}

export class LlmClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(messages: ChatMessage[]): Promise<string> {
    const body = (await this.post('/chat/completions', {
      model: this.config.model,
      messages,
      stream: false,
      // Deliberately no response_format. OmniRoute's lower provider
      // tiers ignore it, so depending on it would break on exactly the
      // days the router falls back. extractJson plus the validator do
      // the job instead.
      temperature: 0.7,
    })) as ChatResponse
    const content = body.choices?.[0]?.message?.content
    if (!content) {
      // Reachable but empty-handed. That is a reply, however useless, so it
      // costs a round rather than counting as an outage.
      throw new LlmError('The LLM returned no content')
    }
    return content
  }

  /** One vector per input, in input order. */
  async embed(input: string[]): Promise<number[][]> {
    if (input.length === 0) return []
    const model = this.config.embeddingModel
    if (!model) {
      throw new LlmError('No embedding model is configured')
    }

    const body = (await this.post('/embeddings', {
      model,
      input,
    })) as EmbeddingResponse

    // The API tags each vector with its input's index and does not promise
    // to return them in order.
    const vectors: Array<number[] | undefined> = new Array(input.length)
    for (const item of body.data ?? []) {
      if (typeof item.index === 'number' && Array.isArray(item.embedding)) {
        vectors[item.index] = item.embedding
      }
    }

    return vectors.map((vector, i) => {
      if (!vector) {
        throw new LlmError(`The embedding reply had no vector for input ${i}`)
      }
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new LlmError(
          `Expected ${EMBEDDING_DIMENSIONS} dimensions, got ${vector.length}`,
        )
      }
      return vector
    })
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`
    }

    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, '')}${path}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      )
    } catch (cause) {
      // Nothing answered — a refused connection or our own timeout. Both come
      // back on a scale far shorter than a cycle.
      throw new LlmUnavailableError('The LLM request failed', {
        cause,
        retry: 'fast',
      })
    }

    if (!response.ok) {
      // A rejected key is a 401 forever, and the router rate-limits with 429.
      // Charging both the same two-hour wait was the thing worth fixing.
      throw new LlmUnavailableError(`The LLM returned ${response.status}`, {
        retry: policyForStatus(response.status),
        retryAfterMs: retryAfterMsOf(response),
      })
    }

    return response.json()
  }
}
```

In `shared/src/schema.ts`, above `messages`, add

```ts
/** Must match the embedding model's output; `LlmClient.embed()` checks it. */
export const EMBEDDING_DIMENSIONS = 1536
```

and change the column to `vector('embedding', { dimensions: EMBEDDING_DIMENSIONS })`. Move the `import { EMBEDDING_DIMENSIONS } from './schema.js'` line in `llm.ts` up with the other imports.

- [ ] **Step 4: Run it and watch it pass, then confirm the schema did not drift**

```bash
pnpm --filter shared exec vitest run src/llm.test.ts
pnpm --filter shared typecheck
pnpm db:generate
```

Expected: tests PASS, the typecheck passes, and drizzle-kit reports **no schema changes**, because the constant equals the old literal. If it generates a migration, delete it and investigate.

- [ ] **Step 5: Run tweet-generator, which uses `chat()` through the refactored `post()`**

Run: `pnpm --filter tweet-generator test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/src/llm.ts shared/src/llm.test.ts shared/src/schema.ts
git commit -m "feat(shared): embeddings on the LLM client"
```

---

### Task 5: Telegram channel for the notifier

**Files:**
- Modify: `shared/src/notifier.ts`
- Modify: `shared/src/notifier.test.ts`

**Interfaces:**
- Produces, from `shared/notifier`:
  - `type NotifyTarget = { kind: 'discord'; webhookUrl: string } | { kind: 'telegram'; botToken: string; chatId: string }`
  - `notifyFailure(target: NotifyTarget | string | null, service, message, fetchImpl?)`. A bare string is still a Discord webhook URL, so the existing callers are untouched.
  - `notifyAttention(...)`, with the same widening
  - `loadNotifyTarget(env?: NodeJS.ProcessEnv): NotifyTarget | null`. It picks Telegram when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both set, otherwise Discord when `DISCORD_WEBHOOK_URL` is set, otherwise `null`.

- [ ] **Step 1: Write the failing tests**

Append this to `shared/src/notifier.test.ts`, and add `loadNotifyTarget` to the import:

```ts
describe('Telegram target', () => {
  const telegram = {
    kind: 'telegram' as const,
    botToken: '123:abc',
    chatId: '42',
  }

  it('posts to sendMessage for the configured chat', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await notifyFailure(telegram, 'wechat-collector', 'chatlog down', fetchImpl as never)

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.chat_id).toBe('42')
    expect(body.text).toContain('wechat-collector')
    expect(body.text).toContain('chatlog down')
  })

  it('sends plain text, not Discord markdown', async () => {
    // No parse_mode: Telegram's MarkdownV2 rejects any unescaped `.` or `-`,
    // and an error message is full of both.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await notifyAttention(telegram, 'wechat-collector', 'log in', fetchImpl as never)

    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    )
    expect(body).not.toHaveProperty('parse_mode')
    expect(body.text).not.toContain('**')
    expect(body.text).not.toContain('stopped')
  })

  it('truncates a message Telegram would reject for length', async () => {
    // Telegram refuses anything over 4096 characters outright. A long stack
    // trace should arrive cut short, not vanish.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await notifyFailure(telegram, 'svc', 'x'.repeat(10_000), fetchImpl as never)

    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    )
    expect(body.text.length).toBeLessThanOrEqual(4096)
    expect(body.text).toContain('…')
  })

  it('swallows a Telegram failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('telegram down'))
    await expect(
      notifyFailure(telegram, 'svc', 'boom', fetchImpl as never),
    ).resolves.toBeUndefined()
  })
})

describe('Discord target given as an object', () => {
  it('behaves exactly like the bare webhook string', async () => {
    const asString = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    const asObject = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notifyFailure('https://example.test/hook', 'svc', 'm', asString as never)
    await notifyFailure(
      { kind: 'discord', webhookUrl: 'https://example.test/hook' },
      'svc',
      'm',
      asObject as never,
    )
    expect(asObject.mock.calls).toEqual(asString.mock.calls)
  })
})

describe('loadNotifyTarget', () => {
  it('prefers Telegram when both halves are set', () => {
    expect(
      loadNotifyTarget({
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_CHAT_ID: '1',
        DISCORD_WEBHOOK_URL: 'https://example.test/hook',
      } as NodeJS.ProcessEnv),
    ).toEqual({ kind: 'telegram', botToken: 't', chatId: '1' })
  })

  it('falls back to Discord when Telegram is half-configured', () => {
    expect(
      loadNotifyTarget({
        TELEGRAM_BOT_TOKEN: 't',
        DISCORD_WEBHOOK_URL: 'https://example.test/hook',
      } as NodeJS.ProcessEnv),
    ).toEqual({ kind: 'discord', webhookUrl: 'https://example.test/hook' })
  })

  it('returns null when nothing is configured', () => {
    expect(loadNotifyTarget({} as NodeJS.ProcessEnv)).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter shared exec vitest run src/notifier.test.ts`
Expected: FAIL, because `loadNotifyTarget` is not exported and object targets are not handled. The existing tests still pass.

- [ ] **Step 3: Implement**

Replace `shared/src/notifier.ts` with:

```ts
/**
 * Notifications, to Discord or Telegram.
 *
 * Discord was the only channel while every service was a background job the
 * owner checked on occasionally. The WeChat assistant's owner lives in
 * Telegram, where its drafts already go, so a second channel is now warranted.
 * Each service picks one in its own config; nothing here chooses for it.
 *
 * `service` is a parameter rather than a constant because more than one
 * service reports through here, and a notification that does not say
 * which process stopped is a notification you have to go and investigate.
 */
export type NotifyTarget =
  | { kind: 'discord'; webhookUrl: string }
  | { kind: 'telegram'; botToken: string; chatId: string }

/** Telegram refuses a message longer than this outright. */
const TELEGRAM_MAX_LENGTH = 4096

/**
 * The target a service's environment names, or null for none.
 *
 * Telegram needs both halves; a token without a chat id falls through to
 * Discord rather than failing on the first alert.
 */
export function loadNotifyTarget(
  env: NodeJS.ProcessEnv = process.env,
): NotifyTarget | null {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    return {
      kind: 'telegram',
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    }
  }
  if (env.DISCORD_WEBHOOK_URL) {
    return { kind: 'discord', webhookUrl: env.DISCORD_WEBHOOK_URL }
  }
  return null
}

/** A bare string is a Discord webhook, which is what every caller passed before. */
function normalise(target: NotifyTarget | string | null): NotifyTarget | null {
  if (!target) return null
  if (typeof target === 'string') return { kind: 'discord', webhookUrl: target }
  return target
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

async function send(
  rawTarget: NotifyTarget | string | null,
  service: string,
  emoji: string,
  headline: string,
  message: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const target = normalise(rawTarget)
  if (!target) return

  try {
    if (target.kind === 'discord') {
      await fetchImpl(target.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: service,
          content: `${emoji} **${headline}**\n\`\`\`\n${message}\n\`\`\``,
        }),
      })
      return
    }

    // Plain text, no parse_mode: MarkdownV2 rejects any unescaped `.` or
    // `-`, and an error message is full of both.
    await fetchImpl(
      `https://api.telegram.org/bot${target.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: target.chatId,
          text: truncate(`${emoji} ${headline}\n\n${message}`, TELEGRAM_MAX_LENGTH),
        }),
      },
    )
  } catch {
    // A broken notification must not mask the failure it was reporting.
  }
}

/** The process has stopped and will not start again on its own. */
export function notifyFailure(
  target: NotifyTarget | string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return send(target, service, '🛑', `${service} stopped`, message, fetchImpl)
}

/**
 * The process is still running but is blocked on something only a person can
 * do, and will carry on by itself once they have done it.
 *
 * Worth its own headline rather than reusing `notifyFailure`: "stopped" would
 * be a lie, and a notification that misstates whether the service is alive
 * costs someone a trip to the machine to find out.
 */
export function notifyAttention(
  target: NotifyTarget | string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return send(
    target,
    service,
    '⏸️',
    `${service} is waiting for you`,
    message,
    fetchImpl,
  )
}
```

The Discord content string produced here is byte-identical to the old one: `🛑 **x-poster stopped**` and `⏸️ **x-poster is waiting for you**`.

- [ ] **Step 4: Run it and watch it pass, including the untouched callers**

```bash
pnpm --filter shared exec vitest run src/notifier.test.ts
pnpm --filter shared typecheck
pnpm --filter x-poster exec tsc --noEmit && pnpm --filter tweet-generator exec tsc --noEmit
```

Expected: all PASS. x-poster and tweet-generator compile with no edits.

- [ ] **Step 5: Commit**

```bash
git add shared/src/notifier.ts shared/src/notifier.test.ts
git commit -m "feat(shared): Telegram channel for notifications"
```

---

### Task 6: Rename the repository and the directory

No code changes. The steps are ordered so that nothing points at a path that no longer exists.

- [ ] **Step 1: Full suite on the final code**

```bash
for p in shared discord-monitor ai-assistant tweet-generator x-poster; do pnpm --filter $p test || break; done
```

Expected: every package PASS.

- [ ] **Step 2: Rename on GitHub (OUTWARD-FACING: confirm first)**

Ask the owner: "Rename `beasaltfish/multi-tab-listening` to `beasaltfish/semi-autopilot` on GitHub? GitHub redirects the old URL, but anything else that links to it by name should be updated." Continue only after an explicit yes.

```bash
gh repo rename semi-autopilot --yes
git remote set-url origin git@beasaltfish.github.com:beasaltfish/semi-autopilot.git
git remote -v && git fetch origin
```

Expected: the fetch succeeds against the new URL.

- [ ] **Step 3: Rename the directory (the owner runs this)**

Renaming the directory changes the working directory of the session that is doing the work, so the owner does it from outside:

```bash
cd ~/Projects/my && mv multi-tab-listening semi-autopilot && cd semi-autopilot
pnpm install
docker compose ps
```

Expected: `pnpm install` relinks the workspace, and `docker compose ps` shows `semi-autopilot-postgres` running against the same pinned project. The data is still there, because the name is pinned.
