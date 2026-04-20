import type {
  BrandContextData,
  BrandScope,
  UsageData,
  Thread,
  RunResult,
  RobynnApiResponse,
  CmoThreadRunRequest,
  CmoAgentRequest,
  CmoAgentResult,
  BrandBookStatusRequest,
  BrandBookStatusResult,
  BrandBookGapAnalysisRequest,
  BrandBookGapAnalysisResult,
  BrandBookStrategyRequest,
  BrandBookStrategyResult,
  BrandReflectionsRequest,
  BrandReflectionsResult,
  PublishBrandBookHtmlRequest,
  PublishBrandBookHtmlResult,
  WebsiteAuditRequest,
  WebsiteAuditResult,
  WebsiteAuditStatusRequest,
  WebsiteStrategyRequest,
  WebsiteStrategyResult,
  GeoAnalysisRequest,
  GeoAnalysisResult,
  CompetitiveBattlecardRequest,
  CompetitiveBattlecardResult,
  SeoOpportunitiesRequest,
  SeoOpportunitiesResult,
  MarketingCampaignCreatorRequest,
  MarketingCampaignCreatorResult,
  MarketingCampaignStatusRequest,
  ConnectedAppsResult,
  ConnectedAppReadResult,
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

  private withQuery(
    path: string,
    params: Record<string, string | number | boolean | undefined>
  ) {
    const url = new URL(path, this.baseUrl);
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
    return `${url.pathname}${url.search}`;
  }

  private async fetch<T>(
    path: string,
    options: RequestInit = {},
    timeoutMs = READ_TIMEOUT_MS
  ): Promise<T> {
    return this.fetchWithRetry(path, options, timeoutMs, 1);
  }

  private async fetchWithRetry<T>(
    path: string,
    options: RequestInit,
    timeoutMs: number,
    retriesLeft: number,
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
        const status = response.status;

        // Retry on 5xx server errors only
        if (status >= 500 && retriesLeft > 0) {
          clearTimeout(timeout);
          await new Promise((r) => setTimeout(r, 1_000));
          return this.fetchWithRetry(path, options, timeoutMs, retriesLeft - 1);
        }

        throw new Error(`API error ${status}: ${text}`);
      }

      return response.json() as Promise<T>;
    } catch (err) {
      // Retry on network errors (not aborts, not 4xx)
      if (
        retriesLeft > 0 &&
        err instanceof Error &&
        !err.message.startsWith('API error') &&
        err.name !== 'AbortError'
      ) {
        clearTimeout(timeout);
        await new Promise((r) => setTimeout(r, 1_000));
        return this.fetchWithRetry(path, options, timeoutMs, retriesLeft - 1);
      }
      throw err;
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

  /** Get connected app capabilities for the org or a single provider */
  async getConnectedAppCapabilities(
    providerKey?: string,
  ): Promise<RobynnApiResponse<ConnectedAppsResult>> {
    return this.fetch(
      this.withQuery('/api/cli/connectors/capabilities', {
        provider_key: providerKey,
      }),
    );
  }

  /** Execute a curated read-only query against a connected app */
  async readConnectedApp(payload: {
    provider_key: string;
    action_key: string;
    payload?: Record<string, unknown>;
    connection_id?: string;
  }): Promise<RobynnApiResponse<ConnectedAppReadResult>> {
    return this.fetch('/api/cli/connectors/read', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
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

  /** Get the current brand-book completeness snapshot */
  async brandBookStatus(
    payload: BrandBookStatusRequest = {}
  ): Promise<RobynnApiResponse<BrandBookStatusResult>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/brand-book/status", {
        include_recent_reflections: payload.include_recent_reflections,
      })
    );
  }

  /** Explain which brand-book gaps matter most right now */
  async brandBookGapAnalysis(
    payload: BrandBookGapAnalysisRequest
  ): Promise<RobynnApiResponse<BrandBookGapAnalysisResult>> {
    return this.fetch("/api/cli/mcp/brand-book/gap-analysis", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Convert current brand context into a deterministic improvement strategy */
  async brandBookStrategy(
    payload: BrandBookStrategyRequest
  ): Promise<RobynnApiResponse<BrandBookStrategyResult>> {
    return this.fetch("/api/cli/mcp/brand-book/strategy", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** List current brand reflections and pending changelog items */
  async brandReflections(
    payload: BrandReflectionsRequest = {}
  ): Promise<RobynnApiResponse<BrandReflectionsResult>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/brand-book/reflections", {
        status_filter: payload.status_filter,
        limit: payload.limit,
      })
    );
  }

  /** Generate an HTML brand book artifact through the MCP-safe API route */
  async publishBrandBookHtml(
    payload: PublishBrandBookHtmlRequest = {}
  ): Promise<RobynnApiResponse<PublishBrandBookHtmlResult>> {
    return this.fetch("/api/cli/mcp/brand-book/publish-html", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Execute a structured website audit against the organization's site */
  async websiteAudit(
    payload: WebsiteAuditRequest
  ): Promise<RobynnApiResponse<WebsiteAuditResult>> {
    return this.fetch("/api/cli/mcp/website/audit", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Poll a prospect audit created by the website audit tool */
  async websiteAuditStatus(
    payload: WebsiteAuditStatusRequest
  ): Promise<RobynnApiResponse<WebsiteAuditResult>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/website/audit/status", {
        prospect_audit_id: payload.prospect_audit_id,
      }),
      {},
      POLL_TIMEOUT_MS
    );
  }

  /** Translate website audit findings into a prioritized website strategy */
  async websiteStrategy(
    payload: WebsiteStrategyRequest
  ): Promise<RobynnApiResponse<WebsiteStrategyResult>> {
    return this.fetch("/api/cli/mcp/website/strategy", {
      method: "POST",
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
    payload: CmoThreadRunRequest
  ): Promise<RobynnApiResponse<{ run_id: string }>> {
    return this.fetch(`/api/agents/cmo/threads/${threadId}/runs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Fetch the latest state for a CMO run */
  async getRun(runId: string): Promise<RobynnApiResponse<RunResult>> {
    return this.fetch(`/api/agents/cmo/runs/${runId}`);
  }

  /** Execute a top-level CMO agent request through the MCP-safe API route */
  async cmoAgent(
    payload: CmoAgentRequest
  ): Promise<RobynnApiResponse<CmoAgentResult>> {
    return this.fetch("/api/cli/mcp/cmo/run", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Execute the marketing campaign creator through the MCP-safe API route */
  async campaignCreator(
    payload: MarketingCampaignCreatorRequest
  ): Promise<RobynnApiResponse<MarketingCampaignCreatorResult>> {
    return this.fetch("/api/cli/mcp/marketing-campaign", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Fetch the current status for a marketing campaign run */
  async campaignStatus(
    payload: MarketingCampaignStatusRequest
  ): Promise<RobynnApiResponse<MarketingCampaignCreatorResult>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/marketing-campaign/status", {
        threadId: payload.langgraph_thread_id,
        runId: payload.langgraph_run_id,
        company_name: payload.company_name,
        company_url: payload.company_url,
      })
    );
  }

  /** Poll a run until completion */
  async pollRun(
    runId: string,
    timeoutMs = POLL_TIMEOUT_MS,
  ): Promise<RobynnApiResponse<RunResult>> {
    const effectiveTimeoutMs = Math.max(0, Math.min(timeoutMs, POLL_TIMEOUT_MS));
    const start = Date.now();

    while (Date.now() - start < effectiveTimeoutMs) {
      const result = await this.getRun(runId);

      if (result.data?.status === 'completed' || result.data?.status === 'failed') {
        return result;
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Run timed out after ${Math.floor(effectiveTimeoutMs / 1000)} seconds`);
  }
}
