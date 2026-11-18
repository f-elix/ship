.PHONY: build lint test fmt fmt-check
VERSION := 1.0

build:
	go build ./...

lint: build
	golangci-lint run

test:
	go test ./...

fmt:
	gofmt -w .

fmt-check:
	test -z "$$(gofmt -l .)"

%.out: %.in
	cp $< $@
