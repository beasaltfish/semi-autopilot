import { describe, expect, it } from 'vitest'
import type { JevJudgement } from 'shared/jev'
import {
  classifyIntents,
  parseLabeled,
  scoreIntents,
  type Labeled,
  type Prediction,
} from './eval.js'

describe('parseLabeled', () => {
  it('reads one labeled message per non-empty line', () => {
    const text =
      '{"text":"作业交了吗","intent":"question"}\n\n{"text":"谢谢老师","intent":"praise"}\n'
    expect(parseLabeled(text)).toEqual([
      { text: '作业交了吗', intent: 'question' },
      { text: '谢谢老师', intent: 'praise' },
    ])
  })

  it('rejects an unknown intent, naming the line', () => {
    expect(() => parseLabeled('{"text":"x","intent":"banana"}')).toThrow('Line 1')
  })

  it('rejects a line missing a field', () => {
    expect(() => parseLabeled('{"text":"x"}')).toThrow('Line 1')
  })
})

describe('scoreIntents', () => {
  const predictions: Prediction[] = [
    { gold: 'question', predicted: 'question', confidence: 0.9 },
    { gold: 'question', predicted: 'chitchat', confidence: 0.4 },
    { gold: 'praise', predicted: 'praise', confidence: 0.8 },
    { gold: 'praise', predicted: 'praise', confidence: 0.7 },
  ]

  it('computes overall accuracy', () => {
    const score = scoreIntents(predictions)
    expect(score.correct).toBe(3)
    expect(score.total).toBe(4)
    expect(score.accuracy).toBe(0.75)
  })

  it('fills the confusion matrix', () => {
    const score = scoreIntents(predictions)
    expect(score.confusion.question.question).toBe(1)
    expect(score.confusion.question.chitchat).toBe(1)
    expect(score.confusion.praise.praise).toBe(2)
  })

  it('reports precision and recall per label', () => {
    const score = scoreIntents(predictions)
    // question: 1 correct of 2 gold → recall .5; 1 correct of 1 predicted → precision 1.
    expect(score.byLabel.question).toEqual({ precision: 1, recall: 0.5, support: 2 })
    // praise: 2/2 both ways.
    expect(score.byLabel.praise).toEqual({ precision: 1, recall: 1, support: 2 })
  })
})

describe('classifyIntents', () => {
  it('predicts each sample through the injected decide', async () => {
    const samples: Labeled[] = [
      { text: '作业交了吗', intent: 'question' },
      { text: '哈哈哈', intent: 'chitchat' },
    ]
    // A fake Jev: first is a confident question, second a chitchat.
    const replies: Record<string, JevJudgement> = {
      作业交了吗: { label: 'question', confidence: 0.9 },
      哈哈哈: { label: 'chitchat', confidence: 0.6 },
    }
    const decide = async (state: string) => ({ intent: replies[state] })
    const predictions = await classifyIntents(decide, samples)
    expect(predictions).toEqual([
      { gold: 'question', predicted: 'question', confidence: 0.9 },
      { gold: 'chitchat', predicted: 'chitchat', confidence: 0.6 },
    ])
  })
})
