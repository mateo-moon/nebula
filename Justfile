build:
	docker build --platform linux/amd64 -t qemu_machine .

run config:
	./run_qemu.sh {{ config }}
