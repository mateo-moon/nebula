.PHONY: generate manifests test build envtest
CONTROLLER_GEN = go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.0

generate:
	$(CONTROLLER_GEN) object:headerFile=hack/boilerplate.go.txt paths=./api/...

# Preserve the existing structural schemas and CEL rules used by Nebula and
# the owner CLI. Do not generate a second, weaker schema for opaque Go specs.
manifests:
	pnpm exec tsx src/manifests.ts

test:
	go test -race ./...

build:
	CGO_ENABLED=0 go build -trimpath -o bin/manager ./cmd

envtest:
	CONFIDENTIAL_ENVTEST=1 go test -race ./internal/controller -run TestManager -count=1
