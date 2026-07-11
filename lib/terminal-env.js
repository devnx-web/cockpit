export function interactiveTerminalEnv(hostEnv = {}, projectEnv = {}, metadata = {}) {
  const inherited = { ...hostEnv };

  // Dev tools and CI wrappers commonly set these on their own process. They
  // must not silently turn every interactive Cockpit terminal monochrome.
  // A project can still request no-color explicitly through its own env.
  delete inherited.NO_COLOR;
  delete inherited.COLOR;

  return {
    ...inherited,
    ...projectEnv,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...metadata,
  };
}
