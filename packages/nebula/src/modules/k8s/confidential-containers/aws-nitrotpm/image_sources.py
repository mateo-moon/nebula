"""Public source pins shared by release builds and the retained prototype."""
BASE_REVISION = "4570f0ec8c9217f77c81ed79cb4200cbf9e40912"
CAA_REVISION = "e3e0f00480b41c08e3e4dbc6b64aba7722fb65f9"
BASE_DESCRIPTION = "kiwi-image-descriptions-examples/al2023/attestable-image-example"
MASKS = ["sshd.service", "ssh.service", "amazon-ssm-agent.service", "cloud-init.service", "cloud-config.service",
         "cloud-final.service", "getty@.service", "serial-getty@.service", "debug-shell.service", "rescue.service",
         "emergency.service", "systemd-coredump@.service", "systemd-zram-setup@.service", "systemd-hibernate.service",
         "process-user-data.service", "process-user-data.path", "scratch-storage.service", "scratch-storage.path",
         "api-server-rest.service", "api-server-rest.path"]
