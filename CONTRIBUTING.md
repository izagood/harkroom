# Contributing to harkroom

Thank you for your interest in contributing to harkroom! This document outlines the process for contributing code, documentation, and bug fixes.

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

### Waiting for CI before merging

"CI is green" means *every registered check has a terminal, successful conclusion*. If you
automate this wait, two states are easy to misread as success — both have actually caused
premature merges in this repository:

**An empty check list is not success.** Right after a push, `statusCheckRollup` is `[]`
because the workflows have not registered yet. Require `total > 0` before you look at
whether anything is pending.

**`conclusion` arrives as an empty string, not `null`.** A running check looks like this:

```json
{ "name": "check", "conclusion": "", "status": "IN_PROGRESS" }
```

So `jq`'s alternative operator does the wrong thing: `.conclusion // .status` yields `""`,
because `//` only falls through on `null` and `false` — not on `""`. Test the emptiness
explicitly:

```sh
gh pr view <n> --json statusCheckRollup --jq '
  [ (.statusCheckRollup // [])[]
    | { n: .name,
        v: (if (.conclusion // "") == "" then (.status // "PENDING") else .conclusion end) } ]
  | { total:   length,
      pending: [ .[] | select(.v | test("^(PENDING|IN_PROGRESS|QUEUED|WAITING|REQUESTED)$")) ] | length,
      bad:     [ .[] | select(.v | test("^(FAILURE|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE)$")) ] | length }'
```

Merge only when `total > 0 && pending == 0 && bad == 0`. `gh run watch <run-id> --exit-status`
is a simpler alternative when you already know the run id.

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

### A green local typecheck does not mean CI will pass

CI checks the **merge of your branch with `main`**, not your branch. So a PR can fail on a
type error that does not exist in either one:

```
test/i18n.test.tsx(395,13): error TS2739: Type '{ ... }' is missing the following
properties from type '{ ... }': onOpenAgentConfig, onOpenProfile
```

Here `main` had added two required props to a component while the branch was in review,
and the branch's own test helper — written before those props existed — still compiled
cleanly on its own base. Neither side was broken; only their merge was.

**This is not a merge conflict.** Git had nothing to resolve: the two commits touched
different files. Conflicts are textual, and this failure is semantic — a caller in one
commit and a signature in the other. `mergeable=MERGEABLE` on the PR says nothing about it.

Before pushing to a PR that has been open while other work merged, rebase and re-check:

```sh
git fetch origin && git rebase origin/main
cd packages/desktop && ./node_modules/.bin/tsc -p .
```

If you rebase to fix this, use `--force-with-lease` rather than `--force` so a push
cannot silently discard commits someone else added to the branch.

### Verify against the CI engine, not your local one

CI runs **Node 22** (`.github/workflows/ci.yml`), and `package.json` declares
`engines: { node: ">=22" }` — 22 is the floor the code must clear. A newer local Node will
happily run APIs that do not exist there:

```
TypeError: Intl.DurationFormat is not a constructor    ← Node 23+ only
```

Fifty-one tests failed in CI on that one line while passing locally on Node 24.

To actually test on the floor, **call the binary directly**. `npx` does not do this — it
falls back to the system Node and the version pin is silently lost:

```sh
mise exec node@22 -- node -e 'console.log(process.version)'      # v22.23.1
mise exec node@22 -- npx node -e 'console.log(process.version)'  # v24.3.0  ← leaks
```

Because this is a pnpm workspace, `vitest` lives inside each package rather than at the
root:

```sh
cd packages/desktop
<path-to-node-22>/bin/node ./node_modules/vitest/vitest.mjs run
```

Checking that a browser engine has an API is not the same check. Deployment runs
JavaScriptCore, which had `Intl.DurationFormat` — the gap was the `engines` floor, and
only running on 22 finds it.

## Keychain prompts on every dev rebuild

If macOS asks for your login-keychain password every time you rebuild the desktop app —
once per runner, so six agents means six dialogs — the cause is the signature, not a
missing one.

On Apple silicon the linker ad-hoc signs the binary automatically, and **an ad-hoc
signature's designated requirement is the content hash itself**:

```
$ codesign -d --requirements - src-tauri/target/debug/harkroom-desktop
designated => cdhash H"af98102fc08f1de24bfa18d2ddaf994d0a953b65"
```

Keychain ACLs are matched against that requirement, so a rebuild changes the hash and
macOS treats it as a different app. Pinning an ad-hoc signature is impossible — the hash
*is* the identity.

Signing with a named certificate removes the hash from the requirement:

```
designated => identifier "app.harkroom.desktop.dev" and anchor apple generic
              and certificate leaf[subject.OU] = <TEAMID>
```

Two builds then match character for character, and one approval holds.

`packages/desktop/scripts/sign-dev.sh` already does this — it runs as a cargo `runner`
hook before the binary starts, and it **exits quietly when the identity is absent** so
that machines without a certificate keep working exactly as before. It defaults to an
identity named `murmur-dev`, which you would create yourself in Keychain Access; the
private key cannot live in the repository.

**You do not need to create one if you already have an Apple developer certificate.** Any
codesigning identity produces a hash-free requirement. Point the script at it with the
same environment variable the release signer uses:

```sh
security find-identity -v -p codesigning   # pick a name from the list
export MURMUR_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
pnpm -C packages/desktop tauri dev
```

The first launch after switching signatures still prompts once, because the stored ACL
holds the *old* requirement. Answer **"Always Allow"** (not "Allow") so the new
requirement is recorded — subsequent rebuilds stay silent.

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

## When your change needs a newer server

The desktop app and the harkroom server ship as **separate artifacts**. The app auto-updates;
the server is redeployed by hand. So a released app is routinely talking to a server that is
several releases behind — and that is normally fine.

It stops being fine the moment your change **calls something the old server does not have**:
a new route, a new field the app requires, a new WS event it depends on. Then the feature is
dead on every server that has not been redeployed, and nothing on screen says why.

**In that PR, raise the floor:**

```ts
// packages/shared/src/compat.ts
export const MIN_SERVER_VERSION = '0.1.167';
```

Set it to the release that first contains the server side of your change, and **add a row to
the table in that file's doc comment** saying what breaks below it. The table is the whole
point: without it nobody can tell later whether the number can move, and the value decays
into a magic constant.

The app compares it against what `GET /healthz` reports and draws a **danger** banner and row
(*"redeploy the server"*) when the server is below the floor. A server that is merely behind —
but above the floor — gets a quiet note instead, no alarm.

Two rules keep the value meaningful, both enforced by `packages/shared/test/compat.test.ts`:

- **Never raise it to a version that does not exist yet.** Requiring an unreleased server
  makes every server on earth "too old", and no redeploy can clear the warning.
- **Never raise it "just to stay current".** If the app does not actually break below the old
  floor, leave it. A floor that tracks the release number is true almost always, and a warning
  that is on almost always is one nobody reads.

## Getting Help

- Open an issue for bug reports or feature requests
- Use discussions for questions
- Check the design document at `docs/design.md` for architecture details