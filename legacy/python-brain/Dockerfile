# ---------- Stage 1: builder ----------
FROM python:3.12-slim AS builder
WORKDIR /app
COPY pyproject.toml .
RUN pip install --no-cache-dir ".[pii,llm,telegram]" \
    && python -m spacy download en_core_web_sm

# ---------- Stage 2: runtime ----------
FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
ARG DINA_VERSION=dev
COPY src/ /app/src/
COPY config/ /app/config/
RUN echo "${DINA_VERSION}" > /app/VERSION
EXPOSE 8200
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8200"]
