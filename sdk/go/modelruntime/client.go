package modelruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
}

type Option func(*Client)

func WithHTTPClient(client *http.Client) Option {
	return func(c *Client) { c.httpClient = client }
}

func NewClient(baseURL string, options ...Option) (*Client, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("base URL must be an absolute HTTP or HTTPS URL")
	}
	client := &Client{baseURL: parsed, httpClient: http.DefaultClient}
	for _, option := range options {
		option(client)
	}
	return client, nil
}

type InputPart struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	URI       string `json:"uri,omitempty"`
	MediaType string `json:"media_type,omitempty"`
	Value     any    `json:"value,omitempty"`
}

type ExecutionRequest struct {
	Ability      string         `json:"ability"`
	Input        []InputPart    `json:"input"`
	Requirements map[string]any `json:"requirements,omitempty"`
	Routing      map[string]any `json:"routing,omitempty"`
	DeadlineMS   int            `json:"deadline_ms,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	Extensions   map[string]any `json:"extensions,omitempty"`
}

type Submission struct {
	ExecutionID      string `json:"execution_id"`
	Status           string `json:"status"`
	CreatedAt        string `json:"created_at"`
	IdempotentReplay bool   `json:"idempotent_replay"`
}

type Event struct {
	Type        string          `json:"type"`
	ExecutionID string          `json:"execution_id"`
	Sequence    int             `json:"sequence"`
	Time        string          `json:"time"`
	Status      string          `json:"status"`
	Raw         json.RawMessage `json:"-"`
}

func (c *Client) Submit(ctx context.Context, request ExecutionRequest, idempotencyKey string) (Submission, error) {
	var submission Submission
	if err := c.doJSON(ctx, http.MethodPost, "/v1/executions", request, idempotencyKey, &submission); err != nil {
		return Submission{}, err
	}
	return submission, nil
}

func (c *Client) Get(ctx context.Context, executionID string) (map[string]any, error) {
	var snapshot map[string]any
	err := c.doJSON(ctx, http.MethodGet, "/v1/executions/"+url.PathEscape(executionID), nil, "", &snapshot)
	return snapshot, err
}

func (c *Client) Result(ctx context.Context, executionID string) (map[string]any, error) {
	var result map[string]any
	err := c.doJSON(ctx, http.MethodGet, "/v1/executions/"+url.PathEscape(executionID)+"/result", nil, "", &result)
	return result, err
}

func (c *Client) Cancel(ctx context.Context, executionID string) error {
	return c.doJSON(ctx, http.MethodPost, "/v1/executions/"+url.PathEscape(executionID)+"/cancel", nil, "", nil)
}

func (c *Client) Events(ctx context.Context, executionID string, after int) (<-chan Event, <-chan error) {
	events := make(chan Event)
	errorsCh := make(chan error, 1)
	go func() {
		defer close(events)
		defer close(errorsCh)
		path := "/v1/executions/" + url.PathEscape(executionID) + "/events?after=" + strconv.Itoa(after)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.resolve(path), nil)
		if err != nil {
			errorsCh <- err
			return
		}
		req.Header.Set("Accept", "text/event-stream")
		response, err := c.httpClient.Do(req)
		if err != nil {
			errorsCh <- err
			return
		}
		defer response.Body.Close()
		if response.StatusCode/100 != 2 {
			errorsCh <- fmt.Errorf("model runtime returned status %d", response.StatusCode)
			return
		}
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		var data strings.Builder
		flush := func() error {
			if data.Len() == 0 {
				return nil
			}
			raw := []byte(data.String())
			var event Event
			if err := json.Unmarshal(raw, &event); err != nil {
				return fmt.Errorf("decode runtime event: %w", err)
			}
			event.Raw = append(json.RawMessage(nil), raw...)
			select {
			case events <- event:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				if err := flush(); err != nil {
					errorsCh <- err
					return
				}
				data.Reset()
				continue
			}
			if strings.HasPrefix(line, "data: ") {
				if data.Len() > 0 {
					data.WriteByte('\n')
				}
				data.WriteString(strings.TrimPrefix(line, "data: "))
			}
		}
		if err := scanner.Err(); err != nil {
			errorsCh <- err
			return
		}
		if err := flush(); err != nil {
			errorsCh <- err
		}
	}()
	return events, errorsCh
}

func (c *Client) doJSON(ctx context.Context, method, path string, input any, idempotencyKey string, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.resolve(path), body)
	if err != nil {
		return err
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", idempotencyKey)
	}
	response, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode/100 != 2 {
		return fmt.Errorf("model runtime returned status %d", response.StatusCode)
	}
	if output == nil {
		_, err = io.Copy(io.Discard, response.Body)
		return err
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil {
		return err
	}
	if len(payload) > 4<<20 {
		return errors.New("model runtime response exceeds 4 MiB")
	}
	return json.Unmarshal(payload, output)
}

func (c *Client) resolve(path string) string {
	return strings.TrimRight(c.baseURL.String(), "/") + path
}
