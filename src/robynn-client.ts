import type {
  BrandContextData,
  BrandScope,
  UsageData,
  Thread,
  RunResult,
  RobynnApiResponse,
  GeoAnalysisRequest,
  GeoAnalysisResult,
  CompetitiveBattlecardRequest,
  CompetitiveBattlecardResult,
  SeoOpportunitiesRequest,
  SeoOpportunitiesResult,
} from './types';

const READ_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 280_000; // Under Claude's 300s timeout
const POLL_INTERVAL_MS = 2_000;

/**
 * HTTP client for the Robynn API (robynn.ai).
 * Authenticated with an OAuth access token passed as Bearer header.
 */
export class RobynnClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string
  ) {}

  private async fetch<T>(
    path: string,
    options: RequestInit = {},
    timeoutMs = READ_TIMEOUT_MS
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API error ${response.status}: ${text}`);
      }

      return response.json() as Promise<T>;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Get brand context by scope */
  async getBrandContext(scope: BrandScope): Promise<RobynnApiResponse<BrandContextData>> {
    return this.fetch(`/api/cli/context/${scope}`);
  }

  /** Get token usage */
  async getUsage(): Promise<RobynnApiResponse<UsageData>> {
    return this.fetch('/api/cli/usage');
  }

  /** Get organization status/info */
  async getStatus(): Promise<RobynnApiResponse> {
    return this.fetch('/api/cli/context/summary');
  }

  /** List conversation threads */
  async listThreads(): Promise<RobynnApiResponse<{ threads: Thread[] }>> {
    return this.fetch('/api/agents/cmo/threads');
  }

  /** Execute GEO analysis through the MCP-safe API route */
  async geoAnalysis(
    payload: GeoAnalysisRequest
  ): Promise<RobynnApiResponse<GeoAnalysisResult>> {
    return this.fetch('/api/cli/mcp/geo-analysis', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Execute competitive battlecard generation through the MCP-safe API route */
  async competitiveBattlecard(
    payload: CompetitiveBattlecardRequest
  ): Promise<RobynnApiResponse<CompetitiveBattlecardResult>> {
    return this.fetch('/api/cli/mcp/competitive-battlecard', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Execute SEO opportunity analysis through the MCP-safe API route */
  async seoOpportunities(
    payload: SeoOpportunitiesRequest
  ): Promise<RobynnApiResponse<SeoOpportunitiesResult>> {
    return this.fetch('/api/cli/mcp/seo-opportunities', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Create a new conversation thread */
  async createThread(title?: string): Promise<RobynnApiResponse<Thread>> {
    return this.fetch('/api/agents/cmo/threads', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
  }

  /** Start a CMO run (content creation or research) */
  async startRun(
    threadId: string,
    payload: { message: string; type?: string }
  ): Promise<RobynnApiResponse<{ run_id: string }>> {
    return this.fetch(`/api/agents/cmo/threads/${threadId}/runs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Poll a run until completion */
  async pollRun(runId: string): Promise<RobynnApiResponse<RunResult>> {
    const start = Date.now();

    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const result = await this.fetch<RobynnApiResponse<RunResult>>(
        `/api/agents/cmo/runs/${runId}`
      );

      if (result.data?.status === 'completed' || result.data?.status === 'failed') {
        return result;
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error('Run timed out after 280 seconds');
  }
}
