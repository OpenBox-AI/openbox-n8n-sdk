@echo off
echo ========================================
echo OpenBox n8n Integration - Quick Start
echo ========================================
echo.

REM Check if .env exists
if not exist ".env" (
    echo Creating .env file from template...
    copy .env.example .env
    echo Done!
    echo.
)

REM Tear down any existing stack (clean slate)
echo Tearing down existing stack (clean slate)...
docker compose down -v
echo.

REM Start without seed/guardrails (standalone mode)
echo Starting Docker containers (standalone mode, no seed/guardrails)...
echo This will take 5-10 minutes on first run (building images)
echo.
docker compose up -d --scale seed=0 --scale guardrails=0

if errorlevel 1 (
    echo ERROR: docker compose up failed. Check logs with: docker compose logs
    pause
    exit /b 1
)

REM Seed the demo schema
echo.
echo Seeding demo schema (customers + triage_events)...
docker compose exec -T postgres psql -U n8n -d n8n < seed\init-demo-schema.sql
if errorlevel 1 (
    echo WARNING: Schema seed failed - check seed\init-demo-schema.sql
) else (
    echo Demo schema seeded OK
)

REM Import the Demo Postgres credential
echo.
echo Importing Demo Postgres credential...
docker compose run --rm --entrypoint="" -v "%CD%\demo-data\credentials:/demo-data/credentials" n8n-import n8n import:credentials --input=/demo-data/credentials/postgres.json
if errorlevel 1 (
    echo WARNING: Credential import failed - workflows may need manual credential setup
) else (
    echo Postgres credential imported OK
)

echo.
echo Waiting for n8n to be ready...
timeout /t 30 /nobreak > nul

echo.
echo ========================================
echo SUCCESS! n8n is starting up
echo ========================================
echo.
echo Access n8n at: http://localhost:5678
echo.
echo Opening browser...
start http://localhost:5678
echo.
echo View logs with: docker compose logs -f n8n
echo Stop with:      docker compose down -v
echo.
pause
