import { parseArgs } from "node:util";
import { ModelRuntime } from "../packages/core/dist/index.js";
import { OpenAiResponsesProvider } from "../packages/provider-openai/dist/index.js";
import { AnthropicMessagesProvider } from "../packages/provider-anthropic/dist/index.js";
import { FalQueueProvider } from "../packages/provider-fal/dist/index.js";

const keyNames = {
  openai: "MODEL_RUNTIME_CERT_OPENAI_API_KEY",
  anthropic: "MODEL_RUNTIME_CERT_ANTHROPIC_API_KEY",
  fal: "MODEL_RUNTIME_CERT_FAL_API_KEY",
};

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      live: { type: "boolean", default: false },
      fixture: { type: "boolean", default: false },
      "base-url": { type: "string" },
      "timeout-ms": { type: "string", default: "30000" },
    },
  });
  if (
    !Object.hasOwn(keyNames, values.provider ?? "") ||
    !values.model ||
    !/^[A-Za-z0-9_./:-]{1,256}$/.test(values.model) ||
    values.model.includes("://") ||
    values.model.startsWith("/") ||
    values.model.includes("..") ||
    values.live === values.fixture
  ) {
    throw new Error("invalid_configuration");
  }
  const timeout = Number(values["timeout-ms"]);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60000)
    throw new Error("invalid_configuration");
  const mode = values.fixture ? "fixture" : "live";
  if (values.live && values["base-url"]) throw new Error("invalid_configuration");
  if (values.fixture) {
    const url = new URL(values["base-url"] ?? "");
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error("invalid_configuration");
  }
  const apiKey = values.fixture ? "fixture-credential" : process.env[keyNames[values.provider]];
  if (!apiKey) throw new Error("missing_project_credential");
  const options = { apiKey, model: values.model, baseUrl: values["base-url"] };
  const provider =
    values.provider === "openai"
      ? new OpenAiResponsesProvider(options)
      : values.provider === "anthropic"
        ? new AnthropicMessagesProvider({ ...options, maxTokens: 64 })
        : new FalQueueProvider({
            ...options,
            ability: "image-generation",
            pollIntervalMs: values.fixture ? 1 : 500,
          });
  const runtime = new ModelRuntime();
  runtime.register(provider, { maxConcurrency: 1, maxQueueDepth: 0 });
  const started = Date.now();
  const submission = await runtime.submit({
    ability: values.provider === "fal" ? "image-generation" : "text-generation",
    input: [
      {
        type: "text",
        text:
          values.provider === "fal"
            ? "A plain blue square on a white background."
            : "Reply with the single word READY.",
      },
    ],
    requirements: values.provider === "fal" ? { async: true } : { stream: true },
    deadline_ms: timeout,
    routing: { allow_fallback: false, max_attempts: 1 },
    ...(values.provider === "openai"
      ? { extensions: { openai: { request: { max_output_tokens: 64 } } } }
      : {}),
  });
  let eventCount = 0;
  for await (const _event of runtime.events(submission.execution_id)) eventCount += 1;
  const snapshot = await runtime.get(submission.execution_id);
  const markerMatches =
    values.provider !== "fal" &&
    snapshot?.result?.outputs?.some(
      (output) => typeof output.text === "string" && output.text.trim() === "READY",
    );
  const artifactCount = snapshot?.artifacts?.length ?? 0;
  const passed =
    snapshot?.status === "succeeded" &&
    (values.provider === "fal" ? artifactCount > 0 : markerMatches);
  await runtime.shutdown();
  process.stdout.write(
    JSON.stringify({
      schema_version: "1",
      mode,
      suite: "protocol-smoke",
      observed_at: new Date().toISOString(),
      provider: values.provider,
      model: values.model,
      outcome: passed ? "passed" : "failed",
      status: snapshot?.status,
      elapsed_ms: Date.now() - started,
      event_count: eventCount,
      artifact_reference_count: artifactCount,
      marker_matches: Boolean(markerMatches),
      error_code: snapshot?.error?.code,
      output_capture: false,
      credential_capture: false,
    }) + "\n",
  );
  if (!passed) process.exitCode = 1;
}

main().catch((error) => {
  const known = ["invalid_configuration", "missing_project_credential"];
  process.stdout.write(
    JSON.stringify({
      schema_version: "1",
      outcome: "failed",
      error_code: known.includes(error?.message) ? error.message : "certification_error",
      output_capture: false,
      credential_capture: false,
    }) + "\n",
  );
  process.exitCode = 1;
});
