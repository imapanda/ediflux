package main

import (
	"context"
	"io"
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/imapanda/libredi/services/connectors/internal/server"
)

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port
}

func envWith(port int) func(string) string {
	return func(key string) string {
		if key == "PORT" {
			return strconv.Itoa(port)
		}
		return ""
	}
}

func TestHealthcheckSubcommand(t *testing.T) {
	t.Run("exits 1 when nothing listens", func(t *testing.T) {
		if code := run([]string{"healthcheck"}, envWith(freePort(t)), io.Discard); code != 1 {
			t.Fatalf("exit code = %d, want 1", code)
		}
	})

	t.Run("exits 0 when the service is up", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- server.Serve(ctx, listener, server.New(service), time.Second) }()
		defer func() { cancel(); <-done }()

		port := listener.Addr().(*net.TCPAddr).Port
		deadline := time.Now().Add(3 * time.Second)
		code := 1
		for time.Now().Before(deadline) && code != 0 {
			code = run([]string{"healthcheck"}, envWith(port), io.Discard)
			time.Sleep(20 * time.Millisecond)
		}
		if code != 0 {
			t.Fatalf("exit code = %d, want 0", code)
		}
	})
}

func TestRunRejectsAnInvalidPort(t *testing.T) {
	env := func(key string) string {
		if key == "PORT" {
			return "not-a-port"
		}
		return ""
	}
	if code := run(nil, env, io.Discard); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
}
