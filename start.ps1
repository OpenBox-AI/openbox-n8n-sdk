# OpenBox n8n Integration - Startup Script
# This script tears down any existing stack, spins up fresh, seeds the demo
# schema, and imports the Postgres credential.

Write-Host "🚀 OpenBox n8n Integration - Starting..." -ForegroundColor Cyan
Write-Host ""

# Check if Docker is running
Write-Host "📋 Checking prerequisites..." -ForegroundColor Yellow
try {
    docker ps > $null 2>&1
    Write-Host "✅ Docker is running" -ForegroundColor Green
} catch {
    Write-Host "❌ Docker is not running. Please start Docker Desktop first." -ForegroundColor Red
    exit 1
}

# Check if .env exists
if (-not (Test-Path ".env")) {
    Write-Host "📝 Creating .env file from template..." -ForegroundColor Yellow
    Copy-Item ".env.example" ".env"
    Write-Host "✅ .env file created" -ForegroundColor Green
} else {
    Write-Host "✅ .env file exists" -ForegroundColor Green
}

# Tear down any existing stack (removes volumes for a clean slate)
Write-Host ""
Write-Host "🛑 Tearing down existing stack (clean slate)..." -ForegroundColor Yellow
docker compose down -v 2>&1 | Out-Null
Write-Host "✅ Existing stack removed" -ForegroundColor Green

Write-Host ""
Write-Host "🐳 Starting Docker containers (no seed/guardrails - standalone mode)..." -ForegroundColor Cyan
Write-Host "   This will take 5-10 minutes on first run (building images)" -ForegroundColor Gray
Write-Host ""

# Ask user which setup they want
Write-Host "Choose your setup:" -ForegroundColor Yellow
Write-Host "  [1] Basic (Phases 1 + 2) - Custom nodes + Observability hooks" -ForegroundColor White
Write-Host "  [2] Full (Phases 1 + 2 + 3) - Includes governance proxy" -ForegroundColor White
Write-Host ""
$choice = Read-Host "Enter choice (1 or 2)"

if ($choice -eq "2") {
    Write-Host ""
    Write-Host "Starting with governance proxy..." -ForegroundColor Cyan
    docker compose --profile proxy up -d --scale seed=0 --scale guardrails=0
} else {
    Write-Host ""
    Write-Host "Starting basic setup..." -ForegroundColor Cyan
    docker compose up -d --scale seed=0 --scale guardrails=0
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ docker compose up failed. Check logs with: docker compose logs" -ForegroundColor Red
    exit 1
}

# Seed the demo schema into the n8n postgres container
Write-Host ""
Write-Host "🌱 Seeding demo schema (customers + triage_events)..." -ForegroundColor Yellow
Get-Content "seed/init-demo-schema.sql" | docker compose exec -T postgres psql -U n8n -d n8n
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Demo schema seeded" -ForegroundColor Green
} else {
    Write-Host "⚠️  Schema seed failed - check seed/init-demo-schema.sql" -ForegroundColor Red
}

# Import the Demo Postgres credential (id: u61urO4zdAMO6LAK)
Write-Host ""
Write-Host "🔑 Importing Demo Postgres credential..." -ForegroundColor Yellow
docker compose run --rm --entrypoint="" `
    -v "${PWD}/demo-data/credentials:/demo-data/credentials" `
    n8n-import n8n import:credentials --input=/demo-data/credentials/postgres.json
if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Postgres credential imported" -ForegroundColor Green
} else {
    Write-Host "⚠️  Credential import failed - workflows may need manual credential setup" -ForegroundColor Red
}

Write-Host ""
Write-Host "⏳ Waiting for services to be ready..." -ForegroundColor Yellow
Write-Host "   (This may take a few minutes)" -ForegroundColor Gray
Write-Host ""

# Wait for n8n to be ready
$maxAttempts = 60
$attempt = 0
$ready = $false

while (-not $ready -and $attempt -lt $maxAttempts) {
    $attempt++
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:5678" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 200) {
            $ready = $true
        }
    } catch {
        Write-Host "." -NoNewline -ForegroundColor Gray
        Start-Sleep -Seconds 5
    }
}

Write-Host ""
Write-Host ""

if ($ready) {
    Write-Host "✅ n8n is ready!" -ForegroundColor Green
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "🎉 SUCCESS! Your OpenBox n8n integration is running!" -ForegroundColor Green
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "📍 Access n8n at: " -NoNewline -ForegroundColor White
    Write-Host "http://localhost:5678" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "🔑 First-time setup:" -ForegroundColor Yellow
    Write-Host "   1. Create an owner account (any email/password)" -ForegroundColor White
    Write-Host "   2. Skip the personalization survey" -ForegroundColor White
    Write-Host "   3. You'll see 4 pre-imported demo workflows" -ForegroundColor White
    Write-Host ""
    Write-Host "🎨 What's new in n8n:" -ForegroundColor Yellow
    Write-Host "   ✅ 3 new OpenBox nodes (OpenBox, OpenBox: LLM, OpenBox Trigger)" -ForegroundColor Green
    Write-Host "   ✅ 1 new credential type (OpenBox API - auto-imported)" -ForegroundColor Green
    Write-Host "   ✅ 4 demo workflows ready to test" -ForegroundColor Green
    Write-Host "   ✅ 6 verdict outputs for visual branching" -ForegroundColor Green
    Write-Host "   ✅ External hooks capturing HTTP/DB spans" -ForegroundColor Green
    Write-Host ""
    Write-Host "🧪 Quick test:" -ForegroundColor Yellow
    Write-Host "   1. Go to Workflows → 'OpenBox Chat Demo'" -ForegroundColor White
    Write-Host "   2. Click 'Test workflow'" -ForegroundColor White
    Write-Host "   3. Type a message and send" -ForegroundColor White
    Write-Host "   4. Watch it go through OpenBox governance!" -ForegroundColor White
    Write-Host ""
    Write-Host "📊 View logs:" -ForegroundColor Yellow
    Write-Host "   docker compose logs -f n8n" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Stop the stack:" -ForegroundColor Yellow
    Write-Host "   docker compose down -v" -ForegroundColor Gray
    Write-Host ""
    Write-Host "📚 Full guide: QUICKSTART.md" -ForegroundColor Cyan
    Write-Host ""
    
    # Open browser
    Write-Host "Opening n8n in your browser..." -ForegroundColor Cyan
    Start-Process "http://localhost:5678"
    
} else {
    Write-Host "⚠️  Timeout waiting for n8n to start" -ForegroundColor Red
    Write-Host ""
    Write-Host "Check logs with: docker compose logs" -ForegroundColor Yellow
    Write-Host ""
}

Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
