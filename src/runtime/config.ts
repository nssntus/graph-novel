import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import type { StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Model,
  type ApiKeyAuth,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { PiAgentRuntime } from "./agent.js";
import type { GraphNovelAgentDependencies } from "../web/service.js";

export interface PiAgentConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  apiRetries: number;
  maxOutputTokens: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  thinkingLevel: ThinkingLevel;
}

/** Load the project-local .env without overriding explicitly exported values. */
export function loadProjectEnv(envPath = resolve(process.cwd(), ".env")): boolean {
  if (!existsSync(envPath)) return false;
  loadEnvFile(envPath);
  return true;
}

export function readPiAgentConfig(env: NodeJS.ProcessEnv = process.env): PiAgentConfig | undefined {
  if (!text(env.DEEPSEEK_API_KEY)) return undefined;
  const thinking = (text(env.DEEPSEEK_THINKING) || "disabled").toLowerCase();
  if (thinking !== "enabled" && thinking !== "disabled") {
    throw new Error("DEEPSEEK_THINKING must be 'enabled' or 'disabled'");
  }
  const effort = (text(env.DEEPSEEK_REASONING_EFFORT) || "high").toLowerCase();
  if (effort !== "high" && effort !== "max") {
    throw new Error("DEEPSEEK_REASONING_EFFORT must be 'high' or 'max'");
  }
  const rawMaxTokensField = text(env.DEEPSEEK_MAX_TOKENS_FIELD);
  if (rawMaxTokensField && rawMaxTokensField !== "max_tokens" && rawMaxTokensField !== "max_completion_tokens") {
    throw new Error("DEEPSEEK_MAX_TOKENS_FIELD must be 'max_tokens' or 'max_completion_tokens'");
  }
  const maxTokensField = (rawMaxTokensField || "max_tokens") as PiAgentConfig["maxTokensField"];
  return {
    baseUrl: (text(env.DEEPSEEK_BASE_URL) || "https://api.deepseek.com").replace(/\/+$/, ""),
    model: text(env.DEEPSEEK_MODEL) || "deepseek-v4-pro",
    timeoutMs: readFloatEnv(env, "DEEPSEEK_TIMEOUT_SECONDS", 120, 1, 600) * 1000,
    apiRetries: readIntEnv(env, "DEEPSEEK_API_RETRIES", 2, 0, 5),
    maxOutputTokens: readIntEnv(env, "DEEPSEEK_MAX_OUTPUT_TOKENS", 8_192, 512, 65_536),
    maxTokensField,
    thinkingLevel: thinking === "enabled" ? effort : "off",
  };
}

export function createAgentDependenciesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GraphNovelAgentDependencies | undefined {
  const config = readPiAgentConfig(env);
  if (!config) return undefined;

  const catalogModel = getBuiltinModels("deepseek").find((candidate) => candidate.id === config.model) as Model<"openai-completions"> | undefined;
  const model: Model<"openai-completions"> = {
    ...(catalogModel ?? {
      id: config.model,
      name: config.model,
      api: "openai-completions" as const,
      provider: "deepseek",
      baseUrl: config.baseUrl,
      reasoning: true,
      input: ["text"] as ("text")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
      compat: { supportsDeveloperRole: false },
    }),
    baseUrl: config.baseUrl,
    reasoning: true,
    maxTokens: Math.min(catalogModel?.maxTokens ?? 16_384, config.maxOutputTokens),
    compat: {
      ...(catalogModel?.compat ?? {}),
      supportsDeveloperRole: false,
      maxTokensField: config.maxTokensField,
      thinkingFormat: "deepseek",
    },
  };

  const auth: ApiKeyAuth = {
    name: "DeepSeek API key",
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
      const apiKey = text(env.DEEPSEEK_API_KEY);
      return apiKey ? { auth: { apiKey }, source: "DEEPSEEK_API_KEY" } : undefined;
    },
  };
  const provider = createProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: config.baseUrl,
    auth: { apiKey: auth },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const streamFn: StreamFn = (requestModel, context, options) => models.streamSimple(requestModel, context, {
    ...options,
    timeoutMs: config.timeoutMs,
    maxRetries: config.apiRetries,
  });

  return {
    runtime: new PiAgentRuntime({ thinkingLevel: config.thinkingLevel }),
    model,
    streamFn,
  };
}

function text(value: string | undefined): string {
  return value?.trim() ?? "";
}

function readIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function readFloatEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}`);
  }
  return value;
}
