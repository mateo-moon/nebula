/** The application broker is a private Unix stream protocol, not HTTP. Keep
 * this example bounded and byte-oriented; resource contents must not be logged. */
export function resourceReadExample(resourceId: string): string {
  return `import socket
import struct
import time

RESOURCE_ID = ${JSON.stringify(resourceId)}
SOCKET_PATH = "/run/nebula-resources/resource.sock"
MAX_BYTES = 2 * 1024 * 1024
deadline = time.monotonic() + 65

def remaining():
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError("Resource request timed out")
    return seconds

def read_exact(stream, length):
    result = bytearray()
    while len(result) < length:
        stream.settimeout(remaining())
        chunk = stream.recv(length - len(result))
        if not chunk:
            raise RuntimeError("Resource denied, unavailable, or incomplete")
        result.extend(chunk)
    return bytes(result)

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
    stream.settimeout(remaining())
    stream.connect(SOCKET_PATH)
    stream.settimeout(remaining())
    stream.sendall(b"GET " + RESOURCE_ID.encode("ascii") + b"\\n")
    length = struct.unpack(">I", read_exact(stream, 4))[0]
    if not 0 < length <= MAX_BYTES:
        raise RuntimeError("Invalid resource length")
    resource = read_exact(stream, length)

# Use resource as raw bytes in your application. Do not print or log it.`;
}
