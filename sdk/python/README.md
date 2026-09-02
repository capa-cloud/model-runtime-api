# Python SDK

The Python client uses only the standard library and supports submit, status, result, cancel, and
resumable SSE events. It does not manage provider credentials.

```python
from model_runtime import ModelRuntimeClient

client = ModelRuntimeClient("http://127.0.0.1:4320")
submission = client.submit(
    {"ability": "text-generation", "input": [{"type": "text", "text": "hello"}]},
    idempotency_key="request-public",
)
for event in client.events(submission["execution_id"]):
    print(event["type"])
```
