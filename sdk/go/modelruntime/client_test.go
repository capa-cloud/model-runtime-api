package modelruntime

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSubmitAndEvents(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/executions", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Idempotency-Key") != "request-public" {
			t.Fatal("missing idempotency key")
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"execution_id":"execution-public","status":"accepted","created_at":"2026-01-01T00:00:00Z","idempotent_replay":false}`)
	})
	mux.HandleFunc("/v1/executions/execution-public/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "id: 1\nevent: execution.accepted\ndata: {\"type\":\"execution.accepted\",\"execution_id\":\"execution-public\",\"sequence\":1,\"time\":\"2026-01-01T00:00:00Z\",\"status\":\"accepted\"}\n\n")
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	client, err := NewClient(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	submission, err := client.Submit(context.Background(), ExecutionRequest{
		Ability: "text-generation",
		Input:   []InputPart{{Type: "text", Text: "fixture"}},
	}, "request-public")
	if err != nil || submission.ExecutionID != "execution-public" {
		t.Fatalf("unexpected submission: %#v %v", submission, err)
	}
	events, eventErrors := client.Events(context.Background(), submission.ExecutionID, 0)
	if event := <-events; event.Sequence != 1 || event.Type != "execution.accepted" {
		t.Fatalf("unexpected event: %#v", event)
	}
	if err := <-eventErrors; err != nil {
		t.Fatal(err)
	}
}

func TestRejectsCredentialInBaseURL(t *testing.T) {
	if _, err := NewClient("https://user:password@example.test"); err == nil {
		t.Fatal("expected URL credentials to be rejected")
	}
}
