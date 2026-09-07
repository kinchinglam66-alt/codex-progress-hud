import { assertToolSuccess } from './packaged-cleanup.mjs';

/** Shared by source integration and packaged launchers; no model inference. */
export async function exercisePassiveControls(client) {
  const names = (await client.listTools()).tools.map(tool => tool.name);
  const required = ['tracking_start', 'tracking_pause', 'tracking_resume', 'tracking_stop', 'tracking_status'];
  if (required.some(name => !names.includes(name)) ||
      ['progress_report', 'validation_observed', 'task_outcome'].some(name => names.includes(name))) {
    throw new Error('MCP does not expose the passive control contract');
  }
  const statuses = [];
  for (const [name, status] of [
    ['tracking_start', 'running'], ['tracking_pause', 'paused'],
    ['tracking_resume', 'running'], ['tracking_stop', 'stopped'], ['tracking_start', 'running']
  ]) {
    const result = await client.callTool({name, arguments: {}});
    assertToolSuccess(result, name);
    if (result.structuredContent?.associationSource !== 'mcp_lease') {
      throw new Error(`${name} did not use the MCP lease association`);
    }
    const read = await client.callTool({name: 'tracking_status', arguments: {}});
    if (read.isError) throw new Error('tracking_status failed');
    const content = read.content?.find(item => item.type === 'text');
    const snapshot = JSON.parse(content?.text ?? 'null');
    if (snapshot?.selected?.task?.status !== status) throw new Error(`${name} did not reach ${status}`);
    statuses.push(status);
  }
  return {statuses};
}
