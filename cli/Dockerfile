FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir .

# Install Hermes agent (optional — for --runner hermes support).
# Official installer: --skip-setup for headless, --no-venv to use system Python.
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --skip-setup --no-venv 2>/dev/null \
    || echo "WARNING: Hermes install failed — --runner hermes will not be available"

# No long-running process — used for test invocations via docker exec.
CMD ["sleep", "infinity"]
