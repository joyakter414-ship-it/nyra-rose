/** Bindings + secrets available to the Worker / Pages function. */
export interface AppEnv {
  AI: Ai;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  /** Password for the web dashboard (secret). */
  DASHBOARD_PASSWORD: string;
  /** Shared token the WhatsApp gateway uses to talk to the brain (secret). */
  GATEWAY_TOKEN: string;
  /** GitHub Personal Access Token to trigger workflow dispatches (secret). */
  GITHUB_PAT?: string;
  /** GitHub repository owner/name (secret or var). */
  GITHUB_REPO?: string;
  /** Cloudflare Account ID for live GraphQL analytics. */
  CF_ACCOUNT_ID?: string;
  /** Cloudflare OAuth refresh token for live account-level Neuron usage. */
  CF_REFRESH_TOKEN?: string;
}
