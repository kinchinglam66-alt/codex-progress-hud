# Contributing

Thank you for improving Codex Progress HUD.

## Before opening a change

For behavior changes, open an issue describing the user-visible problem, privacy impact, and how the change will be verified. Small documentation corrections can go directly to a pull request.

## Development workflow

1. Create a feature branch from `main`.
2. Write a failing behavior test and run it to confirm the intended failure.
3. Implement the smallest change that passes the test.
4. Run `npm test -- --run`, `npm run typecheck`, `npm run build`, and `npm run validate:plugin`.
5. Update privacy and threat-model documentation when data flow or permissions change.
6. Keep commits focused and use clear imperative messages.

Do not commit private Codex conversations, prompts, command output, credentials, generated bearer tokens, local databases, or screenshots containing unrelated source code.

## Pull requests

Explain the behavior change, include verification output, identify security or privacy effects, and mention any experimental Codex interface involved. Maintainers may request changes when a contribution relies on undocumented GUI internals or creates a new network/data-retention surface without an explicit design.

Contributions are accepted under Apache-2.0 as described in the repository license.

