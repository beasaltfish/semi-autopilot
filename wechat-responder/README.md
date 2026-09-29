# wechat-responder

Judges each collected WeChat message and, in **shadow mode**, pushes the owner
a draft reply or an alert on Telegram. It sends nothing to WeChat. The owner's
👍 / 👎 / ✏️ on each card is stored in `reply_decisions` — that feedback is the
calibration dataset for any later phase.

## Pipeline

For each unjudged WeChat message:

1. **Rules** drop the owner's own, system and sticker messages, and flag
   whether the message @s, quotes or names the owner.
2. **Jev** (`shared/jev`) judges intent, whether it is addressed to the owner,
   and whether history is needed — one call.
3. **Routing** (the owner's rules):
   - `ai_probe` / `critical` → **alert** (never a draft).
   - addressed to the owner but uncertain → **alert**.
   - `question` @ing someone else → **record only**.
   - `question` addressed to the owner or @ing no one → **draft**.
   - confident `praise` addressed to the owner → **template**.
   - everything else → **record only**.
4. **Draft** answers in the owner's voice, or proposes @-ing a recurring
   **domain expert** — only for a history-needing question where one exists.
   The draft is validated for length and banned AI phrases, regenerated once,
   then sent draft-less if it still fails.

Nothing waits to see whether someone else answered.

## Setup

```bash
cp .env.example .env
```

Fill in:
- `OPENROUTER_API_KEY` — Jev, billed to OpenRouter.
- `LLM_MODEL` (+ `LLM_BASE_URL`) — the model that phrases drafts.
- `WECHAT_OWNER_ID` — your own wxid. `WECHAT_OWNER_NAMES` — what groups call you.
- `TELEGRAM_BOT_TOKEN` (from @BotFather) and `TELEGRAM_CHAT_ID` (your own chat).
  To find your chat id: message the bot once, then open
  `https://api.telegram.org/bot<token>/getUpdates` and read `message.chat.id`.

Editable, git-tracked knobs: `templates.json` (praise replies),
`banned-phrases.json` (AI tells to reject), `style-rules.json` (your hard
"never" rules for drafts). Thresholds and limits are env vars in `.env.example`.

## Run

```bash
pnpm db:up                            # from the repo root, once
pnpm --filter wechat-collector start  # collecting messages
pnpm --filter wechat-responder start  # judging and pushing cards
```

Keep the Telegram app open; cards arrive there. A card unanswered for
`CARD_EXPIRY_MINUTES` (30) is marked expired but still records feedback.

## Accuracy check — do this first

Before trusting the routing, measure Jev on your own Chinese messages. Hand-label
50–100 real messages as JSON Lines (`{"text": "…", "intent": "question"}`,
intents `question`/`praise`/`chitchat`/`ai_probe`/`critical`) in a git-ignored
file, then:

```bash
pnpm --filter wechat-responder eval labeled/intents.jsonl
```

It prints accuracy and per-label precision/recall. A poorly-scoring intent is
the signal to move that judgement to the LLM behind the `decide()` interface.

## Not in this phase

Sending to WeChat; automatic sending; an expert-profile table (expertise is
inferred from history).
