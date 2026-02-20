# Dina — build, test, run targets

.PHONY: build test lint run docker-up docker-down clean check-tests

# --- Build ---
build:
	cd core && go build ./...
	cd brain && pip install -e .

# --- Test ---
test:
	cd core && go test ./...
	cd brain && pytest tests/

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

# --- Test Traceability ---
check-tests:
	python scripts/verify_tests.py

# --- Clean ---
clean:
	cd core && go clean ./...
	rm -rf brain/src/*.egg-info
