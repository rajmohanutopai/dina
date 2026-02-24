FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir .

# No long-running process — used for test invocations via docker exec.
CMD ["sleep", "infinity"]
