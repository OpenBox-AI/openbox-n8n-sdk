# n8n-nodes-openbox-hook

OpenBox governance community node for n8n.

This package provides an **OpenBox: Agent** node that wraps n8n LangChain chat models, memory, and tools with OpenBox governance checks.

## Install in n8n

In n8n, open **Settings > Community Nodes**, choose **Install**, and enter:

```text
n8n-nodes-openbox-hook
```

Then restart n8n if your deployment requires it.

## Credentials

Create an **OpenBox API** credential in n8n with:

- **OpenBox URL**: your OpenBox API URL
- **API Key**: your OpenBox API key
- Optional webhook signing secret, if you use signed OpenBox webhooks

You can also use `OPENBOX_API_URL` and `OPENBOX_API_KEY` environment variables in deployments where credentials are injected at runtime.

## Local development

From this directory:

```bash
npm install
npm run build
npm test
npm run smoke:load
```

To test the package tarball locally:

```bash
npm pack
```

Install the generated `.tgz` through n8n's custom/community node mechanism, or mount this package into an n8n container for development.

## Publish

Before publishing, verify the package contents:

```bash
npm pack --dry-run
```

Publish to npm:

```bash
npm publish --access public
```

The package name starts with `n8n-nodes-` and includes the `n8n-community-node-package` keyword so n8n can recognize it as a community node package.
