# Remote MCP on Netlify

ForeScene can expose the project open in a browser tab to remote MCP clients without moving the project itself to a server.

## Architecture

```text
MCP client (Codex / Claude Code)
        |
        | Streamable HTTP-compatible JSON-RPC + Bearer token
        v
Netlify /mcp Function
        |
        | temporary command/result records
        v
Netlify Blobs (strong consistency)
        ^
        | browser polling while connection is enabled
        |
ForeScene browser tab -> existing window.foreScene Agent API
```

Projects, imported assets, revisions, and render state remain browser-local. The relay stores only temporary session metadata, pending commands, and command results.

## Browser setup

Open **Menu > Remote MCP Connection**.

1. Choose **Read only** or **Allow editing**.
2. Click **Connect**.
3. Copy the MCP URL and bearer token.
4. Keep the ForeScene tab open while using the agent.
5. Click **Disconnect** when finished.

Connections expire after eight hours. Tokens live only in session storage in the paired browser tab.

## MCP tools

- `agent_reference` — coordinate system, primitive placement semantics, architecture helpers, and recommended spatial workflow.
- `project_inspect` — project summary.
- `scene_query` — compact structured object search.
- `scene_inspect` — detailed transform/dimensions/world-bounds/support/intersection/architecture inspection.
- `scene_validate` — spatial and architectural preflight; optionally accepts a proposed `plan` so it can validate the hypothetical result before apply.
- `scene_capture` — isometric/top/front/back/left/right authoring image returned directly to the MCP client; optionally accepts a proposed `plan` to render the hypothetical result before apply.
- `project_script` — compile a stateful ForeScene script server-side against the current browser project, then preview the resulting normal Agent Plan. Never applies.
- `project_apply` — apply a previewed plan; available only to sessions created with editing enabled and only while browser Agent writes are enabled. It refuses plans that introduce new spatial-preflight errors unless `allowSpatialErrors: true` is explicitly supplied.
- `shot_render` — render a shot in-browser and return metadata/artifact handles. Large inline image bytes are intentionally not relayed.
- `project_verify` — project health + visual preflight + spatial-authoring validation.

The endpoint implements the stateless 2025-11-25 Streamable HTTP request/response flow. Modern clients that probe the 2026 protocol can fall back to the legacy/stateless flow.

## Netlify deployment

No database, OAuth provider, WebSocket service, or environment variable is required for the MVP.

The repository includes:

```text
netlify/functions/mcp.mts
netlify/functions/agent-session.mts
netlify/functions/agent-poll.mts
netlify/functions/agent-result.mts
netlify/lib/remoteAgentStore.ts
```

Netlify automatically discovers `netlify/functions/`. The functions use the site-scoped `forescene-agent-relay` Blob store with strong consistency.

After the production deploy:

1. Open **Netlify > Deploys** and confirm the deploy succeeded.
2. Open **Netlify > Functions** and confirm these functions are present: `mcp`, `agent-session`, `agent-poll`, `agent-result`.
3. Open the deployed ForeScene site and connect from **Remote MCP Connection**.
4. The displayed MCP URL should be `https://YOUR-DOMAIN/mcp`.

## Codex example

Put the copied token in an environment variable rather than committing it:

```bash
export FORESCENE_MCP_TOKEN='fs_mcp_...'
```

Then add to `~/.codex/config.toml`:

```toml
[mcp_servers.forescene]
url = "https://YOUR-DOMAIN/mcp"
bearer_token_env_var = "FORESCENE_MCP_TOKEN"
tool_timeout_sec = 50
enabled = true
```

Restart/reload the MCP client after changing its configuration.

## Security notes

- Treat the bearer token like a password for the currently paired tab.
- Do not paste the token into source control, issue trackers, or screenshots.
- Read-write is separately gated by both the relay session and ForeScene's existing browser Agent control mode.
- `project_script` remains preview-first. It returns the generated plan; mutation requires a separate `project_apply`.
- Disconnect invalidates the server-side session and demotes browser Agent control to read-only.
- One command at a time is accepted per browser session.
- Claimed commands are redelivered after a short lease if a browser crashes mid-command.
- Remote command waits are bounded below Netlify's synchronous function execution limit.

## MVP limitations

- Polling is used instead of WebSockets, so the browser generates light request traffic while connected.
- The relay is single-flight per session.
- Rendered image bytes are not uploaded through the relay yet; `shot_render` returns metadata and browser-local artifact handles.
- There is no account-level identity or OAuth pairing yet. Possession of the high-entropy session token is the authentication mechanism.
