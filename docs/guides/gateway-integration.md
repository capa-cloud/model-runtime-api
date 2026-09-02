# Gateway integration

The runtime is an execution data plane, not the public tenant gateway.

```text
Caller -> authenticated AI gateway -> Model Runtime -> Provider
```

## Gateway responsibilities

- Authenticate the caller and authorize the requested ability.
- Bind the tenant to every execution ID server-side.
- Enforce tenant RPM, TPM, concurrency, budgets, and model-access policy.
- Inject an opaque request correlation ID and an idempotency key.
- Authorize status, events, result, and cancellation against the stored tenant binding.
- Redact or omit model content from logs and traces by default.
- Supply provider credentials to the runtime deployment, never to the caller.

## Forwarded request

```http
POST /v1/executions
Content-Type: application/json
Idempotency-Key: request-public
Traceparent: 00-00000000000000000000000000000001-0000000000000001-01
```

```json
{
  "ability": "text-generation",
  "requirements": { "stream": true },
  "input": [{ "type": "text", "text": "hello" }],
  "metadata": { "request_class": "interactive" }
}
```

Do not forward tenant credentials or use caller metadata as authorization proof. Keep tenant and
execution ownership in a gateway-owned store.

## Usage handling

Consume `usage.reported` as execution facts. Resolve prices and update customer ledgers outside the
runtime. Unknown usage units must remain unmatched rather than becoming zero cost.
