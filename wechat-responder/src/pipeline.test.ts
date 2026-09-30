import { describe, expect, it, vi } from 'vitest'
import type { JevJudgement } from 'shared/jev'
import { mulberry32 } from 'shared/rng'
import { judge, type JudgeConfig, type JudgeDeps } from './pipeline.js'
import type { Candidate } from './store.js'

const owner = { id: 'wxid_me', names: ['老张'] }

const config: JudgeConfig = {
  owner,
  thresholds: { intentMin: 0.6, praiseMin: 0.7, addressedMin: 0.6 },
  templates: ['谢谢支持'],
  styleRules: [],
  banned: ['作为一个 AI'],
  maxDraftChars: 200,
  templateCooldownMinutes: 180,
  contextSize: 5,
  expertNeighbours: 8,
  now: new Date('2026-09-30T00:00:00Z'),
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    channelId: 'g@chatroom',
    authorId: 'wxid_a',
    authorName: '小王',
    content: '这个问题怎么弄',
    timestamp: new Date('2026-09-30T00:00:00Z'),
    embedding: new Array(1024).fill(0),
    rawData: { kind: 'text', mentions: [] },
    replyToAuthorId: null,
    ...overrides,
  }
}

function deps(overrides: Partial<JudgeDeps> = {}): JudgeDeps {
  return {
    jev: { decide: async () => ({ intent: { label: 'question', confidence: 0.9 } }) },
    llm: { chat: async () => '你试试重启' },
    retrieval: {
      similarOwnerReplies: async () => ['重启一下', '看看日志'],
      expertFor: async () => null,
    },
    embed: async () => new Array(1024).fill(0),
    recentContext: async () => [],
    templatesUsedFor: async () => [],
    rng: mulberry32(1),
    ...overrides,
  }
}

function withJev(judgements: Record<string, JevJudgement>): JudgeDeps {
  return deps({ jev: { decide: async () => judgements } })
}

describe('judge', () => {
  it("drops the owner's own message before calling Jev", async () => {
    const decide = vi.fn()
    const result = await judge(candidate({ authorId: 'wxid_me' }), deps({ jev: { decide } }), config)
    expect(result).toEqual({ messageId: 1, stage: 'rule', route: 'drop' })
    expect(decide).not.toHaveBeenCalled()
  })

  it('drafts a reply to a question and stores it', async () => {
    const result = await judge(
      candidate(),
      withJev({ intent: { label: 'question', confidence: 0.9 }, needs_history: { label: 'false', confidence: 0.9 } }),
      config,
    )
    expect(result).toMatchObject({ stage: 'llm', route: 'draft', draft: '你试试重启', mentionAuthorId: null })
  })

  it('alerts on an ai_probe and never drafts', async () => {
    const chat = vi.fn()
    const d = { ...withJev({ intent: { label: 'ai_probe', confidence: 0.9 } }), llm: { chat } }
    const result = await judge(candidate({ content: '你是机器人吗' }), d, config)
    expect(result).toMatchObject({ route: 'alert', stage: 'jev' })
    expect(result.draft).toBeUndefined()
    expect(chat).not.toHaveBeenCalled()
  })

  it('proposes an @ when a question needs history and an expert recurs', async () => {
    const d = deps({
      jev: {
        decide: async () => ({
          intent: { label: 'question', confidence: 0.9 },
          needs_history: { label: 'true', confidence: 0.9 },
        }),
      },
      retrieval: {
        similarOwnerReplies: async () => [],
        expertFor: async () => ({ authorId: 'wxid_expert', authorName: '李工', score: 0.5 }),
      },
      llm: { chat: async () => '这个问题 @李工 更清楚' },
    })
    const result = await judge(candidate(), d, config)
    expect(result).toMatchObject({ route: 'draft', mentionAuthorId: 'wxid_expert' })
  })

  it('uses a template for confident praise addressed to the owner', async () => {
    const result = await judge(
      candidate({ rawData: { mentions: ['wxid_me'] } }),
      withJev({ intent: { label: 'praise', confidence: 0.9 } }),
      config,
    )
    expect(result).toMatchObject({ route: 'template', draft: '谢谢支持' })
  })

  it('records instead of nagging when every template is on cooldown', async () => {
    const d = {
      ...withJev({ intent: { label: 'praise', confidence: 0.9 } }),
      templatesUsedFor: async () => ['谢谢支持'],
    }
    const result = await judge(candidate({ rawData: { mentions: ['wxid_me'] } }), d, config)
    expect(result.route).toBe('record_only')
  })

  it('embeds on demand when the row has no embedding', async () => {
    const embed = vi.fn(async () => new Array(1024).fill(0.1))
    const d = { ...deps({ embed }), jev: { decide: async () => ({ intent: { label: 'question', confidence: 0.9 } }) } }
    await judge(candidate({ embedding: null }), d, config)
    expect(embed).toHaveBeenCalledOnce()
  })
})
