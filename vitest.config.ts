import {configDefaults, defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Review snapshots are evidence; research supplements have standalone
    // Python and node:test verifiers documented in research/eta-v1.7/README.md.
    exclude: [...configDefaults.exclude, '.superpowers/**', '.worktrees/**', 'research/**'],
  },
});
