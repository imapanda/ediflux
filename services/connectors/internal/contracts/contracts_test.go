// Package contracts_test checks the service against the files in contracts/, through the Go code
// generated from them (internal/generated). If a contract changes shape and the code is not
// regenerated, the CI fails on the drift check; if it is regenerated and the service is not
// updated, this package no longer compiles or its tests fail.
package contracts_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/imapanda/libredi/services/connectors/internal/generated/api"
	"github.com/imapanda/libredi/services/connectors/internal/generated/jobs"
	"github.com/imapanda/libredi/services/connectors/internal/server"
)

// decode reads JSON into v and rejects properties the contract does not declare.
func decode(data []byte, v any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(v)
}

func TestHealthzIsAHealthDocument(t *testing.T) {
	rec := httptest.NewRecorder()
	server.New("connectors").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	var health api.Health
	if err := decode(rec.Body.Bytes(), &health); err != nil {
		t.Fatal(err)
	}
	if health.Status != api.HealthStatusOk || health.Service != "connectors" {
		t.Fatalf("health = %+v", health)
	}
}

func TestErrorsAreProblemDocuments(t *testing.T) {
	rec := httptest.NewRecorder()
	server.New("connectors").ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/missing", nil))

	var problem api.Problem
	if err := decode(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	if problem.Status != http.StatusNotFound || problem.Title == "" || problem.Type == "" {
		t.Fatalf("problem = %+v", problem)
	}
}

func TestJobEnvelope(t *testing.T) {
	example, err := os.ReadFile("../../../../contracts/jobs/examples/job-envelope.json")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("the contract example is a valid envelope", func(t *testing.T) {
		var envelope jobs.JobEnvelope
		if err := json.Unmarshal(example, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Type != "message.parse" || envelope.Version != 1 || envelope.Environment != jobs.JobEnvelopeEnvironmentTest {
			t.Fatalf("envelope = %+v", envelope)
		}
	})

	t.Run("a property that the contract requires cannot be missing", func(t *testing.T) {
		for _, field := range []string{"type", "version", "messageId", "environment", "enqueuedAt", "payload"} {
			var document map[string]any
			if err := json.Unmarshal(example, &document); err != nil {
				t.Fatal(err)
			}
			delete(document, field)
			data, _ := json.Marshal(document)
			var envelope jobs.JobEnvelope
			if err := json.Unmarshal(data, &envelope); err == nil {
				t.Errorf("an envelope without %s was accepted", field)
			}
		}
	})

	t.Run("an environment outside the contract is refused", func(t *testing.T) {
		var document map[string]any
		_ = json.Unmarshal(example, &document)
		document["environment"] = "staging"
		data, _ := json.Marshal(document)
		var envelope jobs.JobEnvelope
		if err := json.Unmarshal(data, &envelope); err == nil {
			t.Error("environment staging was accepted")
		}
	})
}
