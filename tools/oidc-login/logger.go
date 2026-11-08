package main

import (
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/int128/kubelogin/pkg/infrastructure/logger"
	"github.com/spf13/pflag"
)

// Upstream's verbose logs can include HTTP bodies and tokens. Keep them off,
// including when a caller tries to add a logging flag. Never print raw errors.
type safeLogger struct{ out io.Writer }
type quietVerbose struct{}

func (*safeLogger) AddFlags(*pflag.FlagSet) {}
func (*safeLogger) V(int) logger.Verbose    { return quietVerbose{} }
func (*safeLogger) IsEnabled(int) bool      { return false }
func (quietVerbose) Infof(string, ...any)   {}

func (l *safeLogger) Printf(format string, args ...any) {
	if strings.Contains(format, "Please visit the following URL") && len(args) > 0 {
		if raw, ok := args[len(args)-1].(string); ok {
			u, err := url.Parse(raw)
			if err == nil && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1" || u.Hostname() == "localhost") &&
				u.User == nil && u.RawQuery == "" && u.Fragment == "" {
				fmt.Fprintf(l.out, "Open this local sign-in link in your browser: %s\n", u.String())
				return
			}
		}
	}
	message := fmt.Sprintf(format, args...)
	category := "authentication"
	for _, known := range []string{"client_secret is missing", "invalid_client", "invalid_grant", "context deadline exceeded", "could not verify the ID token", "nonce did not match"} {
		if strings.Contains(message, known) {
			category = known
			break
		}
	}
	fmt.Fprintf(l.out, "OIDC login failed (%s).\n", category)
}
