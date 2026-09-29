# wechat-responder

Judges each collected WeChat message and, in shadow mode, drafts a reply for
the owner to approve on Telegram. Being built in stages; only the Jev
judgement and its accuracy check exist so far.

## Judgement questions

`src/questions.ts` is the single source of truth for what the pipeline asks
Jev about a message: its intent, whether it is addressed to the owner, and
whether answering needs history. The accuracy check below measures these exact
questions.

## Milestone: Jev accuracy on Chinese

Measure how well Jev classifies intent on the owner's real messages before
building the pipeline on it.

1. Hand-label 50–100 real messages as JSON Lines, one per line, in a
   git-ignored file (e.g. `labeled/intents.jsonl`):

   ```
   {"text": "作业什么时候交", "intent": "question"}
   {"text": "谢谢老师辛苦了", "intent": "praise"}
   ```

   Intents: `question`, `praise`, `chitchat`, `ai_probe`, `critical`.

2. Run it:

   ```bash
   cp .env.example .env   # set OPENROUTER_API_KEY
   pnpm --filter wechat-responder eval labeled/intents.jsonl
   ```

It prints overall accuracy and per-label precision/recall. A label that scores
poorly is the signal to move that judgement to the LLM — a swap behind the
`decide()` interface that leaves the rest unchanged.
