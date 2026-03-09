/** Cloudflare Worker environment bindings */
export interface Env {
  OAUTH_KEY: KVNamespace;
  ROBYNN_API_BASE_URL: string;
  MCP_SERVER_NAME: string;
  MCP_SERVER_VERSION: string;
  MCP_OBJECT: DurableObjectNamespace;
  // Injected by OAuthProvider at runtime
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<OAuthRequestInfo>;
    completeAuthorization(options: {
      request: Request;
      userId: string;
      props: Props;
      options?: { scope?: string };
    }): Promise<Response>;
  };
}

/** OAuth request info parsed by OAuthProvider */
export interface OAuthRequestInfo {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
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
