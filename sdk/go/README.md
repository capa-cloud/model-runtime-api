# Go SDK

The Go client supports submit, status, result, cancel, and resumable SSE events using only the
standard library.

```go
client, err := modelruntime.NewClient("http://127.0.0.1:4320")
submission, err := client.Submit(ctx, modelruntime.ExecutionRequest{
    Ability: "text-generation",
    Input: []modelruntime.InputPart{{Type: "text", Text: "hello"}},
}, "request-public")
events, eventErrors := client.Events(ctx, submission.ExecutionID, 0)
```

The SDK talks only to Model Runtime. Provider credentials remain in the runtime deployment.
