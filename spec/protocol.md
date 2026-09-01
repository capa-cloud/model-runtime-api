# Protocol

Status: pre-alpha normative draft.

## Request

An execution request contains:

- `ability`: stable caller intent;
- `input`: one or more typed parts;
- `requirements`: capabilities that must be present before routing;
- `routing`: bounded execution-routing preferences;
- `deadline_ms`: total execution deadline;
- `metadata`: low-cardinality caller metadata without sensitive content;
- `extensions`: explicitly provider-neutral extension data.

The runtime must reject malformed requests and unsatisfied requirements before starting provider
output.

## Events

Events use an execution-scoped monotonic `sequence` and timestamp.

| Event | Meaning |
| --- | --- |
| `execution.accepted` | Runtime accepted the request |
| `route.selected` | Runtime selected one provider/model attempt |
| `route.attempt_failed` | Retryable attempt failed before fallback |
| `output.delta` | Incremental output data |
| `usage.reported` | One or more usage facts became available |
| `execution.completed` | Execution succeeded and is terminal |
| `execution.failed` | Execution failed or was cancelled and is terminal |

Provider adapters do not assign execution IDs, sequence numbers, or timestamps. The runtime owns
that event envelope.

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
