# Dina — build, test, run targets

.PHONY: build test lint run docker-up docker-down clean check-tests test-integration generate check-generate

# --- Build ---
build:
	cd core && go build ./...
	cd brain && pip install -e .

# --- Test ---
test:
	cd core && go test ./...
	cd brain && pytest tests/ -m 'not legacy'

# --- Lint ---
lint:
	cd core && go vet ./...
	cd brain && ruff check src/ tests/

# --- Run (local, no Docker) ---
run:
	@echo "Start core and brain in separate terminals:"
	@echo "  Terminal 1: cd core && go run ./cmd/core"
	@echo "  Terminal 2: cd brain && uvicorn dina_brain.main:app --port 8200"

# --- Docker ---
docker-up:
	docker compose up --build -d

docker-down:
	docker compose down

docker-dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# --- Integration Tests (Docker) ---
test-integration:
	./install.sh
	docker compose -f docker-compose.test.yml up --build -d
	DINA_INTEGRATION=docker python -m pytest tests/integration/ -v --tb=short; \
	EXIT_CODE=$$?; \
	docker compose -f docker-compose.test.yml down -v; \
	exit $$EXIT_CODE

# --- Test Traceability ---
check-tests:
	python scripts/verify_tests.py

# --- OpenAPI codegen ---
generate:
	python3 scripts/bundle_openapi.py
	$(HOME)/go/bin/oapi-codegen -config api/oapi-codegen.yaml -o core/internal/gen/core_types.gen.go api/core-api.bundled.yaml
	$(HOME)/go/bin/oapi-codegen -config api/oapi-brain-codegen.yaml -o core/internal/gen/brainapi/brain_types.gen.go api/brain-api.yaml
	datamodel-codegen --input api/core-api.bundled.yaml --output brain/src/gen/core_types.py --output-model-type pydantic_v2.BaseModel --snake-case-field --target-python-version 3.11
	@echo "Generated: core/internal/gen/core_types.gen.go (Go Core API types)"
	@echo "Generated: core/internal/gen/brainapi/brain_types.gen.go (Go Brain client types)"
	@echo "Generated: brain/src/gen/core_types.py (Python Core client types)"

# --- CI drift gate: verify generated code matches spec ---
check-generate: generate
	@git diff --ignore-matching-lines='timestamp:' --ignore-matching-lines='version:' --exit-code core/internal/gen/ brain/src/gen/ || \
		(echo "ERROR: Generated code is out of date. Run 'make generate' and commit." && exit 1)

# --- Clean ---
clean:
	cd core && go clean ./...
	rm -rf brain/src/*.egg-info
