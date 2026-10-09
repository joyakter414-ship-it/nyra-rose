import type { AppEnv } from "./env";
import { kvGet, kvSet } from "./db";

export interface NeuronUsageReport {
  isLive: boolean;
  accountWide: boolean;
  freePerDay: number;
  today: { day: string; neurons: number; requests: number };
  recent: Array<{ day: string; neurons: number; requests: number }>;
}

const CLIENT_ID = "54d11594-84e4-41aa-b438-e81b8fa78ee7";
const FREE_NEURONS_PER_DAY = 10_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Obtain a valid Cloudflare Access Token using the OAuth refresh token.
 */
async function getCloudflareAccessToken(env: AppEnv): Promise<string | null> {
  if (!env.CF_REFRESH_TOKEN) return null;

  const cached = await kvGet<CachedToken>(env, "cf_token_cache");
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  try {
    const params = new URLSearchParams();
    params.set("grant_type", "refresh_token");
    params.set("client_id", CLIENT_ID);
    params.set("refresh_token", env.CF_REFRESH_TOKEN);

    const res = await fetch("https://dash.cloudflare.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      console.warn("Could not refresh Cloudflare token:", res.status);
      return null;
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    await kvSet(env, "cf_token_cache", { accessToken: data.access_token, expiresAt });
    return data.access_token;
  } catch (err) {
    console.warn("Error refreshing Cloudflare access token:", err);
    return null;
  }
}

/**
 * Fetch live account-wide Cloudflare Workers AI (Neuron) analytics via GraphQL.
 * Shows true real-time Neurons consumed across the account (including Lady Jane + Nyra Rose).
 */
export async function getLiveNeuronUsage(env: AppEnv): Promise<NeuronUsageReport> {
  const today = new Date().toISOString().slice(0, 10);
  const accountId = env.CF_ACCOUNT_ID || "b1063110432e3589537a148bd49d57ee";

  // 1. Try Live Cloudflare GraphQL API
  try {
    const accessToken = await getCloudflareAccessToken(env);
    if (accessToken) {
      const startDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const query = `query {
        viewer {
          accounts(filter: { accountTag: "${accountId}" }) {
            aiInferenceAdaptiveGroups(
              limit: 10
              filter: { date_geq: "${startDate}" }
              orderBy: [date_DESC]
            ) {
              count
              sum {
                totalNeurons
              }
              dimensions {
                date
              }
            }
          }
        }
      }`;

      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      });

      if (res.ok) {
        const json = (await res.json()) as {
          data?: {
            viewer?: {
              accounts?: Array<{
                aiInferenceAdaptiveGroups?: Array<{
                  count: number;
                  sum: { totalNeurons: number };
                  dimensions: { date: string };
                }>;
              }>;
            };
          };
        };

        const groups = json.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
        const todayGroup = groups.find((g) => g.dimensions?.date === today);

        const recent = groups.map((g) => ({
          day: g.dimensions?.date,
          neurons: Math.round((g.sum?.totalNeurons || 0) * 10) / 10,
          requests: g.count || 0,
        }));

        return {
          isLive: true,
          accountWide: true,
          freePerDay: FREE_NEURONS_PER_DAY,
          today: {
            day: today,
            neurons: Math.round((todayGroup?.sum?.totalNeurons || 0) * 10) / 10,
            requests: todayGroup?.count || 0,
          },
          recent,
        };
      }
    }
  } catch (err) {
    console.warn("Failed fetching live Cloudflare Neuron analytics, falling back to local D1:", err);
  }

  // 2. Fallback to local D1 usage table
  const localUsage = await env.DB.prepare(
    "SELECT day, neurons, requests FROM usage ORDER BY day DESC LIMIT 7"
  ).all<{ day: string; neurons: number; requests: number }>();

  return {
    isLive: false,
    accountWide: false,
    freePerDay: FREE_NEURONS_PER_DAY,
    today: localUsage.results.find((u) => u.day === today) ?? { day: today, neurons: 0, requests: 0 },
    recent: localUsage.results,
  };
}
