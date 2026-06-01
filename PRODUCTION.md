# Production Deployment Guide

This guide covers production-hardening for the OpenBox n8n integration.

---

## 🔒 Security Checklist

### 1. **Secrets Management**

**CRITICAL:** The default docker-compose.yml uses example-only secrets. Replace these before production:

```bash
# Generate strong secrets
export N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
export N8N_USER_MANAGEMENT_JWT_SECRET=$(openssl rand -hex 32)
export POSTGRES_PASSWORD=$(openssl rand -base64 32)
export OPENBOX_API_KEY="obx_live_YOUR_PRODUCTION_KEY"
```

**Never commit these to git.** Use:
- Environment variables
- `.env` file (add to `.gitignore`)
- Secret management service (AWS Secrets Manager, HashiCorp Vault, etc.)

### 2. **Credential Encryption**

The `OpenBoxApi` credential stores API keys encrypted at rest using `N8N_ENCRYPTION_KEY`. If this key changes, existing credentials become unreadable.

**Backup strategy:**
```bash
# Before key rotation
docker exec n8n n8n export:credentials --output=/backup/credentials.json

# After key rotation
docker exec n8n n8n import:credentials --input=/backup/credentials.json
```

### 3. **HTTPS Enforcement**

The `OpenBoxApi` credential enforces HTTPS by default. Only disable for local development:

```typescript
// In credential settings
enforceHttps: true  // REQUIRED for production
```

### 4. **Webhook Signature Verification**

The `OpenBoxTrigger` node verifies HMAC-SHA256 signatures. Set `webhookSecret` in the credential and configure the same secret in OpenBox Core:

```bash
export OPENBOX_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

**Never set `signatureMode: 'disabled'` in production.**

---

## ⚡ Performance Optimization

### 1. **Hooks Concurrency Limiting**

The external hooks module bounds concurrent OpenBox API calls to prevent memory exhaustion:

```javascript
// openbox-hooks-transport.js
const MAX_INFLIGHT = 10;  // Tune based on your Core capacity
```

If Core is frequently unreachable, spans are **dropped** (not queued) to prevent OOM.

### 2. **Timeout Configuration**

All HTTP calls to OpenBox Core have timeouts:

| Component | Default | Environment Variable |
|-----------|---------|---------------------|
| Custom nodes | 35s | `timeoutMs` in credential |
| External hooks | 5s | Hardcoded in `openbox-hooks-transport.js` |
| Governance proxy | 5s | `OPENBOX_PROXY_TIMEOUT_MS` |

**Recommendation:** Keep hooks timeout < node timeout to avoid cascading failures.

### 3. **Database Connection Pooling**

n8n uses `pg` with default pooling. For high-throughput workflows:

```yaml
# docker-compose.yml
environment:
  DB_POSTGRESDB_POOL_SIZE: 20  # Default: 2
```

### 4. **Resource Limits**

Set Docker resource limits to prevent runaway processes:

```yaml
services:
  n8n:
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 4G
        reservations:
          cpus: '1.0'
          memory: 2G
```

---

## 🛡️ Fail-Safe Mechanisms

### 1. **Fail-Closed vs Fail-Open**

**Custom nodes (Phase 1):**
```typescript
// In OpenBoxApi credential
failPolicy: 'fail_closed'  // Recommended for production
// Workflow FAILS if OpenBox is unreachable
```

**External hooks (Phase 2):**
- Hooks are **best-effort observability**
- If Core is unreachable, spans are dropped silently
- Workflow continues regardless

**Governance proxy (Phase 3):**
```bash
OPENBOX_PROXY_FAIL_OPEN=false  # Recommended for production
# Blocks all requests if OpenBox is unreachable
```

### 2. **Circuit Breaker Pattern**

Not currently implemented. If Core has sustained downtime, consider:
- Temporarily disabling hooks: `OPENBOX_HOOKS_ENABLED=false`
- Disabling proxy profile: `docker compose up` (without `--profile proxy`)

### 3. **Graceful Degradation**

The hooks module degrades gracefully:
- If `pg` is not installed → DB span capture skips silently
- If `diagnostics_channel` is unavailable (Node.js <18) → HTTP span capture skips
- If `OPENBOX_API_URL` is unset → All hooks become no-ops

---

## 📊 Monitoring & Observability

### 1. **Logging Levels**

```yaml
# docker-compose.yml
environment:
  N8N_LOG_LEVEL: info              # n8n core (debug|info|warn|error)
  OPENBOX_HOOKS_DEBUG: 'false'     # External hooks verbose logging
  OPENBOX_PROXY_DEBUG: 'false'     # Proxy verbose logging
```

**Production recommendation:** `info` for n8n, `false` for debug flags.

### 2. **Health Checks**

All services have health checks:

```yaml
postgres:
  healthcheck:
    test: ['CMD-SHELL', 'pg_isready -U n8n -d n8n']
    interval: 5s
    timeout: 3s
    retries: 20

ollama:
  healthcheck:
    test: ['CMD-SHELL', 'ollama list >/dev/null 2>&1 || exit 1']
    interval: 10s
    timeout: 3s
    retries: 30
```

Monitor with:
```bash
docker compose ps
docker inspect --format='{{.State.Health.Status}}' n8n
```

### 3. **Metrics to Track**

- **n8n execution success rate** (via n8n API or database)
- **OpenBox verdict distribution** (from Core dashboard)
- **Proxy block rate** (from proxy logs: `grep "blocked by governance"`)
- **Hook span submission errors** (from hooks logs: `grep "dispatch failed"`)

---

## 🔄 Backup & Recovery

### 1. **Database Backups**

```bash
# Backup n8n database
docker exec postgres pg_dump -U n8n -d n8n > n8n-backup-$(date +%Y%m%d).sql

# Restore
docker exec -i postgres psql -U n8n -d n8n < n8n-backup-20260521.sql
```

### 2. **Workflow Export**

```bash
# Export all workflows
docker exec n8n n8n export:workflow --all --output=/backup/workflows.json

# Import
docker exec n8n n8n import:workflow --input=/backup/workflows.json
```

### 3. **Credential Export**

**WARNING:** Exported credentials are encrypted with `N8N_ENCRYPTION_KEY`. Keep backups of this key.

```bash
docker exec n8n n8n export:credentials --output=/backup/credentials.json
```

---

## 🚀 Deployment Strategies

### 1. **Blue-Green Deployment**

When updating the custom node:

```bash
# Build new version
docker compose build n8n

# Start new container (blue)
docker compose up -d --no-deps --scale n8n=2 n8n

# Verify health
curl http://localhost:5678/healthz

# Stop old container (green)
docker compose up -d --no-deps --scale n8n=1 n8n
```

### 2. **Rolling Updates**

For zero-downtime updates with multiple n8n replicas:

```yaml
services:
  n8n:
    deploy:
      replicas: 3
      update_config:
        parallelism: 1
        delay: 10s
        order: start-first
```

### 3. **Canary Releases**

Test new custom node versions with a subset of workflows:

1. Deploy new version to separate n8n instance
2. Duplicate critical workflows to canary instance
3. Monitor for 24-48 hours
4. Promote to production if stable

---

## 🐛 Troubleshooting

### Issue: "OpenBox credential is missing the API key"

**Cause:** Credential not attached to node or `apiKey` field empty.

**Fix:**
```typescript
// In node settings
credentials: [{ name: 'openBoxApi', required: true }]
```

### Issue: "Invalid webhook signature"

**Cause:** Mismatch between `webhookSecret` in credential and OpenBox Core config.

**Fix:**
1. Verify secret in OpenBox console: Settings → Webhooks
2. Update n8n credential to match
3. Test with: `curl -X POST -H "X-OpenBox-Signature: sha256=$(echo -n 'test' | openssl dgst -sha256 -hmac 'YOUR_SECRET' | cut -d' ' -f2)" ...`

### Issue: "Hooks loaded but inert"

**Cause:** `OPENBOX_API_URL` or `OPENBOX_API_KEY` not set.

**Fix:**
```yaml
# docker-compose.yml
environment:
  OPENBOX_API_URL: http://openbox-core-server:8086
  OPENBOX_API_KEY: ${OPENBOX_API_KEY}
```

### Issue: Proxy blocks all requests

**Cause:** OpenBox Core unreachable and `OPENBOX_PROXY_FAIL_OPEN=false`.

**Fix (temporary):**
```bash
# Restart without proxy
docker compose up -d  # Omit --profile proxy
```

**Fix (permanent):**
- Verify Core is reachable: `curl http://openbox-core-server:8086/health`
- Check network: `docker network inspect openbox-local_default`

---

## 📋 Pre-Production Checklist

- [ ] Replace all default secrets (encryption keys, passwords)
- [ ] Set `enforceHttps: true` in OpenBoxApi credential
- [ ] Configure webhook signing secret
- [ ] Set `failPolicy: 'fail_closed'` for critical workflows
- [ ] Enable health checks and monitoring
- [ ] Configure database backups (automated, tested restore)
- [ ] Set resource limits on all containers
- [ ] Review and tune timeout values
- [ ] Test fail-over scenarios (Core down, DB down, network partition)
- [ ] Document incident response procedures
- [ ] Set up alerting (PagerDuty, Slack, etc.)
- [ ] Perform load testing with realistic workflow volume
- [ ] Validate GDPR/compliance requirements (data retention, audit logs)

---

## 📚 Additional Resources

- [n8n Self-Hosting Guide](https://docs.n8n.io/hosting/)
- [OpenBox Core API Documentation](https://docs.openbox.ai/api)
- [Docker Compose Production Best Practices](https://docs.docker.com/compose/production/)
- [Node.js Production Best Practices](https://nodejs.org/en/docs/guides/nodejs-docker-webapp/)

---

**Last updated:** 2026-05-21  
**Maintainer:** OpenBox Integration Team
