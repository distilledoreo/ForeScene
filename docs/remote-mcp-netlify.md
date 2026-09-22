# Remote MCP on Netlify

ForeScene can expose the project open in a browser tab to remote MCP clients without moving the project itself to a server.

## Architecture

```text
MCP client (ChatGPT / Codex / Claude Code)
        |
        | Streamable HTTP-compatible JSON-RPC + OAuth access token
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
3. Copy the MCP URL.
4. Add that URL to an OAuth-capable MCP client such as ChatGPT.
5. When the client redirects to ForeScene, review the requested access and click **Allow**.
6. Keep the ForeScene tab open while using the agent.
7. Click **Disconnect** when finished.

Connections expire after eight hours. The raw `fs_mcp_...` relay credential remains internal to the paired browser tab; OAuth clients receive separate short-lived access and refresh tokens bound to that relay session.

## MCP tools

- `agent_reference` — coordinate system, primitive placement semantics, architecture helpers, and recommended spatial workflow.
- `project_inspect` — project summary.
- `scene_query` — compact structured object search.
- `scene_inspect` — detailed transform/dimensions/world-bounds/support/intersection/architecture inspection.
- `scene_validate` — spatial and architectural preflight; optionally accepts a proposed `plan` so it can validate the hypothetical result before apply. It also classifies automatic opening/stair relationships, doorway threshold support, stair-clearance obstructions, overlapping support surfaces, and substantial unexplained intersections.
- `scene_capture` — isometric/top/front/back/left/right authoring image returned directly to the MCP client; optionally accepts a proposed `plan` to render the hypothetical result before apply.
- `project_script` — compile a stateful ForeScene script server-side against the current browser project, then preview the resulting normal Agent Plan. Never applies.
- `project_apply` — apply a previewed plan; available only to sessions created with editing enabled and only while browser Agent writes are enabled. It refuses plans that introduce new spatial-preflight errors unless `allowSpatialErrors: true` is explicitly supplied.
- `shot_render` — render a shot in-browser and return metadata/artifact handles. Large inline image bytes are intentionally not relayed.
- `project_verify` — project health + visual preflight + spatial-authoring validation.

The endpoint implements the stateless 2025-11-25 Streamable HTTP request/response flow. Modern clients that probe the 2026 protocol can fall back to the legacy/stateless flow.

## Netlify deployment

No external database, OAuth provider, WebSocket service, or environment variable is required. Relay and OAuth state use site-scoped Netlify Blobs with strong consistency.

The repository includes:

```text
netlify/functions/mcp.mts
netlify/functions/agent-session.mts
netlify/functions/agent-poll.mts
netlify/functions/agent-result.mts
netlify/functions/oauth-protected-resource.mts
netlify/functions/oauth-protected-resource-mcp.mts
netlify/functions/oauth-authorization-server.mts
netlify/functions/oauth-register.mts
netlify/functions/oauth-authorize.mts
netlify/functions/oauth-token.mts
netlify/lib/remoteAgentStore.ts
netlify/lib/oauthStore.ts
```

Netlify automatically discovers `netlify/functions/`. Relay state uses the site-scoped `forescene-agent-relay` Blob store and OAuth state uses `forescene-oauth`, both with strong consistency.

After the production deploy:

1. Open **Netlify > Deploys** and confirm the deploy succeeded.
2. Open **Netlify > Functions** and confirm the relay and OAuth functions are present, including `mcp`, `agent-session`, `oauth-authorize`, `oauth-token`, and the two well-known discovery handlers.
3. Open the deployed ForeScene site and connect from **Remote MCP Connection**.
4. The displayed MCP URL should be `https://YOUR-DOMAIN/mcp`.

The deployment workflow also runs the OAuth smoke test in Chromium. It clicks
both **Cancel** and **Allow**, checks the callback state, exchanges the code with
PKCE, and initializes MCP using an isolated read-only session with no project
data. The callback stays in a loopback test receiver and the session is disconnected
afterward. To run it manually:

```sh
npx playwright install chromium
node scripts/remote-mcp-oauth-smoke.mjs https://YOUR-DOMAIN --browser
```

The consent page's `form-action` CSP must include the validated callback origin:
Chromium checks redirects after form submission, so a policy of only `'self'`
leaves the consent page stuck even when an HTTP-only test sees a successful 302.
Only the selected registered callback origin is allowed; invalid-request error
pages retain the same-origin policy.

## ChatGPT / OAuth client setup

ForeScene implements OAuth 2.1-style Authorization Code + PKCE for the remote MCP endpoint, including protected-resource discovery, authorization-server metadata, Dynamic Client Registration, and refresh-token rotation.

For ChatGPT:

1. Enable **Remote MCP Connection** in the ForeScene tab first.
2. In ChatGPT's custom MCP/app setup, use `https://YOUR-DOMAIN/mcp`.
3. ChatGPT discovers ForeScene's OAuth metadata and registers as a public client.
4. The browser is redirected to `/oauth/authorize`.
5. ForeScene shows the currently paired project and requested read/write permissions.
6. After approval, ChatGPT exchanges the one-time authorization code at `/oauth/token` using PKCE.
7. Subsequent MCP calls use a short-lived OAuth access token. Refresh tokens are rotated and cannot outlive the paired ForeScene browser session.

Discovery endpoints:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

OAuth endpoints:

```text
/oauth/register
/oauth/authorize
/oauth/token
```

Scopes:

```text
forescene:read
forescene:write
offline_access
```

Initial MCP authentication challenges for `forescene:read`. When the paired browser session permits editing, `project_apply` is discoverable; calling it without `forescene:write` returns an OAuth `403 insufficient_scope` challenge so compatible clients can perform scope step-up. The apply call succeeds only after write scope is granted **and** the paired browser connection is still in **Allow editing** mode.

## Security notes

- The internal `fs_mcp_...` relay credential is not displayed to MCP clients and should never leave the paired ForeScene tab.
- OAuth authorization codes are single-use and PKCE S256 is required.
- Access tokens are short-lived; refresh tokens rotate and are capped by the relay session expiry.
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
- OAuth authorization is browser-session pairing rather than account identity: the most recently paired ForeScene session in that browser is the session presented on the consent screen.


## Semantic cutters

Remote MCP clients receive the same effective geometry as the browser renderer. Doorways overlapping one compatible wall automatically cut a bounded portal opening; stairs automatically cut the nearest eligible upper floor/slab layer inside their bounded clearance volume. `scene_inspect` reports these relationships and distinguishes explained from unexplained intersections. `scene_validate` checks portal threshold support, ambiguous hosts, stair-clearance obstructions, duplicate support surfaces, and substantial unexplained solid overlaps.
