/**
 * The judgements the responder puts to Jev about a group message, in one call.
 * This is the single source of truth: the accuracy check (plan 3) measures the
 * very questions the pipeline (plan 4) will ask, so a good score means the
 * thing that ships is good, not a proxy for it.
 *
 * Written in Chinese because the groups are Chinese and the state Jev sees is
 * Chinese; the instructions read in the same language as the messages.
 */
import type { JevQuestion } from 'shared/jev'

/** The intents a message can carry. Order is not significant. */
export const INTENT_LABELS = [
  'question',
  'praise',
  'chitchat',
  'ai_probe',
  'critical',
] as const

export type Intent = (typeof INTENT_LABELS)[number]

export const intentQuestion: JevQuestion = {
  type: 'choice',
  instructions: '这条群消息的主要意图是什么？',
  criteria: {
    question: '在提问、求助或征求意见，期待有人给出实质回答',
    praise: '在称赞、感谢、附和或鼓励，不需要实质回答',
    chitchat: '闲聊、寒暄、表情或无实质内容',
    ai_probe: '在试探对方是不是 AI、机器人或自动回复',
    critical: '在抱怨、质疑、指责或表达强烈不满',
  },
}

export const addressedQuestion: JevQuestion = {
  type: 'noul',
  instructions: '这条消息是在对“我”（群主本人）说话，而不是面向全群或别人吗？',
  criteria: {
    true: '点名我、@ 我，或明显在等我回应',
    false: '面向全群、在回复别人，或与我无关',
  },
}

export const needsHistoryQuestion: JevQuestion = {
  type: 'noul',
  instructions: '要正确回应这条消息，需要先看群里更早的聊天记录吗？',
  criteria: {
    true: '依赖上文、指代之前的人或事、承接先前的讨论',
    false: '消息本身自足，不看历史也能理解和回应',
  },
}

/** All three judgements, as one batch for `JevClient.decide`. */
export const judgementQuestions = {
  intent: intentQuestion,
  addressed: addressedQuestion,
  needs_history: needsHistoryQuestion,
} satisfies Record<string, JevQuestion>
