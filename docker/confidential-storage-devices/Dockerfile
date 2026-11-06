FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS build
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux GOARCH=amd64
WORKDIR /src
COPY packages/confidential-storage-devices/go.mod packages/confidential-storage-devices/go.sum ./
RUN go mod download && go mod verify
COPY packages/confidential-storage-devices/*.go ./
RUN go test -mod=readonly ./... \
 && go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w" -o /nebula-storage-devices .

FROM scratch
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
COPY --from=build /nebula-storage-devices /nebula-storage-devices
COPY packages/confidential-storage-devices/LICENSE /LICENSE
USER 0:0
EXPOSE 8080
ENTRYPOINT ["/nebula-storage-devices"]
