# Provider evidence registry

Observed on 2026-09-02. Adapters must update this file when their public contract changes.

| Adapter | Primary public sources | Contract used |
| --- | --- | --- |
| OpenAI Responses | [Create a model response](https://developers.openai.com/api/reference/cli/resources/responses/methods/create) | `POST /responses`, typed SSE events, response usage details |
| Anthropic Messages | [Create a Message](https://platform.claude.com/docs/en/api/messages/create), [Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming) | `POST /v1/messages`, content-block SSE, partial tool-input JSON, usage |
| fal Queue | [Asynchronous inference](https://fal.ai/docs/documentation/model-apis/inference/queue) | Submit, status, result and cancel URLs; queued/in-progress/completed lifecycle |
| OpenTelemetry GenAI | [GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) | Provider/model identity and token/cache/reasoning usage attributes |

No adapter implementation may use private source code, captured customer traffic, production logs,
undocumented credentials, or private provider configuration as evidence.
