# MCP examples

Two small "agents" that coordinate a shared test account through the Model Context Protocol.

| Script            | Transport       | How the MCP server runs                                                     |
| ----------------- | --------------- | --------------------------------------------------------------------------- |
| `stdio-agent.mjs` | stdio           | spawns `testlease mcp --url <server>` (the bridge) like an agent host would |
| `http-agent.mjs`  | Streamable HTTP | connects to `/mcp` on the running TestLease server                          |

```bash
# terminal 1: a server with the demo pool (set the demo secrets so startup validation passes)
export BUYER_01_PASSWORD=x BUYER_02_PASSWORD=y BUYER_03_PASSWORD=z
testlease serve --config ../playwright/testlease.yml

# terminal 2
node stdio-agent.mjs
node http-agent.mjs
```

Both print what the agent sees. Look for `availableSecretKeys: ["password"]` — the agent learns
_that_ a password exists, never its value. Running the tests with credentials is the runner's
job: `testlease exec --lease <lease-id> -- npm test` with a token that has `secrets:resolve`.

Claude Desktop / Claude Code style configuration for the stdio bridge:

```json
{
  "mcpServers": {
    "testlease": {
      "command": "npx",
      "args": ["-y", "testlease", "mcp", "--url", "http://127.0.0.1:4747"],
      "env": { "TESTLEASE_TOKEN": "…", "TESTLEASE_OWNER": "mcp:my-agent" }
    }
  }
}
```
