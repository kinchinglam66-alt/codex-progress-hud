import {configDefaults, defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Review snapshots are evidence, not a second executable test suite.
    exclude: [...configDefaults.exclude, '.superpowers/**', '.worktrees/**'],
  },
});
