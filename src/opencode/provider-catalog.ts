/**
 * The OpenCode provider entry is shared by the isolated DEV host and the
 * production installer, so both expose exactly the same model catalog and
 * pre-compaction budgets to OpenCode's V2 `providers` config.
 */
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from "../chatgpt-web-models";
import type { AppConfig } from "../config";

export const OPENCODE_PROVIDER_ID = "opencode-chatgpt-web";
export const OPENCODE_PROVIDER_NAME = "OpenCode ChatGPT";
export const OPENCODE_PROVIDER_PACKAGE = "@opencode/ai/providers/openai/responses";

export interface OpenCodeProviderModel {
  name: string;
  modelID: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; output: number };
}

export interface OpenCodeProviderEntry {
  name: string;
  package: string;
  settings: { baseURL: string; apiKey: string };
  models: Record<string, OpenCodeProviderModel>;
}

export function buildOpenCodeProviderEntry(
  config: AppConfig,
  { baseURL, apiKey }: { baseURL: string; apiKey: string },
): { provider: OpenCodeProviderEntry; defaultModel: string } {
  const routes = availableChatGptWebModelRoutes(config);
  if (routes.length === 0 || routes.some(route => route.interactionMode !== "automatic")) {
    throw new Error("OpenCode needs at least one automatic ChatGPT browser model");
  }
  const models = Object.fromEntries(routes.map(route => {
    const suffix = route.slug.slice("chatgpt-web/".length);
    const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config,
      route.interactionMode === "automatic" ? route.modelFamily : undefined);
    return [suffix, {
      name: route.displayName,
      modelID: `${OPENCODE_PROVIDER_ID}/${suffix}`,
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      // Expose the practical pre-compaction budget, not the raw window: OpenCode
      // compacts near limit.context, and a compaction summary that approaches the
      // measured ChatGPT Web window is rejected by the browser-side size guard.
      limit: { context: limits.autoCompactTokenLimit, output: Math.min(16_384, Math.floor(limits.contextWindow / 8)) },
    } satisfies OpenCodeProviderModel];
  }));
  const defaultRoute = routes.find(route => route.slug === "chatgpt-web/gpt-6-sol") ?? routes[0]!;
  return {
    provider: { name: OPENCODE_PROVIDER_NAME, package: OPENCODE_PROVIDER_PACKAGE, settings: { baseURL, apiKey }, models },
    defaultModel: `${OPENCODE_PROVIDER_ID}/${defaultRoute.slug.slice("chatgpt-web/".length)}`,
  };
}
