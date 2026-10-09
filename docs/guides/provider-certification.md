# Provider protocol smoke verification

Use this tool to verify one explicitly selected public model against its account and adapter
protocol. It is a bounded smoke test, not a quality benchmark, SLA guarantee, comprehensive
feature certification or proof that cancellation stopped remote compute.

## Offline gate

```bash
pnpm build
pnpm check:certification
```

The gate uses only local loopback fixture servers with synthetic credentials. Fixture mode cannot
read real credentials or send requests to a non-loopback endpoint. It is included in `pnpm check`.

## Authorized live gate

Configure dedicated public-project credentials using your secure environment/secret manager:

| Provider | Credential environment variable | Baseline verification |
| --- | --- | --- |
| OpenAI | `MODEL_RUNTIME_CERT_OPENAI_API_KEY` | Responses SSE, exact synthetic text marker, terminal state |
| Anthropic | `MODEL_RUNTIME_CERT_ANTHROPIC_API_KEY` | Messages SSE, exact synthetic text marker, terminal state |
| fal | `MODEL_RUNTIME_CERT_FAL_API_KEY` | Image-model queue, status/result and nonempty artifact references |

Select an actual public vendor model approved for the test. Do not use private-system accounts,
private model aliases, customer input or configuration copied from another environment. Live mode
uses the adapter's official default endpoint and rejects custom base URLs.

```bash
pnpm certify:provider --provider openai --model YOUR_PUBLIC_MODEL --live --timeout-ms 30000
pnpm certify:provider --provider anthropic --model YOUR_PUBLIC_MODEL --live --timeout-ms 30000
pnpm certify:provider --provider fal --model YOUR_PUBLIC_IMAGE_MODEL --live --timeout-ms 30000
```

The tool performs one attempt without fallback. Text output is limited to 64 tokens by the public
provider request, and every execution has a deadline. fal cleanup can add its bounded cancellation
window to the deadline. Live calls are never part of the automatic PR/weekly fixture gate.

## Evidence boundary

The single JSON report contains provider/model identifiers, observed time, status, elapsed time,
event count, reference count, marker result and portable error code. It excludes credentials,
response bodies, output text, tool arguments, URLs and usage/financial quantities. Configuration
and parser failures emit only a generic error code, never raw arguments or exception content.

Keep real-account evidence in a deployment-owned private location; do not commit it automatically.
A fixture pass must remain labelled `mode: fixture`; only a successful authorized live invocation
is evidence for the selected account/model protocol. Further tool, structured-output, modality,
error and cancellation cases still require explicit evidence before broader feature certification.
