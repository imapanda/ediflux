// Command connectors is the Libredi service for outbound and polling transports.
// For now it only exposes /healthz.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/imapanda/libredi/services/connectors/internal/config"
	"github.com/imapanda/libredi/services/connectors/internal/server"
)

const service = "connectors"

func main() {
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdout))
}

// run returns the process exit code: 0 on success, 1 on failure, 2 on bad configuration.
//
//	connectors healthcheck   probes the local /healthz (container HEALTHCHECK)
//	connectors               serves until SIGTERM or SIGINT, then drains and exits
func run(args []string, getenv func(string) string, stdout io.Writer) int {
	logger := slog.New(slog.NewJSONHandler(stdout, nil))

	port, err := config.PortFromEnv(getenv)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		return 2
	}

	if len(args) > 0 && args[0] == "healthcheck" {
		if err := server.Check(context.Background(), fmt.Sprintf("http://127.0.0.1:%d/healthz", port)); err != nil {
			logger.Error("health check failed", "error", err)
			return 1
		}
		return 0
	}

	// Every interface: inside a container the port is only reachable through the proxy.
	listener, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		logger.Error("cannot listen", "port", port, "error", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	// Restore the default signal behaviour as soon as shutdown starts: a second SIGTERM or
	// Ctrl-C then ends the process at once instead of being swallowed during the drain.
	context.AfterFunc(ctx, stop)

	logger.Info("listening", "service", service, "port", port)
	if err := server.Serve(ctx, listener, server.New(service), 10*time.Second); err != nil {
		logger.Error("server stopped with an error", "error", err)
		return 1
	}
	logger.Info("shut down", "service", service)
	return 0
}
