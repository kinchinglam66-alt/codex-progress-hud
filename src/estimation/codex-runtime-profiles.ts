/** Explicit Windows candidates, verified locally; not consent or live acceptance.
 * Historical experiment manifests keep their own frozen pins unchanged. */
export const codexRuntimeProfiles = Object.freeze([
  Object.freeze({version: '0.153.3', sha256: 'bc15d59a3062bf165181a30007c3d0f5b1ee0ca4855e33d9b486ad59c984a31b'}),
  Object.freeze({version: '0.153.4', sha256: 'a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6'}),
  Object.freeze({version: '0.153.4', sha256: 'e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75'}),
]);

export function supportedCodexVersion(version: unknown): version is string {
  return typeof version === 'string' && codexRuntimeProfiles.some(profile => profile.version === version);
}

export function parseCodexVersion(output: string): string | null {
  const match = /^codex-cli (\d+\.\d+\.\d+)$/.exec(output.trim());
  return match && supportedCodexVersion(match[1]) ? match[1] : null;
}
