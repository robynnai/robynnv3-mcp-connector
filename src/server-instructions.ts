/**
 * MCP `initialize` instructions: host-neutral, and only what a model needs
 * to use the tools correctly (contract §7, §8.3; TOOL_CONTRACT §4).
 */
export const SERVER_INSTRUCTIONS = [
  "Robynn tools act on the one organization chosen when this connection was made.",
  "Read-only connections can use tools that read existing Robynn data. Tools that save, generate, charge Robynn credits or act on connected apps need execution access; if a tool reports insufficient_scope, ask the user to reconnect Robynn and allow execution.",
  "Long-running tools return an id: poll with the status tool their description names instead of starting the work again.",
  "If a tool reports authorization_expired or authorization_unavailable, retry once; if it persists, ask the user to reconnect Robynn.",
].join("\n");
