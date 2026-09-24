/** Explicit Windows candidates, verified locally; not consent or live acceptance.
 * Historical experiment manifests keep their own frozen pins unchanged. */
export const codexRuntimeProfiles = Object.freeze([
  Object.freeze({version: '0.153.3', sha256: 'bc15d59a3062bf165181a30007c3d0f5b1ee0ca4855e33d9b486ad59c984a31b'}),
  Object.freeze({version: '0.153.4', sha256: 'a1cf6360ca71918d5466bc3a32d9f18b7044c9128756d1949e715d277b88c9b6'}),
  Object.freeze({version: '0.153.4', sha256: 'e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75'}),
  // Exact local build verified with isolated runtime preflight on 2026-09-09.
  Object.freeze({version: '0.153.4', sha256: 'ccdc9eb9dd71fbcfb03ad42c4eca2b0d6ff6fbd32ebe9416550e6244561e559b'}),
  // OpenAI-signed Windows x64 release downloaded from rust-v0.153.4 and
  // verified by Authenticode before the isolated runtime/account preflight.
  Object.freeze({version: '0.153.4', sha256: '444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b'}),
  // Exact desktop runtime verified with an isolated, no-inference feature
  // preflight on 2026-09-22. Pre-release versions remain exact-match only.
  Object.freeze({version: '0.155.0-alpha.9.2', sha256: 'bc45017e8239dc150258f69309ced9df6bbcdf5b8e4f346decf780ac0999e226'}),
]);

export function supportedCodexVersion(version: unknown): version is string {
  return typeof version === 'string' && codexRuntimeProfiles.some(profile => profile.version === version);
}

export function parseCodexVersion(output: string): string | null {
  const match = /^codex-cli ([0-9A-Za-z.-]+)$/.exec(output.trim());
  return match && supportedCodexVersion(match[1]) ? match[1] : null;
}
