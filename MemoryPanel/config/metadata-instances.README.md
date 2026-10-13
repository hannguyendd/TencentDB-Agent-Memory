# metadata-instances.json field reference (new stateless panel)

| Field | Required | Description |
|------|------|------|
| `id` | Yes | = `instance_id` = kernel `x-tdai-service-id`; commonly `default` locally, `mem-{slug}` in production |
| `name` | Yes | Display name on the login page; exposed **only** through `GET /api/v1/meta/instances` |
| `gateway_endpoint` | Yes | Root URL of the memory Gateway; locally `http://127.0.0.1:8420`. **The Panel backend → Kernel forwarding address; do not use it to point at the proxy** |
| `proxy_endpoint` | No | Client access baseUrl (CodeBuddy / ClaudeCode CLI, etc.). Used **only** to compose the "client access address" card in the Panel UI. When omitted it falls back to `gateway_endpoint`, same as the old behavior. In production deployments where the gateway sits behind the proxy, the two values are the same and it can be omitted; for local open-source deployments where core and proxy run separately, enter the proxy's external address here (e.g. `http://127.0.0.1:8096`) |
| `api_key` | Yes | Gateway Bearer; used **only server-side** for forwarding and **never** appears in the instances API |

## Local file (contains secrets, not committed)

```bash
cp config/metadata-instances.example.json config/metadata-instances.json
# Then fill in gateway_endpoint / api_key for your local Gateway
```

`config/metadata-instances.json` has been added to `.gitignore`; the repo only keeps `metadata-instances.example.json`.

> **Update note**: before the first pull that includes the commit removing this file from version control, back up your local `metadata-instances.json`; if the file is deleted after the pull, restore it from the backup, or copy it again from the example as above and fill in the key.
