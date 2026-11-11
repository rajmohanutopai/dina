# Dina — build, test, run targets

.PHONY: build test lint typecheck run pipeline-up pipeline-down clean generate check-generate

PIPELINE_COMPOSE := docker/compose/pipeline.yml

# --- Build ---
build:
	npm run build

# --- Test ---
test:
	npm test

# --- Lint ---
lint:
	npm run lint

typecheck:
	npm run typecheck

# --- Run (local, no Docker) ---
run:
	@echo "Active TypeScript workspace:"
	@echo "  npm run build"
	@echo "  npm test"
	@echo "  apps/home-node-lite/install-lite.sh"

# --- Shared Infrastructure ---
pipeline-up:
	docker compose -f $(PIPELINE_COMPOSE) up --build -d

pipeline-down:
	docker compose -f $(PIPELINE_COMPOSE) down

# --- OpenAPI codegen ---
# The YAML specs in api/ generate TypeScript types in packages/protocol/src/gen/.
generate:
	npm run generate --silent

# --- CI drift gate: verify generated code matches spec ---
check-generate:
	npm run generate:check

# --- Clean ---
clean:
	npm run clean
