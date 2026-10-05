/** A lease-scoped MCP snapshot cannot attest global Hook trust or inactivity. */
export function assertLeaseScopedDiagnosticReport(markdown) {
  if (typeof markdown !== 'string') throw new Error('packaged diagnostic report is missing');
  const lines = markdown.split(/\r?\n/u);
  const hooks = lines.filter(line => line.startsWith('- Hook trust/activity:'));
  const leases = lines.filter(line => line.startsWith('- MCP lease:'));
  const tracking = lines.filter(line => line.startsWith('- Tracking'));
  if (hooks.length !== 1 || hooks[0] !== '- Hook trust/activity: not reported') {
    throw new Error('lease-scoped packaged diagnostics claimed global Hook trust or activity');
  }
  if (leases.length !== 1 || leases[0] !== '- MCP lease: connected (1)') {
    throw new Error('packaged diagnostics did not attest the active MCP lease');
  }
  if (tracking.length !== 1 || tracking[0] !== '- Tracking (current MCP lease only): 0 task(s)') {
    throw new Error('packaged diagnostics did not preserve empty current-lease tracking scope');
  }
}
