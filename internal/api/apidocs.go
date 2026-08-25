package api

import "net/http"

// handleOpenAPI serves a minimal OpenAPI 3.0 description of the /api/v1 surface.
// It is public (documentation only) so tooling and the docs page can fetch it.
func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(openAPIJSON))
}

// openAPIJSON is a hand-written OpenAPI document for the machine-to-machine API.
// It stays in sync with the routes mounted under /api/v1 in Router().
const openAPIJSON = `{
  "openapi": "3.0.3",
  "info": {
    "title": "XeloVoice API",
    "version": "1.0.0",
    "description": "Machine-to-machine control plane for XeloVoice. Authenticate every request with an API token minted in Settings → API."
  },
  "servers": [{ "url": "/api/v1" }],
  "components": {
    "securitySchemes": {
      "bearerAuth": { "type": "http", "scheme": "bearer" },
      "tokenHeader": { "type": "apiKey", "in": "header", "name": "X-API-Token" }
    }
  },
  "security": [{ "bearerAuth": [] }, { "tokenHeader": [] }],
  "paths": {
    "/ping": { "get": { "summary": "Verify a token", "responses": { "200": { "description": "ok" } } } },
    "/extensions": {
      "get": { "summary": "List extensions", "responses": { "200": { "description": "list" } } },
      "post": { "summary": "Create an extension", "responses": { "201": { "description": "created" } } }
    },
    "/extensions/{id}": {
      "get": { "summary": "Get one extension", "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }], "responses": { "200": { "description": "extension" } } },
      "delete": { "summary": "Delete an extension", "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }], "responses": { "200": { "description": "deleted" } } }
    },
    "/trunks": { "get": { "summary": "List trunks", "responses": { "200": { "description": "list" } } } },
    "/reports/overview": { "get": { "summary": "Call-center KPIs", "parameters": [{ "name": "days", "in": "query", "schema": { "type": "integer" } }, { "name": "queue", "in": "query", "schema": { "type": "string" } }, { "name": "sla", "in": "query", "schema": { "type": "integer" } }], "responses": { "200": { "description": "kpis" } } } },
    "/reports/queues": { "get": { "summary": "Queue names", "responses": { "200": { "description": "queues" } } } },
    "/reports/agents": { "get": { "summary": "Per-agent stats", "parameters": [{ "name": "days", "in": "query", "schema": { "type": "integer" } }], "responses": { "200": { "description": "agents" } } } },
    "/calls": { "get": { "summary": "Live channels", "responses": { "200": { "description": "channels" } } } },
    "/calls/originate": { "post": { "summary": "Place a call", "responses": { "200": { "description": "channel" } } } },
    "/calls/{id}": { "delete": { "summary": "Hang up a channel", "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string" } }], "responses": { "200": { "description": "hung up" } } } }
  }
}`

// apiDocsHTML is a self-contained, themed reference page for the /api/v1 surface.
// Served (public) at /api/v1/docs so the "API docs" link in Settings opens
// directly in the browser.
const apiDocsHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>XeloVoice API</title>
<style>
:root{--g:#39a751;--bg:#0a120d;--panel:#0f1c14;--border:#1d3a28;--text:#dbeee2;--muted:#7fa891;--code:#0c1710}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 "Segoe UI",system-ui,sans-serif}
header{padding:26px 32px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,#0f1c14,transparent)}
h1{margin:0;font-size:24px;letter-spacing:1px;color:var(--g)}
.sub{color:var(--muted);font-size:13px;margin-top:4px}
main{max-width:920px;margin:0 auto;padding:28px 32px 80px}
h2{color:var(--g);font-size:16px;text-transform:uppercase;letter-spacing:1px;margin:34px 0 12px;border-bottom:1px solid var(--border);padding-bottom:6px}
p{color:var(--text)}
code,pre{font-family:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:14px 16px;overflow:auto;color:#bfe9cd}
code.inl{background:var(--code);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:#bfe9cd}
.ep{border:1px solid var(--border);border-radius:10px;margin:10px 0;overflow:hidden;background:var(--panel)}
.ep .row{display:flex;align-items:center;gap:12px;padding:12px 16px}
.m{font-weight:700;font-size:12px;padding:3px 9px;border-radius:6px;min-width:58px;text-align:center;letter-spacing:.5px}
.get{background:#123a22;color:#5fe08a;border:1px solid #1f5c37}
.post{background:#0e2f3a;color:#5fd0e0;border:1px solid #1f4f5c}
.del{background:#3a1414;color:#e08a8a;border:1px solid #5c1f1f}
.path{font-family:ui-monospace,monospace;color:#cfeeda}
.desc{color:var(--muted);margin-left:auto;font-size:13px}
a{color:var(--g)}
.note{background:var(--panel);border:1px solid var(--border);border-left:3px solid var(--g);border-radius:8px;padding:12px 16px;margin:12px 0;color:var(--muted)}
</style></head><body>
<header>
  <h1>XeloVoice API</h1>
  <div class="sub">Machine-to-machine control plane &middot; base URL <code class="inl" id="base">/api/v1</code></div>
</header>
<main>
  <h2>Authentication</h2>
  <p>Create a token in <strong>Settings &rarr; API</strong>. The full token is shown only once &mdash; store it securely. Send it on every request as a Bearer token:</p>
  <pre>curl -H "Authorization: Bearer &lt;YOUR_TOKEN&gt;" <span id="ex1">/api/v1</span>/ping</pre>
  <p>Alternatively send the <code class="inl">X-API-Token</code> header, or (for quick tests only) the <code class="inl">?api_token=</code> query parameter.</p>
  <div class="note">Tokens are stored only as a SHA-256 hash. Revoking a token in the console takes effect immediately. Treat a token like a password: it grants the same telephony control the console has.</div>

  <h2>Machine spec</h2>
  <p>An OpenAPI 3.0 description is available at <a href="./openapi.json">openapi.json</a> for code generation and import into Postman/Insomnia.</p>

  <h2>Endpoints</h2>

  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/ping</span><span class="desc">verify a token</span></div></div>

  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/extensions</span><span class="desc">list SIP extensions</span></div></div>
  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/extensions/{id}</span><span class="desc">get one extension</span></div></div>
  <div class="ep"><div class="row"><span class="m post">POST</span><span class="path">/extensions</span><span class="desc">create an extension</span></div></div>
  <div class="ep"><div class="row"><span class="m del">DELETE</span><span class="path">/extensions/{id}</span><span class="desc">delete an extension</span></div></div>

  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/trunks</span><span class="desc">list SIP trunks</span></div></div>

  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/reports/overview</span><span class="desc">call-center KPIs (?days,?queue,?sla)</span></div></div>
  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/reports/queues</span><span class="desc">queue names</span></div></div>
  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/reports/agents</span><span class="desc">per-agent stats (?days)</span></div></div>

  <div class="ep"><div class="row"><span class="m get">GET</span><span class="path">/calls</span><span class="desc">live channels</span></div></div>
  <div class="ep"><div class="row"><span class="m post">POST</span><span class="path">/calls/originate</span><span class="desc">place a call</span></div></div>
  <div class="ep"><div class="row"><span class="m del">DELETE</span><span class="path">/calls/{id}</span><span class="desc">hang up a channel</span></div></div>

  <h2>Example: place a call</h2>
  <pre>curl -X POST <span id="ex2">/api/v1</span>/calls/originate \
  -H "Authorization: Bearer &lt;YOUR_TOKEN&gt;" \
  -H "Content-Type: application/json" \
  -d '{"endpoint":"PJSIP/1001","extension":"1002","context":"from-internal"}'</pre>

  <h2>Example: call-center KPIs for the last day</h2>
  <pre>curl -H "Authorization: Bearer &lt;YOUR_TOKEN&gt;" \
  "<span id="ex3">/api/v1</span>/reports/overview?days=1"</pre>
</main>
<script>
// Rewrite the shown base URL to the absolute origin so copy/paste works.
try{var b=location.origin+"/api/v1";["base","ex1","ex2","ex3"].forEach(function(id){var e=document.getElementById(id);if(e)e.textContent=b;});}catch(e){}
</script>
</body></html>`
