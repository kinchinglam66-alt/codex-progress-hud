function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireWrappedMcpServers(config, label = ".mcp.json") {
  if (!isRecord(config) || Object.keys(config).length !== 1 || !Object.hasOwn(config, "mcpServers")) {
    throw new Error(`${label} must contain only the mcpServers top-level key`);
  }
  if (!isRecord(config.mcpServers)) {
    throw new Error(`${label} mcpServers must be an object`);
  }
  return config.mcpServers;
}
