package modelruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
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
		fmt.Fprint(w, "data:{\"type\":\"execution.completed\",\"execution_id\":\"execution-public\",\"sequence\":2,\"status\":\"succeeded\"}\n\n")
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
	var received []Event
	for event := range events {
		received = append(received, event)
	}
	if len(received) != 2 || received[0].Sequence != 1 || received[1].Type != "execution.completed" {
		t.Fatalf("unexpected events: %#v", received)
	}
	if err := <-eventErrors; err != nil {
		t.Fatal(err)
	}
}

func TestPreservesRequiredInputValues(t *testing.T) {
	for _, fixture := range []struct {
		part     InputPart
		expected string
	}{
		{InputPart{Type: "text"}, `{"text":"","type":"text"}`},
		{InputPart{Type: "json"}, `{"type":"json","value":null}`},
		{InputPart{Type: "json", Value: false}, `{"type":"json","value":false}`},
		{InputPart{Type: "image", URI: "https://media.example.test/image.png"}, `{"type":"image","uri":"https://media.example.test/image.png"}`},
	} {
		value, err := json.Marshal(fixture.part)
		if err != nil || string(value) != fixture.expected {
			t.Fatalf("unexpected input part: %s %v", value, err)
		}
	}
}

func TestSSEFrameLimitAndTruncation(t *testing.T) {
	for _, fixture := range []struct{ name, body, expected string }{
		{"multiline", strings.Repeat("data:"+strings.Repeat("x", 1024)+"\n", 1024), "frame exceeds"},
		{"truncated", "data:{\"type\":\"execution.accepted\",\"sequence\":1}\n\n", "before a terminal"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, fixture.body) }))
			defer server.Close()
			client, err := NewClient(server.URL)
			if err != nil {
				t.Fatal(err)
			}
			events, eventErrors := client.Events(context.Background(), "fixture", 0)
			for range events {
			}
			err = <-eventErrors
			if err == nil || !strings.Contains(err.Error(), fixture.expected) {
				t.Fatalf("unexpected stream error: %v", err)
			}
		})
	}
}

func TestRejectsQueryAndNegativeCursor(t *testing.T) {
	if _, err := NewClient("https://runtime.example.test?fixture=value"); err == nil {
		t.Fatal("expected query rejection")
	}
	client, err := NewClient("https://runtime.example.test")
	if err != nil {
		t.Fatal(err)
	}
	events, eventErrors := client.Events(context.Background(), "fixture", -1)
	for range events {
	}
	if err := <-eventErrors; err == nil {
		t.Fatal("expected cursor rejection before a request")
	}
}

func TestRejectsCredentialInBaseURL(t *testing.T) {
	if _, err := NewClient("https://user:password@example.test"); err == nil {
		t.Fatal("expected URL credentials to be rejected")
	}
}
