// Package main implements the Piraeus EBS-credential Composition Function.
package main

import (
	"github.com/alecthomas/kong"
	"github.com/crossplane/function-sdk-go"
)

type cli struct {
	Debug bool `help:"Emit debug logs." short:"d"`

	Network            string `default:"tcp" help:"Network on which to listen for gRPC connections."`
	Address            string `default:":9443" help:"Address at which to listen for gRPC connections."`
	TLSCertsDir        string `env:"TLS_SERVER_CERTS_DIR" help:"Directory containing tls.key, tls.crt, and ca.crt."`
	Insecure           bool   `help:"Run without mTLS credentials."`
	MaxRecvMessageSize int    `default:"4" help:"Maximum received message size in MB."`
}

func (c *cli) Run() error {
	log, err := function.NewLogger(c.Debug)
	if err != nil {
		return err
	}

	return function.Serve(&Function{log: log},
		function.Listen(c.Network, c.Address),
		function.MTLSCertificates(c.TLSCertsDir),
		function.Insecure(c.Insecure),
		function.MaxRecvMessageSize(c.MaxRecvMessageSize*1024*1024))
}

func main() {
	ctx := kong.Parse(&cli{}, kong.Description("Provision a least-privilege static AWS credential for LINSTOR EBS remotes."))
	ctx.FatalIfErrorf(ctx.Run())
}
