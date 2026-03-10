/** Cloudflare Worker environment bindings */
export interface Env {
  OAUTH_KEY: KVNamespace;
  OAUTH_KV: KVNamespace;
  ROBYNN_API_BASE_URL: string;
  MCP_PUBLIC_BASE_URL?: string;
  MCP_INTERNAL_AUTH_SECRET?: string;
  CONNECTOR_STATE_SECRET?: string;
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

export type GuidedWorkflowToolName =
  | "robynn_brand_book_status"
  | "robynn_brand_book_gap_analysis"
  | "robynn_brand_book_strategy"
  | "robynn_brand_reflections"
  | "robynn_publish_brand_book_html"
  | "robynn_website_audit"
  | "robynn_website_strategy";

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
  next_steps: string[];
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

export interface BrandBookSectionItem {
  name: string;
  completed: boolean;
  detail?: string;
}

export interface BrandBookSection {
  name: string;
  weight: number;
  completed: boolean;
  completed_items: number;
  total_items: number;
  items: BrandBookSectionItem[];
}

export interface MissingItem {
  section: string;
  item: string;
  priority?: "high" | "medium" | "low";
  detail?: string;
}

export interface PriorityGap {
  title: string;
  section: string;
  priority?: "high" | "medium" | "low";
  rationale?: string;
  suggested_input?: string;
  example?: string;
}

export interface SectionFinding {
  section: string;
  score: number;
  summary?: string;
  missing_items: string[];
  recommendation?: string;
}

export interface ContentReadinessImpact {
  area: string;
  impact: string;
}

export interface StrategicPriority {
  title: string;
  priority?: "high" | "medium" | "low";
  rationale?: string;
}

export interface ReflectionItem {
  id: string;
  doc_name: string;
  doc_label?: string | null;
  operation: string;
  priority?: "high" | "medium" | "low" | null;
  headline?: string;
  summary?: string;
  details?: string;
  category?: string | null;
  confidence_score?: number | null;
  created_at: string;
  analyzed_at?: string | null;
  feedback_status?: "pending" | "accepted" | "rejected" | null;
}

export interface WebsiteFinding {
  title: string;
  detail?: string;
  evidence?: string;
  priority?: "high" | "medium" | "low";
  page?: string;
}

export interface PageRecommendation {
  page: string;
  priority?: "high" | "medium" | "low";
  recommendation: string;
  rationale?: string;
}

export interface MeasurementPlanItem {
  metric: string;
  target?: string;
  rationale?: string;
}

export interface BrandBookStatusRequest {
  include_recent_reflections?: boolean;
}

export interface BrandBookStatusResult extends IntelligenceToolResultBase {
  completeness_score: number;
  sections: BrandBookSection[];
  missing_items: MissingItem[];
  readiness_summary: string;
}

export interface BrandBookGapAnalysisRequest {
  focus_areas?: string[];
  include_competitive_context?: boolean;
  include_examples?: boolean;
}

export interface BrandBookGapAnalysisResult extends IntelligenceToolResultBase {
  highest_priority_gaps: PriorityGap[];
  section_findings: SectionFinding[];
  content_readiness_impact: ContentReadinessImpact[];
}

export interface BrandBookStrategyRequest {
  goals?: string[];
  focus_areas?: string[];
  include_intelligence_signals?: boolean;
}

export interface BrandBookStrategyResult extends IntelligenceToolResultBase {
  strategic_priorities: StrategicPriority[];
  positioning_recommendations: string[];
  voice_recommendations: string[];
  competitive_recommendations: string[];
  proof_recommendations: string[];
}

export interface BrandReflectionsRequest {
  status_filter?: "pending" | "recent" | "all";
  limit?: number;
}

export interface BrandReflectionsResult extends IntelligenceToolResultBase {
  pending_reflections: ReflectionItem[];
  recent_reflections: ReflectionItem[];
}

export interface PublishBrandBookHtmlRequest {
  theme?: string;
  include_private_sections?: boolean;
}

export interface PublishBrandBookHtmlResult extends IntelligenceToolResultBase {
  company_name: string | null;
  exported_at: string;
}

export interface WebsiteAuditRequest {
  website_url?: string;
  goals?: string[];
  competitors?: string[];
  analysis_depth?: "standard" | "deep";
}

export interface WebsiteAuditResult extends IntelligenceToolResultBase {
  website_url: string;
  messaging_findings: WebsiteFinding[];
  seo_findings: WebsiteFinding[];
  geo_findings: WebsiteFinding[];
  conversion_findings: WebsiteFinding[];
  competitor_findings: WebsiteFinding[];
}

export interface WebsiteStrategyRequest {
  website_url?: string;
  primary_goal?: string;
  constraints?: string[];
  priority_pages?: string[];
}

export interface WebsiteStrategyResult extends IntelligenceToolResultBase {
  website_url: string;
  priority_plan: StrategicPriority[];
  page_level_recommendations: PageRecommendation[];
  messaging_changes: string[];
  seo_geo_changes: string[];
  measurement_plan: MeasurementPlanItem[];
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
