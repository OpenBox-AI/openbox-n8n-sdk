# 🚀 OpenBox n8n Integration - Quick Start Guide

This guide will get you running the complete OpenBox n8n integration locally in under 10 minutes.

---

## 📋 Prerequisites

- **Docker Desktop** installed and running
- **Git** installed
- **8GB RAM minimum** (for all containers)
- **Ports available:** 5678 (n8n), 8086 (OpenBox Core)

---

## 🎯 Step 1: Clone & Navigate

```bash
cd example/n8n
```

---

## 🔧 Step 2: Create Environment File

Copy the example environment file:

```bash
copy .env.example .env
```

**For local development, the defaults are perfect.** No changes needed!

The `.env` file uses:
- Local Ollama (no API key required)
- Auto-provisioned OpenBox agent key
- Local postgres with simple credentials

---

## 🐳 Step 3: Start the Stack

### Option A: Basic Setup (Phases 1 + 2)

This includes:
- ✅ OpenBox custom nodes (Phase 1)
- ✅ External hooks for observability (Phase 2)
- ❌ Governance proxy (optional)

```bash
docker compose up -d
```

### Option B: Full Setup (Phases 1 + 2 + 3)

This adds the governance proxy for blocking built-in nodes:

```bash
docker compose --profile proxy up -d
```

**First run will take 5-10 minutes** to:
1. Pull Docker images
2. Build custom node
3. Download Ollama model (~640MB)
4. Provision OpenBox agent
5. Import demo workflows

---

## 📊 Step 4: Monitor Startup

Watch the logs to see progress:

```bash
docker compose logs -f
```

**Look for these success messages:**

```
✅ [seed] Agent provisioned: obx_live_xxxxx
✅ [ollama-pull] pulling tinyllama via ollama:11434
✅ [ollama-pull] done
✅ [n8n-import] materialized /demo-data/credentials/openbox.json
✅ [n8n-import] Imported 1 credential
✅ [n8n-import] Imported 4 workflows
✅ [n8n] Editor is now accessible via: http://localhost:5678/
✅ [openbox-hooks] HTTP span capture enabled (diagnostics_channel)
✅ [openbox-hooks] DB span capture enabled (pg.Client.prototype.query patch)
```

Press `Ctrl+C` to stop following logs (containers keep running).

---

## 🌐 Step 5: Access n8n

Open your browser to:

```
http://localhost:5678
```

**First-time setup:**
1. Create an owner account (any email/password)
2. Skip the personalization survey
3. You'll see the n8n dashboard

---

## 🎨 Visual Changes You'll See

### 1. **New Nodes in the Node Panel**

When you click **"Add node"** (the `+` button), you'll see 3 new OpenBox nodes:

#### **OpenBox** (Generic Action Node)
- **Icon:** OpenBox logomark
- **Category:** Transform
- **Resources:**
  - Governance (Evaluate Event, Authorize Action, Monitor Node, Verify Output)
  - Approval (Request Approval, Poll Approval)
  - Audit (Emit Audit Event)
  - Trust (Get Trust Summary)

#### **OpenBox: LLM**
- **Icon:** OpenBox logomark
- **Category:** AI
- **Features:**
  - Dual provider (OpenRouter + Ollama)
  - Pre/post governance checkpoints
  - Deterministic local blocks (PII, secrets, NSFW)
  - 6 verdict outputs (Allowed, Constrained, Approval Required, Blocked, Halted, Error)

#### **OpenBox Trigger**
- **Icon:** OpenBox logomark
- **Category:** Trigger
- **Features:**
  - Webhook receiver for OpenBox events
  - HMAC signature verification
  - Event filtering (7 types)
  - Field-level filters

---

### 2. **New Credential Type**

Go to **Settings → Credentials → Add Credential**

You'll see **"OpenBox API"** with:
- OpenBox URL (default: `http://openbox-core-server:8086`)
- API Key (password field)
- Organization ID (optional)
- Project ID (optional)
- Environment (production/staging/development)
- Timeout (ms)
- Fail Policy (fail_closed/fail_open)
- Enforce HTTPS (toggle)
- Webhook Signing Secret (password field)

**The credential is already auto-imported!** Check:
- Settings → Credentials
- Look for "OpenBox API (Auto-imported)"

---

### 3. **Pre-Imported Demo Workflows**

Go to **Workflows** tab. You'll see 4 demo workflows:

#### **1. OpenBox Chat Demo**
- Chat Trigger → OpenBox: LLM → Response
- Shows basic governance integration
- Try it: Click "Test workflow" → Send a message

#### **2. OpenBox Governance Examples**
- Demonstrates all 4 resources (Governance, Approval, Audit, Trust)
- Shows 6-output verdict routing
- Manual trigger

#### **3. OpenBox Trigger Demo**
- Shows webhook-based approval notifications
- Webhook URL auto-generated
- Filters by event type

#### **4. OpenBox Multi-Item Processing**
- Demonstrates item-by-item governance
- Shows batch processing with verdicts

---

### 4. **6 Verdict Outputs (Visual Branching)**

When you add an **OpenBox** or **OpenBox: LLM** node, you'll see:

```
┌─────────────────┐
│  OpenBox Node   │
└─────────────────┘
        │
        ├─── Allowed (green)
        ├─── Constrained (yellow)
        ├─── Approval Required (orange)
        ├─── Blocked (red)
        ├─── Halted (dark red)
        └─── Error (gray)
```

**Before this implementation:**
- Single output
- Threw errors on block
- Required IF nodes for branching

**After this implementation:**
- 6 named outputs
- Direct visual routing
- No IF nodes needed

---

### 5. **External Hooks (Invisible but Active)**

You won't see these visually, but they're running:

**Check the logs:**
```bash
docker compose logs n8n | grep openbox-hooks
```

You'll see:
```
[openbox-hooks][info] hooks ready
[openbox-hooks][info] HTTP span capture enabled (diagnostics_channel)
[openbox-hooks][info] DB span capture enabled (pg.Client.prototype.query patch)
```

**What they do:**
- Capture all HTTP requests from built-in nodes (Slack, HubSpot, etc.)
- Capture all Postgres queries
- Send spans to OpenBox Core for observability
- Emit WorkflowStarted/Completed events

---

## 🧪 Step 6: Test the Integration

### Test 1: Basic LLM Governance

1. Open **"OpenBox Chat Demo"** workflow
2. Click **"Test workflow"**
3. In the chat input, type: `"What is 2+2?"`
4. Click **Send**

**What you'll see:**
- Message goes through OpenBox governance
- Pre-execution check (input validation)
- LLM call to Ollama
- Post-execution check (output validation)
- Response returned

**Check the execution:**
- Click on the **OpenBox: LLM** node
- See the execution data with verdict info

---

### Test 2: Verdict Routing

1. Create a new workflow
2. Add **Manual Trigger**
3. Add **OpenBox** node
4. Configure:
   - Resource: **Governance**
   - Operation: **Evaluate Event**
   - Event Type: `test_event`
   - Input: `{"message": "test"}`
5. Connect different nodes to each output:
   - Allowed → Set node (message: "Allowed!")
   - Blocked → Set node (message: "Blocked!")
   - Error → Set node (message: "Error!")

6. Execute and see which path it takes

---

### Test 3: Credential Usage

1. Go to **Settings → Credentials**
2. Click on **"OpenBox API (Auto-imported)"**
3. Click **"Test"** button

**Expected result:**
```
✅ Connection successful!
```

This validates:
- OpenBox Core is reachable
- API key is valid
- Network connectivity works

---

## 🔍 Step 7: Verify External Hooks

### Check HTTP Span Capture

1. Create a workflow with **HTTP Request** node
2. Configure: `GET https://api.github.com/zen`
3. Execute the workflow

**Check OpenBox Core logs:**
```bash
docker compose -f ../../docker-compose.yml logs openbox-core-server | grep http_request
```

You should see the HTTP span captured!

---

### Check DB Span Capture

1. Add a **Postgres** node to any workflow
2. Configure it to query n8n's database
3. Execute

**Check logs:**
```bash
docker compose logs n8n | grep "db_query"
```

You'll see DB spans being submitted.

---

## 🛑 Step 8: Stop the Stack

When you're done testing:

```bash
docker compose down
```

**To completely reset (delete all data):**

```bash
docker compose down -v
```

This removes:
- All workflows
- All credentials
- All execution history
- All database data

---

## 🐛 Troubleshooting

### Issue: "Cannot connect to OpenBox Core"

**Check if OpenBox Core is running:**
```bash
docker compose -f ../../docker-compose.yml ps openbox-core-server
```

**If not running, start the OpenBox stack:**
```bash
cd ../..
docker compose up -d
cd example/n8n
docker compose restart n8n
```

---

### Issue: "Ollama model not found"

**Check if ollama-pull completed:**
```bash
docker compose logs ollama-pull
```

**If failed, manually pull:**
```bash
docker compose exec ollama ollama pull tinyllama
```

---

### Issue: "Credential not found"

**Re-import credentials:**
```bash
docker compose restart n8n-import
docker compose logs n8n-import
```

Look for: `Imported 1 credential`

---

### Issue: "Workflows not showing"

**Re-import workflows:**
```bash
docker compose restart n8n-import
docker compose logs n8n-import
```

Look for: `Imported 4 workflows`

---

## 📸 Screenshots to Expect

### 1. Node Panel
You should see OpenBox nodes when searching:
- Type "openbox" in the search
- See 3 nodes appear

### 2. OpenBox Node Configuration
When you add an OpenBox node:
- See "Resource" dropdown (Governance, Approval, Audit, Trust)
- See "Operation" dropdown (changes based on resource)
- See "On Block / Halt" option (route vs throw)

### 3. OpenBox: LLM Node Configuration
When you add an OpenBox: LLM node:
- See "LLM Provider" dropdown (OpenRouter, Ollama)
- See "Model" field
- See "System Prompt" field
- See "Input Field" field (configurable!)
- See 6 output connections

### 4. Credential Screen
In Settings → Credentials:
- See "OpenBox API (Auto-imported)"
- Click to edit → see all 9 fields
- See "Test" button at bottom

### 5. Workflow Canvas
When you open a demo workflow:
- See nodes connected with colored lines
- See 6 output branches from OpenBox nodes
- See execution history on the right

---

## 🎓 Next Steps

1. **Explore demo workflows** - Understand the patterns
2. **Create custom workflows** - Use OpenBox nodes in your own flows
3. **Test verdict routing** - See how different verdicts route to different outputs
4. **Check observability** - View spans in OpenBox Core dashboard
5. **Enable proxy** (optional) - Test Phase 3 blocking

---

## 📚 Additional Resources

- **Full Documentation:** `PRODUCTION.md`
- **Architecture Details:** `../../../gaps.md`
- **Hooks README:** `hooks/README.md`
- **Proxy README:** `openbox-proxy/README.md`

---

## 🆘 Need Help?

**Check logs:**
```bash
# All services
docker compose logs

# Specific service
docker compose logs n8n
docker compose logs openbox-hooks

# Follow logs in real-time
docker compose logs -f n8n
```

**Check service health:**
```bash
docker compose ps
```

**Restart a service:**
```bash
docker compose restart n8n
```

---

**Happy Testing! 🎉**
