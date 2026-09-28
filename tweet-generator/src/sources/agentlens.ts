import type { SourceKind } from '../config.js'
import { policyForStatus, retryAfterMsOf, type RetryPolicy } from 'shared/retry'

/**
 * Any failure reaching AgentLens.
 *
 * One class still, but no longer one behaviour: `retry` says what waiting can
 * buy. Collapsing that distinction charged a DNS blip a full two-hour cycle
 * and let an expired key sit silent for six hours, which are the two ways
 * this can be wrong.
 */
export class AgentLensError extends Error {
  readonly retry: RetryPolicy
  /** From `Retry-After`, when the server named a pace. Null otherwise. */
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    options?: {
      cause?: unknown
      retry?: RetryPolicy
      retryAfterMs?: number | null
    },
  ) {
    super(message, options)
    this.name = 'AgentLensError'
    this.retry = options?.retry ?? 'slow'
    this.retryAfterMs = options?.retryAfterMs ?? null
  }
}

export interface BlogListItem {
  id: string
  title: string
  summary: string
  job_type: SourceKind
  source_id: string
  occurred_at: string | null
  generated_at: string
  signal: BlogSignal | null
}

/**
 * Whatever the API attached to a dispatch as evidence of interest.
 *
 * Deliberately not a discriminated union. Three kinds exist today
 * (`hn_points`, `momentum`, `youtube`) and more will follow; a union makes
 * an unknown kind either a compile error or a silent fall-through, and this
 * service should simply treat a kind it does not understand as no signal.
 */
export type BlogSignal = { type: string; [key: string]: unknown }

/**
 * The signal as a single comparable number, or null when there is none.
 *
 * `youtube` carries only a channel name, so it collapses to null and takes
 * the same path as a dispatch that arrived without a signal at all.
 */
export function heatOf(signal: BlogSignal | null): number | null {
  if (!signal) return null
  if (signal.type === 'hn_points' && typeof signal.value === 'number') {
    return signal.value
  }
  if (
    signal.type === 'momentum' &&
    typeof signal.stars_per_day === 'number'
  ) {
    return signal.stars_per_day
  }
  return null
}

export interface BlogReference {
  type: string
  title: string
  url?: string
  html_url?: string
  /**
   * The join key for a gh_project dispatch: the same identifier that
   * `GET /projects/ghp:{identifier}` takes. Only gh_project references
   * carry it; everything else leaves it undefined.
   */
  identifier?: string
}

export interface BlogDetail extends BlogListItem {
  body_markdown: string
  /**
   * Null, not `[]`, when a dispatch has no named sources — x_digest is
   * synthesised from a search, so it always arrives this way. Typing this
   * as a plain array is what crashed the first real run.
   */
  references: BlogReference[] | null
}

export interface ProjectListItem {
  id: string
  full_name: string
  description: string | null
  summary: string
  language: string | null
  topics: string[]
  tags: string[]
  license: string | null
  stars: number
  forks: number
  star_velocity_7d: number
  star_velocity_per_day: number
  momentum_score: number
  pushed_at: string
}

export interface ProjectDetail extends ProjectListItem {
  explainer_md: string
  html_url: string
}

interface Listing<T> {
  items: T[]
  total: number
}

/** The API clamps `limit` here itself; sending more just wastes the round trip. */
const MAX_LIMIT = 100

/**
 * The AgentLens wire shapes live in this file and nowhere else, so an API
 * change touches one module. Normalisation is `candidates.ts`'s job.
 *
 * `/query` (semantic search) is not implemented here yet. It is metered but
 * not rate-limited — the 100 free calls are a one-off grant, not a monthly
 * allowance — so the constraint on using it is cost, not throughput.
 */
export class AgentLensClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  private async get<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      // Nothing answered — DNS, a refused connection, or our own timeout.
      // Whatever it was is measured in seconds, not cycles.
      throw new AgentLensError(`GET ${url.pathname} failed`, {
        cause,
        retry: 'fast',
      })
    }

    if (!response.ok) {
      throw new AgentLensError(
        `GET ${url.pathname} returned ${response.status}`,
        {
          retry: policyForStatus(response.status),
          retryAfterMs: retryAfterMsOf(response),
        },
      )
    }

    return (await response.json()) as T
  }

  async listBlogs(jobType: SourceKind, limit = 100): Promise<BlogListItem[]> {
    const listing = await this.get<Listing<BlogListItem>>('/blogs', {
      job_type: jobType,
      limit: String(Math.min(limit, MAX_LIMIT)),
    })
    return listing.items
  }

  async getBlog(id: string): Promise<BlogDetail> {
    return this.get<BlogDetail>(`/blogs/${encodeURIComponent(id)}`)
  }

  async listProjects(limit = 100): Promise<ProjectListItem[]> {
    const listing = await this.get<Listing<ProjectListItem>>('/projects', {
      sort: 'momentum',
      limit: String(Math.min(limit, MAX_LIMIT)),
    })
    return listing.items
  }

  async getProject(id: string): Promise<ProjectDetail> {
    return this.get<ProjectDetail>(`/projects/${encodeURIComponent(id)}`)
  }
}
