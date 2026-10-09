"""Package ordinary Python modules into a private, temporary remote zipapp.

The archive contains code only. Requests stay on stdin, never in process arguments.
No sources are concatenated or extracted into the host's module search path.
"""

import base64
import io
import zipfile
from pathlib import Path

HOST_MODULES = ("models.py", "runtime.py", "validation.py", "installer.py", "uefi.py", "host.py")


def build_agent(directory: Path = Path(__file__).parent) -> str:
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name in HOST_MODULES:
            bundle.writestr(name, (directory / name).read_bytes())
        bundle.writestr("__main__.py", "from host import main\nmain()\n")
    encoded = base64.b64encode(archive.getvalue()).decode("ascii")
    return f"""import base64, os, pathlib, runpy, tempfile
os.umask(0o077)
with tempfile.TemporaryDirectory(prefix='nebula-agent-') as directory:
    archive = pathlib.Path(directory) / 'agent.pyz'
    archive.write_bytes(base64.b64decode({encoded!r}))
    runpy.run_path(str(archive), run_name='__main__')
"""
