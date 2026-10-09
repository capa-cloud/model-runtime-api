# Protocol

Status: pre-alpha normative draft.

The machine-readable request schema is generated from the protocol package into
`spec/schema/execution-request.json`; CI rejects drift.

## Request

An execution request contains:

- `ability`: stable caller intent;
- `input`: one or more typed parts;
- `requirements`: capabilities that must be present before routing;
- `routing`: bounded execution-routing preferences;
- `deadline_ms`: total execution-work deadline; bounded remote cleanup may delay the terminal event;
- `metadata`: low-cardinality caller metadata without sensitive content;
- `extensions`: explicitly provider-neutral extension data.

The runtime must reject malformed requests and unsatisfied requirements before starting provider
output.

`POST /v1/executions` returns `202` with an execution ID. `Idempotency-Key` reuse with the same
request returns that execution; reuse with a different request fails. Status, result, cancellation,
and event-stream access use the execution ID.

For streaming text/tool providers, the EventStore deterministically materializes `output.delta` and
tool argument fragments into the result snapshot. For asynchronous media providers,
`output.result` remains the provider result and artifact references are listed separately.

SSE events are dispatched only on a complete blank-line delimiter. An incomplete final frame is
discarded. Clients report EOF after an observed nonterminal runtime event as truncation and can
resume from their last committed sequence. An empty replay after the terminal cursor is valid.
Closing a subscription closes its response body/watcher; execution cancellation is a separate
command. Server projection must honor socket backpressure and contain failures after headers have
been sent without returning another JSON response or leaking internal exception content.

Routing must infer required input modalities from all input parts, in addition to explicitly
declared requirements. Omitting a requirement or supplying a narrower list cannot make an
unsupported modality eligible. Public errors must not echo caller-controlled ability content,
metadata keys or validation instance paths.
Execution deadline exhaustion is terminal and not automatically retryable: a downstream task may
already have been accepted or produced output. A caller may explicitly choose a new request/deadline
after assessing that ambiguity; the runtime does not silently reset the exhausted budget.

## Events

Events use an execution-scoped monotonic `sequence` and timestamp.

| Event | Meaning |
| --- | --- |
| `execution.accepted` | Runtime accepted the request |
| `route.selected` | Runtime selected one provider/model attempt |
| `route.attempt_failed` | Retryable attempt failed before fallback |
| `output.delta` | Incremental output data |
| `tool.call.started` | A provider began a named tool call |
| `tool.call.arguments.delta` | Partial tool argument JSON or text; callers accumulate before parsing |
| `execution.progress` | An asynchronous provider reports queued or processing progress |
| `output.result` | A normalized asynchronous result and optional artifact references |
| `usage.reported` | One or more usage facts became available |
| `execution.completed` | Execution succeeded and is terminal |
| `execution.failed` | Execution failed or was cancelled and is terminal |

Provider adapters do not assign execution IDs, sequence numbers, or timestamps. The runtime owns
that event envelope.

The events endpoint accepts `after` or `Last-Event-ID`. Only events with larger sequence values are
returned. An EventStore implementation must preserve append-only ordering and terminal-event
visibility; durability across process restarts depends on the selected EventStore.

## Error behavior

Portable handling uses `code` and `retryable`. Provider-native codes may appear as diagnostic
evidence but must not replace the portable code. Implementations must not include credentials or
unredacted request content in public error messages.

## Usage facts

Known units include input, output, cache and reasoning tokens, media counts or seconds, tool
requests, and request count. Providers may emit a namespaced custom unit. Quantity must be finite and
non-negative. `source` states whether the provider reported the value or the runtime derived it.

## Provider extensions

Extensions are an escape hatch, not a compatibility claim. Adapter documentation must describe the
public source and behavior of each extension. Core fields must not change meaning based on an
undocumented extension.

Provider credentials are constructor or deployment inputs. They are never request extensions,
events, manifests, telemetry attributes, or error content.
