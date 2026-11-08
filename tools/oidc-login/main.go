package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/int128/kubelogin/pkg/cmd"
	"github.com/int128/kubelogin/pkg/di"
	"github.com/int128/kubelogin/pkg/infrastructure/browser"
	"github.com/int128/kubelogin/pkg/infrastructure/clock"
	"github.com/int128/kubelogin/pkg/usecases/credentialplugin"
	"github.com/spf13/pflag"
)

const upstreamVersion = "v1.36.4"

var version = "development"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args, os.Stdin, os.Stdout, os.Stderr, &browser.Browser{}))
}

// Run the pinned upstream CLI in this process. The secret enters only its
// logical argument slice; os.Args, process argv and the environment are unchanged.
func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer, browserClient browser.Interface) int {
	if len(args) == 2 && args[1] == "version" {
		fmt.Fprintf(stdout, "nebula-oidc-login %s (int128/kubelogin %s)\n", version, upstreamVersion)
		return 0
	}
	publicArgs, filename, issuer, clientID, err := publicArguments(args)
	if err != nil {
		fmt.Fprintln(stderr, "OIDC login requires get-token, an issuer/client ID and a protected --oidc-client-secret-file; use authcode with S256.")
		return 1
	}
	credential, err := readCredential(filename, issuer, clientID)
	if err != nil {
		fmt.Fprintln(stderr, "OIDC client credential file is missing, unsafe, expired or does not match this issuer/client. Provision the protected file before signing in.")
		return 1
	}
	if !credential.expiry.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, credential.expiry)
		defer cancel()
	}
	// The upstream command uses Cobra.SetArgs. Do not replace this with exec or
	// os.Args assignment: that would expose the credential to other processes.
	logicalArgs := append(publicArgs, "--oidc-client-secret="+credential.ClientSecret)
	var upstream cmd.Interface = di.NewCmdForHeadless(&clock.Real{}, stdin, stdout, &safeLogger{out: stderr}, browserClient)
	command, ok := upstream.(*cmd.Cmd)
	if !ok {
		fmt.Fprintln(stderr, "Unsupported pinned OIDC command wiring.")
		return 1
	}
	plugin, ok := command.GetToken.GetToken.(*credentialplugin.GetToken)
	if !ok {
		fmt.Fprintln(stderr, "Unsupported pinned OIDC token wiring.")
		return 1
	}
	plugin.TokenCacheRepository = canonicalRepository{base: plugin.TokenCacheRepository}
	return upstream.Run(ctx, logicalArgs, upstreamVersion)
}

func publicArguments(args []string) ([]string, string, string, string, error) {
	invalid := fmt.Errorf("invalid public login arguments")
	if len(args) < 2 || args[1] != "get-token" {
		return nil, "", "", "", invalid
	}
	result := append([]string(nil), args[:2]...)
	values := make(map[string]string)
	for i := 2; i < len(args); i++ {
		arg := args[i]
		key, value, hasValue := strings.Cut(arg, "=")
		if key == "--oidc-client-secret" || key == "--oidc-use-access-token" || key == "--insecure-skip-tls-verify" || arg == "--" {
			return nil, "", "", "", invalid
		}
		switch key {
		case "--oidc-auth-request-extra-params":
			if !hasValue {
				i++
				if i >= len(args) {
					return nil, "", "", "", invalid
				}
				value = args[i]
			}
			var params map[string]string
			flags := pflag.NewFlagSet("extra", pflag.ContinueOnError)
			flags.SetOutput(io.Discard)
			flags.StringToStringVar(&params, "extra", nil, "")
			if flags.Set("extra", value) != nil {
				return nil, "", "", "", invalid
			}
			for _, reserved := range []string{"client_id", "client_secret", "response_type", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "request", "request_uri"} {
				if _, exists := params[reserved]; exists {
					return nil, "", "", "", invalid
				}
			}
			result = append(result, key+"="+value)
		case "--oidc-client-secret-file", "--oidc-issuer-url", "--oidc-client-id", "--grant-type", "--oidc-pkce-method":
			if _, duplicate := values[key]; duplicate {
				return nil, "", "", "", invalid
			}
			if !hasValue {
				i++
				if i >= len(args) || strings.HasPrefix(args[i], "--") {
					return nil, "", "", "", invalid
				}
				value = args[i]
			}
			if value == "" {
				return nil, "", "", "", invalid
			}
			values[key] = value
			if key != "--oidc-client-secret-file" {
				result = append(result, key+"="+value)
			}
		default:
			result = append(result, arg)
		}
	}
	if values["--oidc-client-secret-file"] == "" || values["--oidc-issuer-url"] == "" || values["--oidc-client-id"] == "" {
		return nil, "", "", "", invalid
	}
	for key, required := range map[string]string{"--grant-type": "authcode", "--oidc-pkce-method": "S256"} {
		if value := values[key]; value != "" && value != required {
			return nil, "", "", "", invalid
		} else if value == "" {
			result = append(result, key+"="+required)
		}
	}
	return result, values["--oidc-client-secret-file"], values["--oidc-issuer-url"], values["--oidc-client-id"], nil
}
