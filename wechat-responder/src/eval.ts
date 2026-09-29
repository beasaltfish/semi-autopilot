/**
 * The first milestone: how accurate is Jev on the owner's Chinese messages,
 * by intent? Hand-label 50–100 real messages, run Jev's intent question over
 * them, and measure. A label that falls short here is the signal to move that
 * judgement to the LLM — a swap behind `decide()` that leaves the rest alone.
 *
 * Usage:
 *   OPENROUTER_API_KEY=… pnpm --filter wechat-responder eval labeled/intents.jsonl
 *
 * The file is JSON Lines, one `{ "text": "…", "intent": "question" }` per line.
 * It holds real messages, so it stays out of the repository (.gitignore).
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { JevClient, type JevJudgement } from 'shared/jev'
import { loadJevConfig } from './config.js'
import { INTENT_LABELS, type Intent, intentQuestion } from './questions.js'

export interface Labeled {
  text: string
  intent: string
}

export interface Prediction {
  gold: string
  predicted: string
  confidence: number
}

export interface Score {
  total: number
  correct: number
  accuracy: number
  /** confusion[gold][predicted] = count. */
  confusion: Record<string, Record<string, number>>
  /** Per-label precision and recall. */
  byLabel: Record<string, { precision: number; recall: number; support: number }>
}

/** Parse and validate a JSON Lines file of labeled messages. */
export function parseLabeled(text: string): Labeled[] {
  const rows: Labeled[] = []
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      throw new Error(`Line ${i + 1} is not valid JSON`)
    }
    const row = parsed as Labeled
    if (typeof row.text !== 'string' || typeof row.intent !== 'string') {
      throw new Error(`Line ${i + 1} needs string "text" and "intent"`)
    }
    if (!INTENT_LABELS.includes(row.intent as Intent)) {
      throw new Error(
        `Line ${i + 1}: "${row.intent}" is not one of ${INTENT_LABELS.join(', ')}`,
      )
    }
    rows.push(row)
  })
  return rows
}

/** Score predictions against their gold labels: accuracy and confusion. */
export function scoreIntents(predictions: Prediction[]): Score {
  const labels = INTENT_LABELS as readonly string[]
  const confusion: Record<string, Record<string, number>> = {}
  for (const gold of labels) {
    confusion[gold] = Object.fromEntries(labels.map((p) => [p, 0]))
  }

  let correct = 0
  for (const { gold, predicted } of predictions) {
    // A predicted label outside the set still needs a column, or it vanishes.
    ;(confusion[gold] ??= Object.fromEntries(labels.map((p) => [p, 0])))
    confusion[gold][predicted] = (confusion[gold][predicted] ?? 0) + 1
    if (gold === predicted) correct += 1
  }

  const byLabel: Score['byLabel'] = {}
  for (const label of labels) {
    const tp = confusion[label]?.[label] ?? 0
    const support = Object.values(confusion[label] ?? {}).reduce((a, b) => a + b, 0)
    const predictedAs = predictions.filter((p) => p.predicted === label).length
    byLabel[label] = {
      precision: predictedAs ? tp / predictedAs : 0,
      recall: support ? tp / support : 0,
      support,
    }
  }

  const total = predictions.length
  return { total, correct, accuracy: total ? correct / total : 0, confusion, byLabel }
}

/** Classify each message's intent, one call each. `decide` is injected for tests. */
export async function classifyIntents(
  decide: (state: string) => Promise<Record<string, JevJudgement>>,
  samples: Labeled[],
): Promise<Prediction[]> {
  const predictions: Prediction[] = []
  for (const sample of samples) {
    const judgement = (await decide(sample.text)).intent
    predictions.push({
      gold: sample.intent,
      predicted: judgement.label,
      confidence: judgement.confidence,
    })
  }
  return predictions
}

function printScore(score: Score): void {
  console.log(`\nAccuracy: ${(score.accuracy * 100).toFixed(1)}% (${score.correct}/${score.total})\n`)
  console.log('Per label (precision / recall / support):')
  for (const [label, s] of Object.entries(score.byLabel)) {
    console.log(
      `  ${label.padEnd(10)} ${(s.precision * 100).toFixed(0).padStart(3)}% / ` +
        `${(s.recall * 100).toFixed(0).padStart(3)}% / ${s.support}`,
    )
  }
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) {
    throw new Error('Pass the labeled JSONL path: pnpm --filter wechat-responder eval <file>')
  }
  const samples = parseLabeled(readFileSync(path, 'utf8'))
  console.log(`Loaded ${samples.length} labeled messages; querying Jev…`)

  const jev = new JevClient(loadJevConfig())
  const predictions = await classifyIntents(
    (state) => jev.decide(state, { intent: intentQuestion }),
    samples,
  )
  printScore(scoreIntents(predictions))
}

// Only run when invoked directly, so the pure functions can be imported in tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
