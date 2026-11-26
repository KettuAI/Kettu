# kettu-mcp-bridge

Carries an MCP client that speaks only stdio, such as an ACP agent, to a server Kettu runs. Kettu
hands the client one bridge per server:

```text
kettu-mcp-bridge mcp connect <server> --agent <agent>
```

with `KETTU_MCP_URL` (Kettu's loopback MCP service, `http://127.0.0.1:<port>`) and
`KETTU_MCP_TOKEN` (the caller's own token) in its environment. The bridge sends one HTTP request
to `/bridge/<server>` asking to upgrade to `kettu-mcp`, with the token, the folder it was started
in and the agent; after Kettu answers `101 Switching Protocols`, the connection carries the
client's newline-separated JSON-RPC both ways, unchanged.

It connects only to a loopback address. When Kettu is not running, or refuses the connection, it
writes one line to stderr and exits with status 1; it never starts Kettu.

`node native/mcp-bridge/build.mjs <folder>` builds it for this computer with Cargo and copies it
into the folder; `tools/install/device-helpers.mjs` puts it among the app's helpers.
