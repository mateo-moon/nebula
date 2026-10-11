// A narrow mount.fuse dispatcher for the module's Nydus proxy snapshotter.
// It grants no privileges and never receives workload keys. Existing system
// mount.fuse installations are preserved by the node-side lifecycle helper.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const helper = "/opt/kata/nydus-for-kata-tee/nydus-overlayfs"

func mountArgs(args []string) ([]string, error) {
	invalid := errors.New("unsupported mount request")
	if len(args) < 4 || args[0] != "overlay" || !filepath.IsAbs(args[1]) {
		return nil, invalid
	}
	var options []string
	typed := false
	for i := 2; i < len(args); i += 2 {
		if i+1 >= len(args) || strings.ContainsRune(args[i+1], 0) {
			return nil, invalid
		}
		switch args[i] {
		case "-t":
			if typed || args[i+1] != helper {
				return nil, invalid
			}
			typed = true
		case "-o":
			options = append(options, args[i+1])
		default:
			return nil, invalid
		}
	}
	if !typed || strings.ContainsRune(args[1], 0) {
		return nil, invalid
	}
	result := []string{helper, args[0], args[1]}
	if len(options) > 0 {
		// Match mount.fuse's option aggregation. Nydus itself consumes its
		// metadata options and performs the temporary host overlay mount.
		result = append(result, "-o", strings.Join(options, ","))
	}
	return result, nil
}

func main() {
	args, err := mountArgs(os.Args[1:])
	if err == nil && os.Geteuid() == 0 {
		err = syscall.Exec(helper, args, os.Environ())
	}
	// Mount options can contain encoded transport metadata; never log them.
	fmt.Fprintln(os.Stderr, "NEBULA_MOUNT_HELPER_FAILED")
	os.Exit(1)
}
