// Package config reads the service configuration from environment variables.
package config

import (
	"fmt"
	"strconv"
)

// DefaultPort is the port every Libredi service listens on inside its container.
const DefaultPort = 8080

// PortFromEnv returns the port from the PORT variable, or DefaultPort when it is unset.
func PortFromEnv(getenv func(string) string) (int, error) {
	raw := getenv("PORT")
	if raw == "" {
		return DefaultPort, nil
	}
	port, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || port == 0 {
		return 0, fmt.Errorf("PORT must be an integer between 1 and 65535, got %q", raw)
	}
	return int(port), nil
}
