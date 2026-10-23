package config

import "testing"

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestPortFromEnv(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		want    int
		wantErr bool
	}{
		{name: "missing defaults to 8080", env: nil, want: 8080},
		{name: "empty defaults to 8080", env: map[string]string{"PORT": ""}, want: 8080},
		{name: "lowest port", env: map[string]string{"PORT": "1"}, want: 1},
		{name: "highest port", env: map[string]string{"PORT": "65535"}, want: 65535},
		{name: "typical port", env: map[string]string{"PORT": "9090"}, want: 9090},
		{name: "zero is rejected", env: map[string]string{"PORT": "0"}, wantErr: true},
		{name: "too large is rejected", env: map[string]string{"PORT": "65536"}, wantErr: true},
		{name: "negative is rejected", env: map[string]string{"PORT": "-1"}, wantErr: true},
		{name: "text is rejected", env: map[string]string{"PORT": "http"}, wantErr: true},
		{name: "decimal is rejected", env: map[string]string{"PORT": "80.5"}, wantErr: true},
		{name: "padded is rejected", env: map[string]string{"PORT": " 80"}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := PortFromEnv(env(tt.env))
			if (err != nil) != tt.wantErr {
				t.Fatalf("PortFromEnv() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err == nil && got != tt.want {
				t.Fatalf("PortFromEnv() = %d, want %d", got, tt.want)
			}
		})
	}
}
