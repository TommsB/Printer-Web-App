@echo off
rem Starts (or rebuilds and restarts) the app in Docker on port 8000.
rem Don't run the backend directly with python/uvicorn as well: two servers on port 8000
rem with two different databases cause stale code and data that silently splits between them.
cd /d "%~dp0"
docker compose up -d --build
echo.
echo Printeri is running on http://localhost:8000
