# Provider adapters

The bundled adapters are clean-room protocol translators. They are libraries, not enabled by
default. The reference CLI loads only the deterministic Mock Provider unless
`MODEL_RUNTIME_CONFIG` points to a configuration file.

## Safe configuration

Copy the structure in `deploy/runtime-config.example.json` and change public model identifiers as
needed. Configuration files reference an environment-variable name through `api_key_env`; they must
never contain a credential value.

```bash
export MODEL_RUNTIME_CONFIG=/deployment/runtime-config.json
export PROVIDER_A_API_KEY=provided-by-secret-manager
node packages/server/dist/cli.js
```

Do not commit the deployment configuration when it contains private endpoints, account identifiers,
or routing policy. The example uses fictional identifiers only.

## OpenAI Responses

- Calls `POST /v1/responses` with `stream: true` and `store: false`.
- Maps text deltas, function-call start/argument deltas, completion, and token/cache/reasoning usage.
- Supports HTTPS base URLs and loopback HTTP fixtures only.
- Provider-specific public request fields may be supplied under `extensions.openai.request`; core
  model, input, stream, and storage fields remain runtime-owned.

## Anthropic Messages

- Calls `POST /v1/messages` with the documented version header and SSE streaming.
- Maps content blocks, partial tool-input JSON, message completion, and usage.
- Provider-specific public request fields may be supplied under `extensions.anthropic.request`.

## fal Queue

- Submits to the configured model endpoint, then follows same-origin status, result, and cancel URLs.
- Maps queue/processing progress and discovers returned HTTP artifact references without downloading
  them.
- Default input mapping handles prompt and image URLs; model-specific input belongs under
  `extensions.fal.input` or a programmatic `mapInput` function.
- Artifact URLs can expire and are not copied or made permanent by this runtime.

All adapters have local HTTP fixture tests. They are not live-tested with real credentials in CI.
