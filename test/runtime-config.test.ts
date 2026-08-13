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
  assert.equal((dependencies.model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, "deepseek");
});

test("custom DeepSeek models retain explicit thinking control when globally disabled", () => {
  const dependencies = createAgentDependenciesFromEnv({
    DEEPSEEK_API_KEY: "test-only-key",
    DEEPSEEK_BASE_URL: "https://proxy.example.test/v1",
    DEEPSEEK_MODEL: "deepseek-v4-flash:0731-cloud",
    DEEPSEEK_THINKING: "disabled",
  });
  assert.equal(dependencies?.model.reasoning, true);
  assert.equal((dependencies?.model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, "deepseek");
});

test("custom DeepSeek requests send the proxy explicit output and thinking controls", async () => {
  const dependencies = createAgentDependenciesFromEnv({
    DEEPSEEK_API_KEY: "test-only-key",
    DEEPSEEK_BASE_URL: "https://proxy.example.test/v1",
    DEEPSEEK_MODEL: "deepseek-v4-flash:0731-cloud",
    DEEPSEEK_THINKING: "disabled",
  });
  assert.ok(dependencies);
  let payload: any;
  const stream = await dependencies.streamFn(
    dependencies.model,
    {
      systemPrompt: "Return JSON.",
      messages: [{ role: "user", content: [{ type: "text", text: "{}" }], timestamp: Date.now() }],
    },
    {
      apiKey: "test-only-key",
      maxTokens: 512,
      onPayload: (value) => { payload = value; return value; },
      fetch: async () => new Response([
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{"role":"assistant","content":"{}"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"mock","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        "data: [DONE]",
        "",
      ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } }),
    },
  );
  await stream.result();
  assert.equal(payload.max_tokens, 512);
  assert.equal(payload.max_completion_tokens, undefined);
  assert.deepEqual(payload.thinking, { type: "disabled" });
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
