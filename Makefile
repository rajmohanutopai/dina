# Dina — build, test, run targets

.PHONY: build test lint typecheck run legacy-build legacy-test legacy-lint legacy-run legacy-docker-up legacy-docker-down legacy-docker-dev pipeline-up pipeline-down clean check-tests test-integration generate check-generate

LEGACY_GO_CORE := legacy/go-core
LEGACY_PY_BRAIN := legacy/python-brain
LEGACY_COMPOSE := legacy/compose/docker-compose.yml
LEGACY_COMPOSE_DEV := legacy/compose/docker-compose.dev.yml
PIPELINE_COMPOSE := docker/compose/pipeline.yml

# --- Build ---
build:
	npm run build

legacy-build:
	cd $(LEGACY_GO_CORE) && go build ./...
	cd $(LEGACY_PY_BRAIN) && pip install -e .

# --- Test ---
test:
	npm test

legacy-test:
	cd $(LEGACY_GO_CORE) && go test ./...
	cd $(LEGACY_PY_BRAIN) && pytest tests/ -m 'not legacy'

# --- Lint ---
lint:
	npm run lint

typecheck:
	npm run typecheck

legacy-lint:
	cd $(LEGACY_GO_CORE) && go vet ./...
	cd $(LEGACY_PY_BRAIN) && ruff check src/ tests/

# --- Run (local, no Docker) ---
run:
	@echo "Active TypeScript workspace:"
	@echo "  npm run build"
	@echo "  npm test"
	@echo "  apps/home-node-lite/install-lite.sh"

legacy-run:
	@echo "Start core and brain in separate terminals:"
	@echo "  Terminal 1: cd $(LEGACY_GO_CORE) && go run ./cmd/dina-core"
	@echo "  Terminal 2: cd $(LEGACY_PY_BRAIN) && uvicorn src.main:app --port 8200"

# --- Legacy Docker ---
legacy-docker-up:
	docker compose -f $(LEGACY_COMPOSE) up --build -d

legacy-docker-down:
	docker compose -f $(LEGACY_COMPOSE) down

legacy-docker-dev:
	docker compose -f $(LEGACY_COMPOSE) -f $(LEGACY_COMPOSE_DEV) up --build

# --- Shared Infrastructure ---
pipeline-up:
	docker compose -f $(PIPELINE_COMPOSE) up --build -d

pipeline-down:
	docker compose -f $(PIPELINE_COMPOSE) down

# --- Integration Tests (Docker) ---
test-integration:
	legacy/bin/install.sh
	docker compose -f $(LEGACY_COMPOSE) up --build -d
	DINA_INTEGRATION=docker python -m pytest tests/integration/ -v --tb=short; \
	EXIT_CODE=$$?; \
	docker compose -f $(LEGACY_COMPOSE) down -v; \
	exit $$EXIT_CODE

# --- Test Traceability ---
check-tests:
	python scripts/verify_tests.py

# --- OpenAPI codegen ---
# Three codegen pipelines share the same YAML specs in api/:
#   Go  (oapi-codegen)       -> legacy/go-core/internal/gen/*       (Core + Brain-client types)
#   Python (datamodel-codegen) -> legacy/python-brain/src/gen/core_types.py (Brain's view of Core)
#   TypeScript (openapi-typescript) → packages/protocol/src/gen/*.d.ts (TS workspace view of both)
generate:
	python3 scripts/bundle_openapi.py
	$(HOME)/go/bin/oapi-codegen -config api/oapi-codegen.yaml -o $(LEGACY_GO_CORE)/internal/gen/core_types.gen.go api/core-api.bundled.yaml
	$(HOME)/go/bin/oapi-codegen -config api/oapi-brain-codegen.yaml -o $(LEGACY_GO_CORE)/internal/gen/brainapi/brain_types.gen.go api/brain-api.yaml
	datamodel-codegen --input api/core-api.bundled.yaml --output $(LEGACY_PY_BRAIN)/src/gen/core_types.py --output-model-type pydantic_v2.BaseModel --snake-case-field --target-python-version 3.11
	npm run generate --silent
	@echo "Generated: $(LEGACY_GO_CORE)/internal/gen/core_types.gen.go (Go Core API types)"
	@echo "Generated: $(LEGACY_GO_CORE)/internal/gen/brainapi/brain_types.gen.go (Go Brain client types)"
	@echo "Generated: $(LEGACY_PY_BRAIN)/src/gen/core_types.py (Python Core client types)"
	@echo "Generated: packages/protocol/src/gen/core-api.d.ts (TS Core API types)"
	@echo "Generated: packages/protocol/src/gen/brain-api.d.ts (TS Brain API types)"

# --- CI drift gate: verify generated code matches spec ---
# Covers all three codegen pipelines; any drift in any of them fails the gate.
check-generate: generate
	@git diff --ignore-matching-lines='timestamp:' --ignore-matching-lines='version:' --exit-code $(LEGACY_GO_CORE)/internal/gen/ $(LEGACY_PY_BRAIN)/src/gen/ packages/protocol/src/gen/ || \
		(echo "ERROR: Generated code is out of date. Run 'make generate' and commit." && exit 1)

# --- Clean ---
clean:
	npm run clean
	cd $(LEGACY_GO_CORE) && go clean ./...
	rm -rf $(LEGACY_PY_BRAIN)/src/*.egg-info
