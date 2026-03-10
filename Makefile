# Dina — build, test, run targets

.PHONY: build test lint run docker-up docker-down clean check-tests test-integration

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

# --- Clean ---
clean:
	cd core && go clean ./...
	rm -rf brain/src/*.egg-info
