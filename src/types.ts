/** Cloudflare Worker environment bindings */
export interface Env {
  OAUTH_KEY: KVNamespace;
  OAUTH_KV: KVNamespace;
  ROBYNN_API_BASE_URL: string;
  MCP_PUBLIC_BASE_URL?: string;
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  MCP_OBJECT: DurableObjectNamespace;
  // Injected by OAuthProvider at runtime
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<OAuthRequestInfo>;
    completeAuthorization(options: {
      request: OAuthRequestInfo;
      userId: string;
      metadata: Record<string, unknown>;
      scope: string[];
      props: Props;
      revokeExistingGrants?: boolean;
    }): Promise<{ redirectTo: string }>;
  };
}

/** OAuth request info parsed by OAuthProvider */
export interface OAuthRequestInfo {
  responseType: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string[];
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string | string[];
}

/** Props passed from OAuth to McpAgent Durable Object */
export interface Props {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  organizationId: string;
  [key: string]: unknown;
}

/** Standard API response from robynn.ai */
export interface RobynnApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Phase 1 intelligence-first MCP tools */
export type IntelligenceToolName =
  | "robynn_geo_analysis"
  | "robynn_competitive_battlecard"
  | "robynn_seo_opportunities";

/** Shared status values for MCP intelligence responses */
export type IntelligenceToolStatus =
  | "pending"
  | "success"
  | "partial"
  | "failed";

/** Suggested next-step surfaced back to Claude users */
export interface RecommendedAction {
  title: string;
  priority?: "high" | "medium" | "low";
  rationale?: string;
  type?: string;
}

/** Shared response envelope for intelligence tools */
export interface IntelligenceToolResultBase {
  summary: string;
  status: IntelligenceToolStatus;
  artifacts: Record<string, unknown>;
  recommended_actions: RecommendedAction[];
}

export interface GeoAnalysisRequest {
  company_name: string;
  category?: string;
  questions?: string[];
  competitors?: string[];
  analysis_depth?: "standard" | "deep";
}

export interface VisibilityScore {
  llm: string;
  score: number;
  mentions?: number;
  citations?: number;
}

export interface CitationBreakdown {
  target_company: number;
  competitor: number;
  other: number;
}

export interface QueryGap {
  query: string;
  gap_type?: string;
  detail?: string;
}

export interface GeoAnalysisResult extends IntelligenceToolResultBase {
  visibility_scores: VisibilityScore[];
  citation_breakdown: CitationBreakdown;
  query_gaps: QueryGap[];
}

export interface CompetitiveBattlecardRequest {
  competitor_name: string;
  company_name?: string;
  focus_areas?: string[];
  include_objections?: boolean;
}

export interface BattlecardSection {
  title: string;
  bullets: string[];
}

export interface CompetitiveBattlecardResult extends IntelligenceToolResultBase {
  comparison: BattlecardSection[];
  objections: string[];
  differentiators: string[];
  risks: string[];
}

export interface SeoOpportunitiesRequest {
  company_name: string;
  company_url?: string;
  competitors?: string[];
  keywords?: string[];
  market_context?: string;
}

export interface KeywordOpportunity {
  keyword: string;
  opportunity_score?: number;
  search_volume?: number;
  difficulty?: number;
  competitor_rank?: number | null;
}

export interface SeoOpportunitiesResult extends IntelligenceToolResultBase {
  opportunities: KeywordOpportunity[];
  keyword_gaps: KeywordOpportunity[];
  competitor_comparison: Record<string, unknown>[];
}

/** Brand context scope */
export type BrandScope = 'summary' | 'voice' | 'positioning' | 'competitors' | 'audience' | 'products' | 'rules' | 'full';

/** Brand context response */
export interface BrandContextData {
  scope: string;
  organization_id: string;
  company_name: string | null;
  documents: Record<string, {
    content: string;
    label: string;
    updated_at: string;
  } | Array<{
    content: string;
    label: string;
    updated_at: string;
  }>>;
  ttl_seconds: number;
}

/** Usage response */
export interface UsageData {
  balance: number;
  used: number;
  limit: number;
  plan: string;
}

/** CMO thread */
export interface Thread {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

/** CMO run result */
export interface RunResult {
  id: string;
  status: string;
  output?: string;
  thread_id?: string;
  tokens_used?: number;
}
