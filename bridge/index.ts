// Back-compat entrypoint. The bridge is now split into:
//   • hub.ts — the shared daemon (WebSocket :8787, browser + filters)
//   • mcp.ts — the per-session MCP shim Claude spawns (forwards to the hub)
// Running this file just starts the shim.
import "./mcp.ts";
