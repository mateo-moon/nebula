package imagestore

import (
	"bytes"
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/sys/unix"
)

const registryHostsName = "hosts.toml"

var registryAuthorityRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.svc:8084$`)

// ValidateRegistryAuthority accepts exactly one canonical Kubernetes Service
// authority. No scheme, path, IP, default registry, alternate port or alias is
// interpreted here.
func ValidateRegistryAuthority(authority string) error {
	if !registryAuthorityRE.MatchString(authority) {
		return errors.New("image store registry authority must be a canonical Service on port 8084")
	}
	return nil
}

func registryClusterIP(value string) (string, error) {
	ip, err := netip.ParseAddr(value)
	if err != nil || ip.Zone() != "" || ip.Is4In6() || ip.String() != value || !ip.IsPrivate() || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return "", errors.New("image store Service must have a canonical private non-loopback ClusterIP")
	}
	return ip.String(), nil
}

func registryHostsBytes(authority, ip string) []byte {
	// Root capabilities are explicit: an omitted root capability list would
	// grant containerd's fallback endpoint push/referrers as well as reads.
	return []byte("# Nebula image store registry hosts v1\n# authority: " + authority + "\nserver = \"http://" + net.JoinHostPort(ip, "8084") + "\"\ncapabilities = [\"pull\", \"resolve\"]\n")
}

// openRegistryHostsDirectory follows no symlink, including ancestor components.
// The SDK mounts only this authority's host directory into the one-shot init;
// the ordinary long-running operator never receives that mount.
func openRegistryHostsDirectory(directory string) (*os.File, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || directory == "/" || len(directory) > 1024 || strings.ContainsAny(directory, "\x00\r\n\\") {
		return nil, errors.New("registry hosts directory must be an existing normalized absolute directory")
	}
	for _, value := range directory {
		if value < 32 || value == 127 {
			return nil, errors.New("registry hosts directory cannot contain control characters")
		}
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, errors.New("cannot open registry hosts directory")
	}
	for _, part := range strings.Split(strings.TrimPrefix(directory, "/"), "/") {
		next, openErr := unix.Openat(fd, part, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if openErr != nil {
			return nil, errors.New("registry hosts directory cannot contain symlinks or missing components")
		}
		fd = next
	}
	file := os.NewFile(uintptr(fd), directory)
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Uid != uint32(os.Geteuid()) || stat.Mode&0022 != 0 {
		file.Close()
		return nil, errors.New("registry hosts directory must be owned by this init user and not group/world writable")
	}
	return file, nil
}

func registryHostsEntries(directory *os.File, pending string) error {
	if _, err := directory.Seek(0, io.SeekStart); err != nil {
		return errors.New("cannot inspect registry hosts directory")
	}
	names, err := directory.Readdirnames(3)
	if err != nil && err != io.EOF {
		return errors.New("cannot inspect registry hosts directory")
	}
	for _, name := range names {
		if name != registryHostsName && (pending == "" || name != pending) {
			return errors.New("registry hosts directory contains an unrecognized file")
		}
	}
	if len(names) > 2 || (pending == "" && len(names) > 1) {
		return errors.New("registry hosts directory contains unrecognized files")
	}
	return nil
}

func readRegistryHosts(directory *os.File, authority string) ([]byte, error) {
	fd, err := unix.Openat(int(directory.Fd()), registryHostsName, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("cannot read managed registry hosts file")
	}
	f := os.NewFile(uintptr(fd), registryHostsName)
	defer f.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil || stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != uint32(os.Geteuid()) || stat.Nlink != 1 || stat.Mode&07777 != 0644 || stat.Size < 1 || stat.Size > 4096 {
		return nil, errors.New("existing registry hosts file is not an owned regular managed file")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(raw) > 4096 {
		return nil, errors.New("cannot read bounded managed registry hosts file")
	}
	prefix := "# Nebula image store registry hosts v1\n# authority: " + authority + "\nserver = \"http://"
	suffix := "\"\ncapabilities = [\"pull\", \"resolve\"]\n"
	if !bytes.HasPrefix(raw, []byte(prefix)) || !bytes.HasSuffix(raw, []byte(suffix)) {
		return nil, errors.New("existing registry hosts file is not managed for this authority")
	}
	endpoint := strings.TrimSuffix(strings.TrimPrefix(string(raw), prefix), suffix)
	ip, port, err := net.SplitHostPort(endpoint)
	if err != nil || port != "8084" {
		return nil, errors.New("existing registry hosts endpoint is invalid")
	}
	ip, err = registryClusterIP(ip)
	if err != nil || !bytes.Equal(raw, registryHostsBytes(authority, ip)) {
		return nil, errors.New("existing registry hosts file is not a recognized exact configuration")
	}
	return raw, nil
}

// ConfigureRegistryHosts is an explicit one-shot mode of the same operator
// binary. Its only input IP is the native Service environment variable supplied
// by main. It performs no API call, credential read, chown or daemon restart.
func ConfigureRegistryHosts(authority, clusterIP, directory string) error {
	if err := ValidateRegistryAuthority(authority); err != nil {
		return err
	}
	// The fixed native environment name belongs to this exact Service name.
	if !strings.HasPrefix(authority, "confidential-operator-images.") {
		return errors.New("registry hosts init requires the default image store Service")
	}
	ip, err := registryClusterIP(clusterIP)
	if err != nil {
		return err
	}
	dir, err := openRegistryHostsDirectory(directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	if err := unix.Flock(int(dir.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return errors.New("registry hosts directory is already being configured")
	}
	defer unix.Flock(int(dir.Fd()), unix.LOCK_UN)
	if err := registryHostsEntries(dir, ""); err != nil {
		return err
	}
	previous, err := readRegistryHosts(dir, authority)
	if err != nil {
		return err
	}
	wanted := registryHostsBytes(authority, ip)
	if bytes.Equal(previous, wanted) {
		return nil
	}
	id, err := identifier()
	if err != nil {
		return errors.New("cannot create registry hosts transaction")
	}
	pending := ".nebula-hosts-" + id + ".tmp"
	fd, err := unix.Openat(int(dir.Fd()), pending, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return errors.New("cannot create registry hosts transaction")
	}
	defer unix.Unlinkat(int(dir.Fd()), pending, 0)
	f := os.NewFile(uintptr(fd), pending)
	if _, err := f.Write(wanted); err != nil {
		f.Close()
		return errors.New("cannot write registry hosts transaction")
	}
	if err := f.Chmod(0644); err != nil {
		f.Close()
		return errors.New("cannot set registry hosts permissions")
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return errors.New("cannot sync registry hosts transaction")
	}
	if err := f.Close(); err != nil {
		return errors.New("cannot close registry hosts transaction")
	}
	if err := registryHostsEntries(dir, pending); err != nil {
		return err
	}
	current, err := readRegistryHosts(dir, authority)
	if err != nil || !bytes.Equal(current, previous) {
		return errors.New("registry hosts file changed during configuration")
	}
	if err := unix.Renameat(int(dir.Fd()), pending, int(dir.Fd()), registryHostsName); err != nil {
		return errors.New("cannot commit registry hosts transaction")
	}
	if err := dir.Sync(); err != nil {
		return errors.New("cannot sync registry hosts directory")
	}
	return nil
}
