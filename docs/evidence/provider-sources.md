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

## Model discovery sources

Verified on 2026-10-09. These are inventory readers, not inference capability or quality evidence.

| Reader | Primary source | Contract used |
| --- | --- | --- |
| OpenAI | [List models](https://developers.openai.com/api/reference/resources/models/methods/list) | `GET /v1/models`, model IDs and Unix creation timestamps |
| Anthropic | [List models](https://platform.claude.com/docs/en/api/typescript/models/list) | `GET /v1/models`, `after_id` paging, `has_more`/`last_id`, IDs and creation timestamps |

Owning-account fields and display names are excluded from stored projection. Creation metadata is
not promoted to a release-date claim, and vendor capabilities are not automatically registered
into the Runtime's provider manifest.
