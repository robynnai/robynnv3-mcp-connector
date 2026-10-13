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
  CmoDecideRequest,
  BrandBookStatusRequest,
  BrandBookStatusResult,
  BrandBookGapAnalysisRequest,
  BrandBookGapAnalysisResult,
  BrandBookStrategyRequest,
  BrandBookStrategyResult,
  BrandReflectionsRequest,
  BrandReflectionsResult,
  TriggerBrandReflectionsRequest,
  TriggerBrandReflectionsResult,
  PublishBrandBookHtmlRequest,
  PublishBrandBookHtmlResult,
  WebsiteAuditRequest,
  WebsiteAuditResult,
  WebsiteAuditStatusRequest,
  WebsiteAuditV2Request,
  WebsiteAuditV2Result,
  WebsiteAuditV2StatusRequest,
  WebsiteOptimizationAuditRequest,
  WebsiteOptimizationAuditResult,
  WebsiteOptimizationAuditStatusRequest,
  WebsiteAuditOrchestratorRequest,
  WebsiteAuditOrchestratorStartResult,
  WebsiteAuditOrchestratorStatusRequest,
  WebsiteAuditOrchestratorStatusResult,
  WebsiteStrategyRequest,
  WebsiteStrategyResult,
  ContentPlanRequest,
  ContentPlanResult,
  WeeklyVisibilityReportRequest,
  WeeklyVisibilityReportResult,
  GeoAnalysisRequest,
  GeoAnalysisResult,
  CompetitiveBattlecardRequest,
  CompetitiveBattlecardResult,
  SeoOpportunitiesRequest,
  SeoOpportunitiesResult,
  BrandContextSearchRequest,
  BrandContextSearchResult,
  MarketingCampaignCreatorRequest,
  MarketingCampaignCreatorResult,
  MarketingCampaignStatusRequest,
  ConnectedAppsResult,
  ConnectedAppReadResult,
  ConnectedAppActionRequest,
  BridgeCapabilitiesResult,
  BrandSourceAddRequest,
  BrandSourceAddResult,
  BrandRebuildRequest,
  BrandRebuildResult,
  StrapiDraftPublishRequest,
  StrapiDraftPublishResult,
} from './types';
import type {
  AiVisibilityTrendInput,
  AiVisibilityTrendOutput,
  CheckPageContentInput,
  CheckPageContentOutput,
  CreateExperimentInput,
  CreateExperimentOutput,
  ExperimentResultsInput,
  ExperimentResultsOutput,
  ExperimentStatusInput,
  ExperimentStatusOutput,
  PromoteExperimentInput,
  PromoteExperimentOutput,
  ProposeExperimentsInput,
  ProposeExperimentsOutput,
  RollbackExperimentInput,
  RollbackExperimentOutput,
  SiteHealthInput,
  SiteHealthOutput,
  SiteLearningsInput,
  SiteLearningsOutput,
} from './tools/discoverability-schemas';

import { errorKind, redactLogString, safeLog } from './safe-log';

const READ_TIMEOUT_MS = 10_000;
/** Discoverability request writes validate and design before one atomic write. */
const DISCOVERABILITY_WRITE_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 280_000; // Under Claude's 300s timeout
const POLL_INTERVAL_MS = 2_000;
const RETRY_DELAY_MS = 1_000;

/**
 * Whether an app operation may be sent again automatically after a 5xx or a
 * network failure (COS-PLUGIN-001 P11, plan §5 "Unsafe automatic retry of
 * writes").
 *
 * A failed response does not prove the app did nothing: it may already have
 * charged credits, started a run or written to a connected app. Only
 * operations that `contracts/tool-route-map.json` marks `retrySafe: true` are
 * retried; everything else, including every operation added later, defaults
 * to `NO_RETRY`. The HTTP method is not evidence either way (several GETs
 * persist state). `robynn-client.retry.test.ts` checks every call against the
 * map.
 */
export type RetryPolicy = 'retry_safe' | 'no_retry';
const RETRY_SAFE: RetryPolicy = 'retry_safe';
const NO_RETRY: RetryPolicy = 'no_retry';

/**
 * HTTP client for the Robynn API (robynn.ai).
 * Authenticated with an OAuth access token passed as Bearer header.
 */
export interface RobynnClientOptions {
  refreshAccessToken?: () => Promise<string | null | undefined>;
  authLogContext?: string;
  /** Delay before the single automatic retry of a retry-safe operation. */
  retryDelayMs?: number;
}

const SAFE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DETAIL_LENGTH = 160;

const STATUS_FALLBACK_DETAIL: Record<number, string> = {
  400: 'The request was rejected.',
  401: 'Authorization expired or was revoked. Reconnect Robynn.',
  402: 'Not enough credits for this action.',
  403: 'This action is not permitted for this connection.',
  404: 'Not found.',
  409: 'The request conflicts with an earlier request.',
  413: 'The request is too large.',
  422: 'The request was rejected.',
  429: 'Too many requests. Try again later.',
};

/**
 * Error thrown for every failed Robynn API call.
 *
 * The message is safe to show to the model: it carries the HTTP status, the
 * app's machine-readable `code` when it has one, and at most a short,
 * redacted human message from a JSON error body. Raw response bodies, request
 * URLs, query strings and tokens never reach it (plan §5 "OAuth codes and
 * upstream errors can reach logs/model errors").
 */
export class RobynnApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    detail: string,
    readonly retryable = false,
    readonly requiredScope: string | null = null,
  ) {
    super(
      status > 0
        ? `API error ${status}${code ? ` (${code})` : ''}: ${detail}`
        : detail,
    );
    this.name = 'RobynnApiError';
  }
}

/**
 * Upstream 401 with no refresh hook: the hosted Worker never refreshes inside
 * a session (P10); the host's own refresh renews both token layers. The
 * message is fixed and never echoes the upstream body. Names and message match
 * P10 (`plugin-v1/p10-worker-session-vault`) so the two branches converge.
 */
export const AUTHORIZATION_EXPIRED_MESSAGE =
  "authorization_expired: Robynn did not accept this connection's current credentials. Retry the request; if it keeps failing, reconnect Robynn.";

export class UpstreamAuthorizationExpiredError extends RobynnApiError {
  constructor(
    /** The app's own 401 code (e.g. `grant_revoked`), kept for transports that map it. */
    readonly upstreamCode: string | null = null,
  ) {
    super(401, 'authorization_expired', AUTHORIZATION_EXPIRED_MESSAGE, true);
    this.name = 'UpstreamAuthorizationExpiredError';
    this.message = AUTHORIZATION_EXPIRED_MESSAGE;
  }
}

const MAX_RUN_FAILURE_LENGTH = 200;

/**
 * A polled run ended failed or cancelled. pollRun rejects with this so every
 * caller (starter tools, CLI) reports an error, not a successful result
 * (P11 review B3). The reason is the app's short summary, re-scrubbed here.
 */
export class RobynnRunFailedError extends RobynnApiError {
  constructor(
    readonly runId: string,
    readonly cancelled: boolean,
    reason: string | undefined,
  ) {
    const fallback = cancelled ? 'Run was cancelled.' : 'Run failed.';
    const detail = redactLogString(reason?.trim() || fallback)
      .slice(0, MAX_RUN_FAILURE_LENGTH)
      // Callers detect a poll timeout by this phrase; a failure must never
      // be mistaken for "still running".
      .replace(/run timed out/gi, 'run hit a timeout');
    super(0, cancelled ? 'run_cancelled' : 'run_failed', detail, false);
    this.name = 'RobynnRunFailedError';
  }
}

function pickString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Build a model-safe error from an upstream error response body. */
function toApiError(status: number, bodyText: string): RobynnApiError {
  let record: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON (HTML error page, plain text): never echoed.
  }

  const rawCode = record ? pickString(record, 'code', 'error_code') : null;
  const code = rawCode && SAFE_CODE_PATTERN.test(rawCode) ? rawCode : null;
  const rawScope = record ? pickString(record, 'required_scope') : null;
  const requiredScope =
    rawScope && /^[a-z]+:[a-z]+$/.test(rawScope) ? rawScope : null;
  const rawMessage = record ? pickString(record, 'message', 'error') : null;
  const message =
    rawMessage && status < 500
      ? redactLogString(rawMessage).slice(0, MAX_DETAIL_LENGTH)
      : null;
  const detail =
    message ??
    STATUS_FALLBACK_DETAIL[status] ??
    (status >= 500
      ? 'The Robynn service failed to complete the request.'
      : 'The request failed.');
  const retryable = record?.retryable === true || status === 429;

  return new RobynnApiError(status, code, detail, retryable, requiredScope);
}

/**
 * Encode a caller-supplied id as exactly one path segment. `encodeURIComponent`
 * leaves `.` and `..` intact, and URL parsing would resolve them as dot
 * segments, so they are refused outright (no request is sent).
 */
export function pathSegment(id: string): string {
  if (typeof id !== 'string' || id === '' || id === '.' || id === '..') {
    throw new RobynnApiError(0, 'invalid_argument', 'Invalid identifier.', false);
  }
  return encodeURIComponent(id);
}

/**
 * Log label for a request: the pathname without query or fragment, as
 * dot-joined segments (`api.cli.context.summary`). safe-log scrubs long
 * slash-containing runs whole, so a raw pathname would log as `[redacted]`;
 * the dotted form keeps static segments readable while id-like segments
 * (UUIDs, tokens) are still scrubbed.
 */
function routeLabel(path: string) {
  const end = path.search(/[?#]/);
  const pathname = end === -1 ? path : path.slice(0, end);
  return pathname.split('/').filter(Boolean).join('.');
}

export class RobynnClient {
  constructor(
    private readonly baseUrl: string,
    private accessToken: string,
    private readonly options: RobynnClientOptions = {},
  ) {}

  /** Adopt a newer upstream access token for the same session binding (P10). */
  setAccessToken(accessToken: string) {
    this.accessToken = accessToken;
  }

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
    timeoutMs = READ_TIMEOUT_MS,
    retry: RetryPolicy = NO_RETRY,
  ): Promise<T> {
    return this.fetchWithRetry(path, options, timeoutMs, retry === RETRY_SAFE ? 1 : 0);
  }

  private logContext() {
    return this.options.authLogContext ?? 'robynn-client';
  }

  private async retryAfterDelay() {
    const delayMs = this.options.retryDelayMs ?? RETRY_DELAY_MS;
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  /**
   * One request plus, at most, one 401 refresh replay and (for retry-safe
   * operations only) one 5xx/network retry.
   *
   * The 401 replay applies to every operation: the app authorizes before any
   * business work, so a 401 means nothing ran.
   */
  private async fetchWithRetry<T>(
    path: string,
    options: RequestInit,
    timeoutMs: number,
    retriesLeft: number,
    hasRefreshedAuth = false,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const route = routeLabel(path);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } catch (err) {
      clearTimeout(timeout);
      const timedOut = err instanceof Error && err.name === 'AbortError';
      // A timeout is never retried: the app may still be working.
      if (!timedOut && retriesLeft > 0) {
        safeLog.warn('robynn_api.retry', {
          route,
          context: this.logContext(),
          reason: 'network_error',
          error_kind: errorKind(err),
        });
        await this.retryAfterDelay();
        return this.fetchWithRetry(path, options, timeoutMs, retriesLeft - 1, hasRefreshedAuth);
      }
      throw timedOut
        ? new RobynnApiError(0, 'timeout', 'The Robynn API request timed out.', false)
        : new RobynnApiError(0, 'network_error', 'The Robynn API could not be reached.', false);
    }

    try {
      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch (err) {
          // Parser messages quote the body; never surface them.
          if (err instanceof Error && err.name === 'AbortError') {
            throw new RobynnApiError(0, 'timeout', 'The Robynn API request timed out.', false);
          }
          throw new RobynnApiError(
            0,
            'invalid_response',
            'The Robynn API returned an unreadable response.',
            false,
          );
        }
      }

      const text = await response.text().catch(() => '');
      const status = response.status;

      if (status === 401) {
        safeLog.warn('robynn_api.unauthorized', {
          route,
          context: this.logContext(),
          refresh_available: Boolean(this.options.refreshAccessToken),
          already_refreshed: hasRefreshedAuth,
        });
      }

      if (status === 401 && !this.options.refreshAccessToken) {
        throw new UpstreamAuthorizationExpiredError(toApiError(status, text).code);
      }

      if (status === 401 && !hasRefreshedAuth && this.options.refreshAccessToken) {
        clearTimeout(timeout);
        const refreshedToken = await this.options.refreshAccessToken();
        if (refreshedToken) {
          safeLog.info('robynn_api.token_refreshed', {
            route,
            context: this.logContext(),
          });
          this.accessToken = refreshedToken;
          return this.fetchWithRetry(path, options, timeoutMs, retriesLeft, true);
        }

        safeLog.warn('robynn_api.refresh_unavailable', {
          route,
          context: this.logContext(),
        });
      }

      if (status >= 500 && retriesLeft > 0) {
        clearTimeout(timeout);
        safeLog.warn('robynn_api.retry', {
          route,
          context: this.logContext(),
          reason: 'server_error',
          status,
        });
        await this.retryAfterDelay();
        return this.fetchWithRetry(path, options, timeoutMs, retriesLeft - 1, hasRefreshedAuth);
      }

      throw toApiError(status, text);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Get brand context by scope */
  async getBrandContext(scope: BrandScope): Promise<RobynnApiResponse<BrandContextData>> {
    return this.fetch(
      `/api/cli/context/${pathSegment(scope)}`,
      {},
      READ_TIMEOUT_MS,
      RETRY_SAFE,
    );
  }

  /** Get token usage */
  async getUsage(): Promise<RobynnApiResponse<UsageData>> {
    return this.fetch('/api/cli/usage', {}, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Get organization status/info */
  async getStatus(): Promise<RobynnApiResponse> {
    return this.fetch('/api/cli/context/summary', {}, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Get connected app capabilities for the org or a single provider */
  async getConnectedAppCapabilities(
    providerKey?: string,
  ): Promise<RobynnApiResponse<ConnectedAppsResult>> {
    return this.fetch(
      this.withQuery('/api/cli/connectors/capabilities', {
        provider_key: providerKey,
      }),
      {},
      READ_TIMEOUT_MS,
      RETRY_SAFE,
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
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Get semantic bridge capability metadata for Hermes and other MCP clients */
  async getBridgeCapabilities(): Promise<RobynnApiResponse<BridgeCapabilitiesResult>> {
    return this.fetch('/api/cli/mcp/capabilities', {}, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Add a Brand Hub website draft or text source through robynnv3 */
  async addBrandSource(
    payload: BrandSourceAddRequest,
  ): Promise<RobynnApiResponse<BrandSourceAddResult>> {
    return this.fetch('/api/cli/brand/sources', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /** Rebuild Brand Context through robynnv3 */
  async rebuildBrandContext(
    payload: BrandRebuildRequest,
  ): Promise<RobynnApiResponse<BrandRebuildResult>> {
    return this.fetch('/api/cli/brand/rebuild', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS, RETRY_SAFE);
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

  /** Search the authenticated organization's effective brand context */
  async brandContextSearch(
    payload: BrandContextSearchRequest
  ): Promise<RobynnApiResponse<BrandContextSearchResult>> {
    return this.fetch('/api/cli/mcp/brand-context/search', {
      method: 'POST',
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Get the current brand-book completeness snapshot */
  async brandBookStatus(
    payload: BrandBookStatusRequest = {}
  ): Promise<RobynnApiResponse<BrandBookStatusResult>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/brand-book/status", {
        include_recent_reflections: payload.include_recent_reflections,
      }),
      {},
      READ_TIMEOUT_MS,
      RETRY_SAFE,
    );
  }

  /** Explain which brand-book gaps matter most right now */
  async brandBookGapAnalysis(
    payload: BrandBookGapAnalysisRequest
  ): Promise<RobynnApiResponse<BrandBookGapAnalysisResult>> {
    return this.fetch("/api/cli/mcp/brand-book/gap-analysis", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Convert current brand context into a deterministic improvement strategy */
  async brandBookStrategy(
    payload: BrandBookStrategyRequest
  ): Promise<RobynnApiResponse<BrandBookStrategyResult>> {
    return this.fetch("/api/cli/mcp/brand-book/strategy", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS, RETRY_SAFE);
  }

  /** List current brand reflections and pending changelog items */
  async brandReflections(
    payload: BrandReflectionsRequest = {}
  ): Promise<RobynnApiResponse<BrandReflectionsResult>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/brand-book/reflections", {
        status_filter: payload.status_filter,
        limit: payload.limit,
      }),
      {},
      READ_TIMEOUT_MS,
      RETRY_SAFE,
    );
  }

  /** Manually trigger the brand reflection pipeline for the caller's org */
  async triggerBrandReflections(
    payload: TriggerBrandReflectionsRequest = {}
  ): Promise<RobynnApiResponse<TriggerBrandReflectionsResult>> {
    return this.fetch("/api/cli/mcp/brand-book/trigger-reflections", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Generate an HTML brand book artifact through the MCP-safe API route */
  async publishBrandBookHtml(
    payload: PublishBrandBookHtmlRequest = {}
  ): Promise<RobynnApiResponse<PublishBrandBookHtmlResult>> {
    return this.fetch("/api/cli/mcp/brand-book/publish-html", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Create or update a draft in a connected self-hosted Strapi instance */
  async publishStrapiDraft(
    payload: StrapiDraftPublishRequest
  ): Promise<RobynnApiResponse<StrapiDraftPublishResult>> {
    return this.fetch("/api/cli/mcp/strapi-draft", {
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
      POLL_TIMEOUT_MS,
      RETRY_SAFE,
    );
  }

  /** Execute a Website Auto-Healer v2 audit */
  async websiteAuditV2(
    payload: WebsiteAuditV2Request
  ): Promise<RobynnApiResponse<WebsiteAuditV2Result>> {
    return this.fetch("/api/cli/mcp/website/audit-v2", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Poll a Website Auto-Healer v2 audit run */
  async websiteAuditV2Status(
    payload: WebsiteAuditV2StatusRequest
  ): Promise<RobynnApiResponse<WebsiteAuditV2Result>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/website/audit-v2/status", {
        scan_id: payload.scan_id,
      }),
      {},
      POLL_TIMEOUT_MS,
      RETRY_SAFE,
    );
  }

  /** Start a Website Optimization V3 audit MVP run */
  async websiteOptimizationAudit(
    payload: WebsiteOptimizationAuditRequest
  ): Promise<RobynnApiResponse<WebsiteOptimizationAuditResult>> {
    return this.fetch("/api/cli/mcp/website/optimization-audit", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Poll a Website Optimization V3 audit MVP run */
  async websiteOptimizationAuditStatus(
    payload: WebsiteOptimizationAuditStatusRequest
  ): Promise<RobynnApiResponse<WebsiteOptimizationAuditResult>> {
    return this.fetch(
      this.withQuery("/api/cli/mcp/website/optimization-audit/status", {
        run_id: payload.run_id,
      }),
      {},
      POLL_TIMEOUT_MS,
      RETRY_SAFE,
    );
  }

  /** Start a read-only Website Audit Orchestrator run */
  async websiteAuditOrchestrator(
    payload: WebsiteAuditOrchestratorRequest
  ): Promise<RobynnApiResponse<WebsiteAuditOrchestratorStartResult>> {
    return this.fetch("/api/cli/mcp/website/audit-orchestrator", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Poll a Website Audit Orchestrator run */
  async websiteAuditOrchestratorStatus(
    payload: WebsiteAuditOrchestratorStatusRequest
  ): Promise<RobynnApiResponse<WebsiteAuditOrchestratorStatusResult>> {
    return this.fetch("/api/cli/mcp/website/audit-orchestrator/status", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS, RETRY_SAFE);
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

  /** Create a Content Studio plan through the MCP-safe Content Planner V2 route */
  async contentPlan(
    payload: ContentPlanRequest
  ): Promise<RobynnApiResponse<ContentPlanResult>> {
    return this.fetch("/api/cli/mcp/content-plan", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Build a weekly SEO/GEO visibility report for a connected website */
  async weeklyVisibilityReport(
    payload: WeeklyVisibilityReportRequest
  ): Promise<RobynnApiResponse<WeeklyVisibilityReportResult>> {
    return this.fetch("/api/cli/mcp/weekly-visibility-report", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS, RETRY_SAFE);
  }

  /**
   * COS-PLUGIN-002 discoverability reads (stored projections only). The app
   * answers with the bare success object (no `{ success, data }` envelope);
   * failures throw RobynnApiError with the app's status and code.
   */
  async discoverabilitySiteHealth(payload: SiteHealthInput): Promise<SiteHealthOutput> {
    return this.fetch("/api/cli/mcp/discoverability/site-health", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilityAiVisibilityTrend(
    payload: AiVisibilityTrendInput
  ): Promise<AiVisibilityTrendOutput> {
    return this.fetch("/api/cli/mcp/discoverability/ai-visibility-trend", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilitySiteLearnings(
    payload: SiteLearningsInput
  ): Promise<SiteLearningsOutput> {
    return this.fetch("/api/cli/mcp/discoverability/site-learnings", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /**
   * COS-PLUGIN-002 WP2-11. Reads (propose, check, status, results) are
   * stored-data only. The three request writes (create, promote, rollback)
   * carry a required idempotency_key the app binds to the caller's identity
   * and body, so one automatic retry replays the stored response instead of
   * creating a second request (tool-route-map retrySafe: true).
   */
  async discoverabilityProposeExperiments(
    payload: ProposeExperimentsInput
  ): Promise<ProposeExperimentsOutput> {
    return this.fetch("/api/cli/mcp/discoverability/propose-experiments", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilityCheckPageContent(
    payload: CheckPageContentInput
  ): Promise<CheckPageContentOutput> {
    return this.fetch("/api/cli/mcp/discoverability/check-page-content", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilityCreateExperiment(
    payload: CreateExperimentInput
  ): Promise<CreateExperimentOutput> {
    return this.fetch("/api/cli/mcp/discoverability/create-experiment", {
      method: "POST",
      body: JSON.stringify(payload),
    }, DISCOVERABILITY_WRITE_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilityExperimentStatus(
    payload: ExperimentStatusInput
  ): Promise<ExperimentStatusOutput> {
    return this.fetch("/api/cli/mcp/discoverability/experiment-status", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilityExperimentResults(
    payload: ExperimentResultsInput
  ): Promise<ExperimentResultsOutput> {
    return this.fetch("/api/cli/mcp/discoverability/experiment-results", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilityPromoteExperiment(
    payload: PromoteExperimentInput
  ): Promise<PromoteExperimentOutput> {
    return this.fetch("/api/cli/mcp/discoverability/promote-experiment", {
      method: "POST",
      body: JSON.stringify(payload),
    }, DISCOVERABILITY_WRITE_TIMEOUT_MS, RETRY_SAFE);
  }

  async discoverabilityRollbackExperiment(
    payload: RollbackExperimentInput
  ): Promise<RollbackExperimentOutput> {
    return this.fetch("/api/cli/mcp/discoverability/rollback-experiment", {
      method: "POST",
      body: JSON.stringify(payload),
    }, DISCOVERABILITY_WRITE_TIMEOUT_MS, RETRY_SAFE);
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
    return this.fetch(`/api/agents/cmo/threads/${pathSegment(threadId)}/runs`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS);
  }

  /** Fetch the latest state for a CMO run */
  async getRun(runId: string): Promise<RobynnApiResponse<RunResult>> {
    return this.fetch(
      `/api/agents/cmo/runs/${pathSegment(runId)}`,
      {},
      READ_TIMEOUT_MS,
      RETRY_SAFE,
    );
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

  /** Continue a CMO clarify turn by submitting a decision_card selection */
  async cmoDecide(
    payload: CmoDecideRequest
  ): Promise<RobynnApiResponse<CmoAgentResult>> {
    return this.fetch("/api/cli/mcp/cmo/decide", {
      method: "POST",
      body: JSON.stringify(payload),
    }, POLL_TIMEOUT_MS, RETRY_SAFE);
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

  /** Create or update a Hermes-originated thread in Robynn (multiplayer mirror) */
  async upsertHermesThread(
    payload: {
      hermes_host_id: string;
      hermes_session_id: string;
      platform:
        | "cli"
        | "telegram"
        | "slack"
        | "whatsapp"
        | "discord"
        | "signal"
        | "email"
        | "sms"
        | "cron"
        | "other";
      platform_user?: string;
      title?: string;
    }
  ): Promise<{ id: string }> {
    return this.fetch("/api/cli/threads", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /** Append a single message turn to a Hermes thread */
  async appendHermesMessage(
    threadId: string,
    payload: {
      role: "user" | "assistant" | "tool" | "system";
      content: string;
      tool_calls?: unknown[];
      tool_name?: string;
      tokens_in?: number;
      tokens_out?: number;
      latency_ms?: number;
    }
  ): Promise<{ id: string }> {
    return this.fetch(`/api/cli/threads/${pathSegment(threadId)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Write an org/user/session scoped memory */
  async writeHermesMemory(payload: {
    scope: "org" | "user" | "session";
    key: string;
    value: string;
  }): Promise<{ ok: boolean }> {
    return this.fetch("/api/cli/memory", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Read a scoped memory by key */
  async getHermesMemory(
    scope: "org" | "user" | "session",
    key: string
  ): Promise<{ key: string; value: string; updated_at?: string } | null> {
    return this.fetch(
      this.withQuery("/api/cli/memory", { scope, key }),
      {},
      READ_TIMEOUT_MS,
      RETRY_SAFE,
    );
  }

  /** Hybrid search over hermes_memories (0.7 cosine + 0.3 ts_rank) */
  async searchHermesMemory(payload: {
    query: string;
    scope?: "org" | "user" | "session";
    limit?: number;
  }): Promise<{
    rows: Array<{
      id: string;
      scope: string;
      key: string;
      value: string;
      updated_at: string;
      score: number;
    }>;
  }> {
    return this.fetch("/api/cli/memory/search", {
      method: "POST",
      body: JSON.stringify(payload),
    }, READ_TIMEOUT_MS, RETRY_SAFE);
  }

  /**
   * Execute a write action against a connected app (HubSpot/Salesforce/...).
   * Audit-logged server-side; idempotent by idempotency_key. Never retried
   * automatically: a resend with the same key is the caller's decision.
   */
  async actOnConnectedApp(payload: ConnectedAppActionRequest): Promise<{
    ok: boolean;
    replayed: boolean;
    audit_id: string;
    result?: unknown;
    error?: string;
    dry_run?: boolean;
  }> {
    return this.fetch("/api/cli/connectors/act", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /**
   * Poll a run until it finishes. Resolves only for a completed run; a failed
   * or cancelled run rejects with RobynnRunFailedError (callers report it as
   * an error), and running past `timeoutMs` rejects with "Run timed out".
   */
  async pollRun(
    runId: string,
    timeoutMs = POLL_TIMEOUT_MS,
  ): Promise<RobynnApiResponse<RunResult>> {
    const effectiveTimeoutMs = Math.max(0, Math.min(timeoutMs, POLL_TIMEOUT_MS));
    const start = Date.now();

    while (Date.now() - start < effectiveTimeoutMs) {
      const result = await this.getRun(runId);

      // The app reports failed and cancelled runs as a terminal 200
      // (`status: "failed"` plus `cancelled`, P11 review B2); a raw
      // `cancelled` status is accepted too.
      const data = result.data as (RunResult & { cancelled?: boolean }) | undefined;
      if (data?.status === 'completed') {
        return result;
      }
      if (data?.status === 'failed' || data?.status === 'cancelled') {
        throw new RobynnRunFailedError(
          data.id ?? runId,
          data.status === 'cancelled' || data.cancelled === true,
          data.output,
        );
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Run timed out after ${Math.floor(effectiveTimeoutMs / 1000)} seconds`);
  }
}
