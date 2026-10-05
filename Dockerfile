# --- build the frontend ---
FROM node:24-slim AS frontend
WORKDIR /build
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- runtime: FastAPI + Net-SNMP command-line tools (Linux replacement for the .exe files) ---
FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends snmp \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY --from=frontend /build/dist frontend/dist

ENV SNMP_BIN_DIR="" \
    DB_PATH=/app/data/printers.db \
    TZ=Europe/Riga
WORKDIR /app/backend
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
