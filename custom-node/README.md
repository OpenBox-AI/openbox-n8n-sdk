# n8n-nodes-openbox-hook

OpenBox governance community node for n8n.

This package provides an **OpenBox: Agent** node that wraps n8n LangChain chat models, memory, and tools with OpenBox governance — policy evaluation, PII redaction, HITL approval, and audit traces — without changing your existing workflow structure.

## Install

In n8n, open **Settings > Community Nodes**, choose **Install**, and enter:

```
n8n-nodes-openbox-hook
```

Restart n8n if prompted.

## Credentials

Create an **OpenBox API** credential in n8n with:

| Field | Required | Description |
|---|---|---|
| **API Key** | Yes | Your OpenBox API key. Live keys start with `obx_live_`; test keys with `obx_test_`. |
| **Agent DID** | No | Agent decentralised identifier (`did:aip:<uuid>`). Required only for agents with `signing_required = true`. |
| **Agent Private Key** | No | Base64-encoded raw 32-byte Ed25519 seed. Paired with Agent DID for signed requests. |

Get your API key from [dashboard.openbox.ai](https://dashboard.openbox.ai).

## Usage

### Basic setup

1. Add an **OpenBox: Agent** node to your workflow.
2. Connect a **Chat Model** sub-node (e.g. OpenAI Chat Model, Anthropic Chat Model) to the **Chat Model** input.
3. Optionally connect **Memory** and **Tool** sub-nodes.
4. Attach your **OpenBox API** credential to the node.
5. Configure the **Agent Name** (used to identify this agent in OpenBox governance traces) and the **Task Queue**.

The node exposes the same inputs and outputs as the standard n8n AI Agent node, so it is a drop-in replacement.

### Example workflow

```
[Chat Trigger]
      │
      ▼
[OpenBox: Agent]  ←──  [OpenAI Chat Model]
      │            ←──  [Window Buffer Memory]
      │            ←──  [Calculator Tool]
      ▼
[Set node / downstream steps]
```

**OpenBox: Agent node settings:**

- **Agent Name**: `customer-support-bot`
- **Task Queue**: `n8n`
- **Governance**: Enabled (default)

When the agent runs, OpenBox evaluates each LLM call and tool invocation against your configured policies. If a call requires approval (HITL), the node pauses and polls until a decision is received.

### Advanced: Agent DID signing

For agents configured with `signing_required = true` in OpenBox, fill in the **Agent DID** and **Agent Private Key** fields in the credential. Every request to the OpenBox API will be signed with an Ed25519 signature automatically.

## Local development

```bash
npm install
npm run build
npm test
npm run lint
```

To verify the package scan passes before publishing:

```bash
npx @n8n/scan-community-package n8n-nodes-openbox-hook
```
