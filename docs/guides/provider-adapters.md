# Provider adapters

![Three distinct provider protocol families translated into one ordered event family.](../assets/provider-adapters.jpg)

*Concept image. Adapter behavior is defined by public sources, code, and contract tests.*

The bundled adapters are clean-room protocol translators. They are libraries, not enabled by
default. The reference CLI loads only the deterministic Mock Provider unless
`MODEL_RUNTIME_CONFIG` points to a configuration file.

## Safe configuration

Every adapter rejects HTTP redirects. Configure the final provider endpoint explicitly; automatic
redirects must not carry deployment credentials to another origin. fal model and lifecycle URLs
must remain on the configured origin and must not contain URL credentials or fragments; lifecycle
URLs also reject query strings. Base URLs reject query strings for all adapters.

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

Once submission succeeds, later errors are non-retryable. A submit transport failure is also
non-retryable because remote acceptance is unknown. Explicit HTTP rejection before acceptance
retains the provider HTTP retry classification.

On polling exhaustion, cancellation, polling failure, or early iterator closure, the adapter
attempts one `PUT` to the same-origin cancellation URL and waits with a separate timeout (default
5 seconds; programmatic `cancelTimeoutMs` accepts 1 to 60000 milliseconds). Cleanup errors do not
replace the original execution error. Invalid or unavailable lifecycle URLs may prevent cleanup.
Already completed tasks are not cancelled, including when result retrieval fails.
Cleanup can delay the terminal runtime event by up to the cancellation timeout after the execution
deadline expires; it must not start another model attempt.

Cancellation is best effort: queued requests can be cancelled, but requests already processing
cannot be stopped. A local terminal state or successful cancellation HTTP response is not proof
that remote compute stopped. See the
[official queue cancellation contract](https://fal.ai/docs/documentation/model-apis/inference/queue#cancel-a-request).

All adapters have local HTTP fixture tests. They are not live-tested with real credentials in CI.

## Shared invariants

Every adapter must:

1. declare capabilities before routing;
2. accept execution identity, target, and cancellation from the Runtime;
3. emit provider events without assigning public sequence numbers;
4. bound provider response bodies and stream frames;
5. normalize portable errors without exposing provider response bodies or credentials;
6. emit only sourced or explicitly runtime-derived usage facts;
7. terminate with exactly one provider completion signal.
