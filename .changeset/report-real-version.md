---
'testlease': patch
'@testlease/client': patch
'@testlease/mcp': patch
'@testlease/core': patch
'@testlease/server': patch
'@testlease/protocol': patch
'@testlease/playwright': patch
---

Report the real package version: `testlease --version`, `/healthz`, the client user-agent and the
MCP server identity read the version from `package.json` instead of a hard-coded `0.1.0` (the
published 0.2.0 introduced itself as 0.1.0). `testlease doctor` no longer tells you to run
`testlease doctor` when the server is unreachable.
