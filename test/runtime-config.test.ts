import assert from "node:assert/strict";
import test from "node:test";
import { createAgentDependenciesFromEnv, readPiAgentConfig } from "../src/runtime/config.js";

test("legacy DeepSeek environment settings become Pi Agent dependencies", () => {
  const env = {
    DEEPSEEK_API_KEY: "test-only-key",
    DEEPSEEK_BASE_URL: "https://proxy.example.test/v1/",
    DEEPSEEK_MODEL: "deepseek-v4-pro",
    DEEPSEEK_TIMEOUT_SECONDS: "45",
    DEEPSEEK_API_RETRIES: "1",
    DEEPSEEK_THINKING: "enabled",
    DEEPSEEK_REASONING_EFFORT: "max",
  };
  const config = readPiAgentConfig(env);
  assert.deepEqual(config, {
    baseUrl: "https://proxy.example.test/v1",
    model: "deepseek-v4-pro",
    timeoutMs: 45_000,
    apiRetries: 1,
    maxOutputTokens: 8_192,
    maxTokensField: "max_tokens",
    thinkingLevel: "max",
  });
  const dependencies = createAgentDependenciesFromEnv(env);
  assert.ok(dependencies);
  assert.equal(dependencies.model.id, "deepseek-v4-pro");
  assert.equal(dependencies.model.baseUrl, "https://proxy.example.test/v1");
  assert.equal(dependencies.model.reasoning, true);
  assert.equal(dependencies.model.maxTokens, 8_192);
  assert.equal((dependencies.model.compat as { maxTokensField?: string } | undefined)?.maxTokensField, "max_tokens");
});

test("proxy token field override is explicit and validated", () => {
  const config = readPiAgentConfig({
    DEEPSEEK_API_KEY: "test-only-key",
    DEEPSEEK_MAX_TOKENS_FIELD: "max_tokens",
  });
  assert.equal(config?.maxTokensField, "max_tokens");
  const dependencies = createAgentDependenciesFromEnv({
    DEEPSEEK_API_KEY: "test-only-key",
    DEEPSEEK_MAX_TOKENS_FIELD: "max_tokens",
  });
  assert.equal((dependencies?.model.compat as { maxTokensField?: string } | undefined)?.maxTokensField, "max_tokens");
  assert.throws(
    () => readPiAgentConfig({ DEEPSEEK_API_KEY: "test-only-key", DEEPSEEK_MAX_TOKENS_FIELD: "legacy" }),
    /DEEPSEEK_MAX_TOKENS_FIELD/,
  );
});

test("missing API key keeps the service in explicit no-agent mode", () => {
  assert.equal(readPiAgentConfig({}), undefined);
  assert.equal(createAgentDependenciesFromEnv({}), undefined);
});

test("legacy environment validation rejects unsupported thinking settings", () => {
  assert.throws(
    () => readPiAgentConfig({ DEEPSEEK_API_KEY: "test-only-key", DEEPSEEK_THINKING: "sometimes" }),
    /DEEPSEEK_THINKING/,
  );
  assert.throws(
    () => readPiAgentConfig({ DEEPSEEK_API_KEY: "test-only-key", DEEPSEEK_REASONING_EFFORT: "low" }),
    /DEEPSEEK_REASONING_EFFORT/,
  );
});
