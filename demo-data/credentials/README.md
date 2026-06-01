# `demo-data/credentials`

Drop-in directory mounted into the n8n container at
`/demo-data/credentials`. Any `.json` file placed here that follows
the n8n credential export schema will be imported by the
`n8n-import` service on first boot via:

```sh
n8n import:credentials --separate --input=/demo-data/credentials
```

## OpenBox credential template

`openbox.template.json` is a placeholder that the import entrypoint
substitutes at runtime: it reads the agent runtime key minted by the
`seed` service (`openbox_seed:/seed/agent_key`) and writes the
populated credential to `/demo-data/credentials/openbox.json` before
the import command runs. If the seed key isn't available, the import
step is skipped and the credential can be created manually from the
n8n UI.

This directory is intentionally version-controlled (with `.gitkeep`)
so the docker-compose volume mount succeeds on a fresh clone — n8n
fails to start if the import path is missing.
