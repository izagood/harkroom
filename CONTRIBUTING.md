# Contributing to murmur

Thank you for your interest in contributing to murmur! This document outlines the process for contributing code, documentation, and bug fixes.

## Branch and Pull Request Flow

1. Create a branch from `main` for your work:
   ```sh
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-description
   ```

2. Make your changes and commit them with descriptive messages.

3. Push your branch and create a pull request against `main`.

4. Ensure all CI checks pass before requesting review.

5. After CI is green, merge the PR with a merge commit (`gh pr merge <n> --merge --delete-branch`). This repository keeps the branch history rather than squashing.

## Commit Message Format

Use the format: `type(scope): description (#issueNumber)`

Examples:
- `feat(channel): add thread pinning support (#123)`
- `fix(auth): resolve rate limit bypass on /ws-ticket (#456)`
- `docs(readme): add environment variables table (#273)`
- `refactor(agent): simplify poll timeout handling (#789)`

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `refactor`: Code refactoring (no functional change)
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

## Language Convention

**All comments and commit messages must be in Korean.** This includes:
- Code comments
- Commit titles and bodies
- GitHub PR titles and descriptions

This repository uses Korean as the primary language for human communication. Do not use CJK characters (Chinese, Japanese, Korean) other than Korean in any text content. To verify:

```sh
# Check for non-Korean CJK in recent commits
git log origin/main..HEAD --format='%s%n%b' | grep -nP '[\x{4e00}-\x{9fff}\x{3040}-\x{30ff}]'

# Check for non-Korean CJK in diff
git diff origin/main...HEAD | grep -nP '[\x{4e00}-\x{9fff}\x{3040}-\x{30ff}]'

# Check untracked files
git ls-files -o --exclude-standard | xargs grep -lnP '[\x{4e00}-\x{9fff}\x{3040}-\x{30ff}]'
```

## CI Checks

The CI pipeline (see `.github/workflows/ci.yml`) runs:

1. **Type check**: `pnpm typecheck` — verifies TypeScript types across all packages
2. **Tests**: `pnpm test` — runs all unit and integration tests

Both checks must pass for PRs to be merged.

## Running Tests

Tests require Docker because the server tests use testcontainers to spin up a PostgreSQL container:

```sh
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @murmur/server test
pnpm --filter @murmur/agent test
```

## Regression Testing Convention

When fixing a bug or adding a new feature, write a regression test that:
1. Fails with the bug present (RED)
2. Passes after the fix (GREEN)

To verify a test is meaningful:
1. Write the test
2. Confirm it passes
3. Temporarily revert your fix to confirm the test fails (goes RED)
4. Restore your fix

A test that passes both before and after your change does not prove anything about the behavior you're fixing.

## Getting Help

- Open an issue for bug reports or feature requests
- Use discussions for questions
- Check the design document at `docs/design.md` for architecture details