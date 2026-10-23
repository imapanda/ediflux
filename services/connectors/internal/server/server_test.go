package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthz(t *testing.T) {
	handler := New("connectors")

	t.Run("GET answers 200 with the service name, uncached", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
			t.Fatalf("content-type = %q", got)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("cache-control = %q, want no-store", got)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body["status"] != "ok" || body["service"] != "connectors" || len(body) != 2 {
			t.Fatalf("body = %v", body)
		}
	})

	t.Run("query string is ignored", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz?probe=1", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
	})

	t.Run("HEAD has no body", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/healthz", nil))
		if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
			t.Fatalf("status = %d, body = %q", rec.Code, rec.Body.String())
		}
	})

	t.Run("other methods get 405 and an Allow header", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/healthz", nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want 405", rec.Code)
		}
		if got := rec.Header().Get("Allow"); got != "GET, HEAD" {
			t.Fatalf("allow = %q", got)
		}
	})

	t.Run("other paths get a 404 problem document", func(t *testing.T) {
		for _, path := range []string{"/", "/nope", "/healthz/", "/api/healthz"} {
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("%s: status = %d, want 404", path, rec.Code)
			}
			if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/problem+json") {
				t.Fatalf("%s: content-type = %q", path, got)
			}
			var problem map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
				t.Fatal(err)
			}
			if problem["status"] != float64(404) || problem["title"] != "Not Found" || problem["type"] != "about:blank" {
				t.Fatalf("%s: problem = %v", path, problem)
			}
		}
	})
}

func TestServeStopsGracefullyOnContextCancel(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + listener.Addr().String() + "/healthz"

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, listener, New("connectors"), 5*time.Second) }()

	t.Cleanup(cancel)

	if !waitFor(func() bool { return Check(context.Background(), url) == nil }) {
		t.Fatal("server never became healthy")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve() = %v, want nil after a graceful shutdown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve() did not return after the context was cancelled")
	}
	if Check(context.Background(), url) == nil {
		t.Fatal("server still answers after shutdown")
	}
}

func TestCheck(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer ok.Close()
	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer failing.Close()
	closed := httptest.NewServer(http.NotFoundHandler())
	closed.Close()

	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer redirecting.Close()

	if err := Check(context.Background(), ok.URL); err != nil {
		t.Errorf("Check() = %v for a 200 response", err)
	}
	if err := Check(context.Background(), failing.URL); err == nil || !strings.Contains(err.Error(), "500") {
		t.Errorf("Check() = %v for a 500 response, want an error naming the status", err)
	}
	if err := Check(context.Background(), closed.URL); err == nil {
		t.Error("Check() = nil for a closed server")
	}
	if err := Check(context.Background(), redirecting.URL); err == nil {
		t.Error("Check() = nil for a redirect, want a failure")
	}
}

func waitFor(condition func() bool) bool {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func TestServeLetsRequestsInFlightFinish(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, listener, handler, 5*time.Second) }()

	status := make(chan int, 1)
	go func() {
		resp, err := http.Get("http://" + listener.Addr().String() + "/")
		if err != nil {
			status <- -1
			return
		}
		_ = resp.Body.Close()
		status <- resp.StatusCode
	}()
	<-started

	cancel() // shutdown starts while the request is in flight
	select {
	case err := <-done:
		t.Fatalf("Serve() returned (%v) before the request in flight finished", err)
	case <-time.After(200 * time.Millisecond):
	}

	close(release)
	if got := <-status; got != http.StatusNoContent {
		t.Fatalf("request in flight got status %d, want 204", got)
	}
	if err := <-done; err != nil {
		t.Fatalf("Serve() = %v, want nil", err)
	}
}

func TestServeGivesUpAfterTheShutdownTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(started)
		<-release // never finishes on its own
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, listener, handler, 50*time.Millisecond) }()

	go func() { _, _ = http.Get("http://" + listener.Addr().String() + "/") }()
	<-started
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "graceful shutdown") {
			t.Fatalf("Serve() = %v, want a wrapped context.DeadlineExceeded", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Serve() did not give up after the shutdown timeout")
	}
}
