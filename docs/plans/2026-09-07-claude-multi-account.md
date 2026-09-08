# 러너의 claude 다중 계정 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 러너가 계정별 `CLAUDE_CONFIG_DIR` 로 claude 를 띄우고, 한도·자격증명 실패를 만나면 다음 계정으로 같은 멘션을 다시 시도한다.

**Architecture:** codex 의 `CODEX_HOME` 격리(`turn.ts::childEnv` + `codexHome.ts`)와 같은 모양을 claude 쪽에 하나 더 만든다. 계정 풀은 `~/.murmur-agent/claude-accounts/<name>/` 의 하위 디렉터리 목록이고, 페일오버는 `main.ts` 멘션 루프의 기존 catch 위에 계정 축 하나를 더한다. 세션 무효화는 `mentionTurn.ts` 가 harness 변경에 대해 이미 하는 것과 같은 자리·같은 코드 모양을 쓴다.

**Tech Stack:** TypeScript(ESM, NodeNext), vitest, node-pty. 패키지는 `packages/agent` 하나. 서버·DB·데스크탑은 안 건드린다.

**Spec:** `docs/specs/2026-09-07-claude-multi-account-design.md`

## Global Constraints

- 주석·로그·커밋 메시지는 **한국어**. 코드 식별자는 영어. 저장소 전체 규약이다.
- 테스트 명령은 저장소 루트에서 `pnpm --filter @murmur/agent test`. 단일 파일은 `pnpm --filter @murmur/agent test <파일명>`.
- **비밀을 로그·argv 에 올리지 않는다.** 계정은 **이름만** 적는다. 이메일·토큰·Keychain 서비스명은 적지 않는다(`turn.ts` 의 PAT 규율과 같다).
- 계정 이름 문법은 `^[a-z0-9-]{1,32}$` — `config.ts::INSTANCE_PATTERN` 과 같은 값이다. 경로 세그먼트가 되므로.
- 계정 풀이 비면 `CLAUDE_CONFIG_DIR` 를 **주입하지 않는다**. 기존 동작(시스템 기본 `~/.claude`)이 그대로 유지되어야 한다. 하위 호환이 여기 걸려 있다.
- 새 env 이름 두 개: `MURMUR_CLAUDE_ACCOUNTS_DIR`(뿌리), `MURMUR_CLAUDE_ACCOUNTS`(쉼표 구분 순서·부분집합).
- 잘못된 설정은 **조용히 무시하지 않고 기동을 실패시킨다**(`config.ts::validateInstance` 의 판례).
- 각 태스크는 RED → GREEN → 커밋으로 끝난다. 커밋 하나에 테스트와 구현을 함께 담는다(저장소의 기존 커밋 관행).

---

### Task 1: 미로그인 문구를 자격증명 실패로 판정한다

계정 전환의 방아쇠 절반이 이 판정이다. 먼저 고쳐야 뒤 태스크가 기댈 수 있다.

**Files:**
- Modify: `packages/agent/src/policy.ts` — `HARNESS_CREDENTIAL_PATTERNS` 배열
- Test: `packages/agent/test/policy.test.ts`

**Interfaces:**
- Consumes: 없음(첫 태스크)
- Produces: `isCredentialFailure(err)` 가 미로그인 문구에 `'harness-credential'` 을 돌려준다. Task 5 의 페일오버 방아쇠가 이것을 읽는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/policy.test.ts` 의 `isCredentialFailure` describe 블록 안에 더한다.

```ts
  // 2026-09-07 실측: 계정별 CLAUDE_CONFIG_DIR 에 로그인이 없으면 claude 2.1.263 은
  // `Not logged in · Please run /login` 을 내고 종료 코드 1 로 죽는다. 기존 패턴 다섯
  // 개 중 어느 것도 이 문구를 잡지 못해, 러너는 3회 재시도를 태운 뒤 "운영자 확인이
  // 필요합니다"라는 엉뚱한 안내를 남겼다.
  it('미로그인 문구를 harness 자격증명 실패로 본다', () => {
    expect(isCredentialFailure(new Error('harness 종료 1: Not logged in · Please run /login')))
      .toBe('harness-credential');
  });

  // PTY(cols 120) 소프트랩은 어느 자리에든 개행을 끼워 넣는다 — 공백을 전부 지우고
  // 맞추는 이 파일의 규율이 이 문구에도 성립해야 한다.
  it('소프트랩으로 개행이 낀 미로그인 문구도 잡는다', () => {
    expect(isCredentialFailure(new Error('harness 종료 1: Not logged\r\nin · Please run /login')))
      .toBe('harness-credential');
  });

  // 오탐 방어: 사람이 `/login` 을 입력하라고 안내하는 무관한 실패를 자격증명 실패로
  // 오판하면, 러너가 멀쩡한 계정을 버리고 다음 계정으로 넘어간다.
  it('`/login` 만 있는 무관한 문구는 자격증명 실패가 아니다', () => {
    expect(isCredentialFailure(new Error('harness 종료 1: try /login next time')))
      .toBe('other');
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/agent test policy`
Expected: FAIL — 앞의 두 테스트가 `'other'` 를 받아 떨어진다. 세 번째는 이미 통과한다.

- [ ] **Step 3: 최소 구현**

`packages/agent/src/policy.ts` 의 `HARNESS_CREDENTIAL_PATTERNS` 마지막 원소 뒤에 더한다.

```ts
  // 2026-09-07 실측(claude 2.1.263): 계정별 `CLAUDE_CONFIG_DIR` 에 로그인이 없으면
  // `Not logged in · Please run /login`, 종료 코드 1. 위 다섯 패턴 어디에도 안 걸려
  // 러너는 이것을 일시 실패로 보고 3회를 태운 뒤 `FAILURE_NOTICE` 만 남겼다 —
  // 정작 필요한 일은 그 디렉터리에서 로그인 한 번이었다.
  //
  // `/login` 이 아니라 `notloggedin` 으로 맞추는 이유: `/login` 은 사람의 프롬프트에도
  // 흔히 나오는 짧은 토큰이다. 이 파일 머리의 `#380` 절이 그 오탐 경로를 이미 적어 뒀다 —
  // 지금 프로덕션 경로에서는 프롬프트가 tail 에 안 섞이지만, 짧은 패턴을 넣어 두면
  // 그 보호가 사라지는 날 조용히 오탐한다.
  /notloggedin/i,
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/agent test policy`
Expected: PASS — 세 테스트 모두. 기존 테스트도 그대로 통과한다.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/policy.ts packages/agent/test/policy.test.ts
git commit -m "fix(agent): 미로그인 문구를 harness 자격증명 실패로 판정한다

실측(claude 2.1.263): CLAUDE_CONFIG_DIR 에 로그인이 없으면
\`Not logged in · Please run /login\` 을 내고 1 로 죽는다. 기존 패턴 다섯 개가
이것을 못 잡아 3회 재시도를 태운 뒤 \"운영자 확인이 필요합니다\"를 남겼다."
```

---

### Task 2: 계정 풀 모듈

**Files:**
- Create: `packages/agent/src/claudeAccounts.ts`
- Create: `packages/agent/test/claudeAccounts.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export const CLAUDE_ACCOUNT_PATTERN: RegExp` — `/^[a-z0-9-]{1,32}$/`
  - `export function claudeAccountsRoot(env?: NodeJS.ProcessEnv): string`
  - `export interface ClaudeAccount { name: string; configDir: string }`
  - `export async function loadClaudeAccounts(opts?: { root?: string; order?: string | undefined }): Promise<ClaudeAccount[]>`

  Task 3 이 `ClaudeAccount['configDir']` 를 `childEnv` 에 넘기고, Task 5 가 `loadClaudeAccounts` 의 배열을 순회한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/claudeAccounts.test.ts` 를 새로 만든다.

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { claudeAccountsRoot, loadClaudeAccounts } from '../src/claudeAccounts.js';

async function fixture(names: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'murmur-claude-accounts-'));
  for (const name of names) await mkdir(join(root, name), { recursive: true });
  return root;
}

describe('claudeAccountsRoot', () => {
  it('기본 뿌리는 상태 디렉터리 밖의 공용 경로다', () => {
    // 계정은 에이전트·인스턴스·서버를 가로지르는 자산이다 — 러너 상태 디렉터리 안에
    // 두면 에이전트마다 다시 로그인해야 한다.
    expect(claudeAccountsRoot({} as NodeJS.ProcessEnv)).toMatch(/\.murmur-agent\/claude-accounts$/);
  });

  it('MURMUR_CLAUDE_ACCOUNTS_DIR 로 뿌리를 옮길 수 있다', () => {
    expect(claudeAccountsRoot({ MURMUR_CLAUDE_ACCOUNTS_DIR: '/tmp/pool' } as NodeJS.ProcessEnv))
      .toBe('/tmp/pool');
  });
});

describe('loadClaudeAccounts', () => {
  it('하위 디렉터리를 사전순으로 돌려준다', async () => {
    // 순서가 예측 가능해야 로그를 읽고 다음 계정을 알 수 있다.
    const root = await fixture(['cedar', 'aria', 'personal']);
    const accounts = await loadClaudeAccounts({ root });
    expect(accounts.map((a) => a.name)).toEqual(['aria', 'personal', 'cedar']);
    expect(accounts[0]!.configDir).toBe(join(root, 'aria'));
  });

  it('뿌리가 없으면 빈 배열이다 — 오류가 아니다', async () => {
    // 풀을 안 만든 사람이 압도적으로 많다. 그 경우가 정상 경로여야 기존 동작이 유지된다.
    expect(await loadClaudeAccounts({ root: '/nonexistent/murmur/pool' })).toEqual([]);
  });

  it('디렉터리가 아닌 것은 계정이 아니다', async () => {
    const root = await fixture(['aria']);
    await writeFile(join(root, 'README.md'), 'not an account');
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['aria']);
  });

  it('이름 문법에 안 맞는 디렉터리는 건너뛴다', async () => {
    // 사람이 `.DS_Store` 나 `Lime Backup` 같은 것을 만들어 둘 수 있다. 그것을 계정으로
    // 세면 러너가 없는 로그인을 가리키고, 그 실패는 계정 축을 한 칸 헛돌게 만든다.
    const root = await fixture(['aria', 'Lime Backup', '.hidden']);
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['aria']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 순서와 부분집합을 정한다', async () => {
    const root = await fixture(['aria', 'personal', 'cedar']);
    const accounts = await loadClaudeAccounts({ root, order: 'cedar,aria' });
    expect(accounts.map((a) => a.name)).toEqual(['cedar', 'aria']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 의 공백을 무시한다', async () => {
    const root = await fixture(['aria', 'cedar']);
    expect((await loadClaudeAccounts({ root, order: ' cedar , aria ' })).map((a) => a.name))
      .toEqual(['cedar', 'aria']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 에 없는 계정이 오면 기동을 실패시킨다', async () => {
    // 조용히 무시하면 운영자가 계정 B 라고 믿고 띄운 러너가 A 로 돈다 —
    // config.ts::validateInstance 와 같은 판단이다.
    const root = await fixture(['aria']);
    await expect(loadClaudeAccounts({ root, order: 'aria,ghost' }))
      .rejects.toThrow(/ghost/);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 빈 문자열이면 지정이 없는 것으로 본다', async () => {
    const root = await fixture(['aria', 'cedar']);
    expect((await loadClaudeAccounts({ root, order: '' })).map((a) => a.name))
      .toEqual(['aria', 'cedar']);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeAccounts`
Expected: FAIL — `Cannot find module '../src/claudeAccounts.js'`

- [ ] **Step 3: 최소 구현**

`packages/agent/src/claudeAccounts.ts` 를 새로 만든다.

```ts
// claude 계정 풀(#다중계정). 계정 하나 = `CLAUDE_CONFIG_DIR` 하나다.
//
// **왜 이 축이 성립하는가**(2026-09-07 실측, claude 2.1.263): macOS 의 claude 는 자격증명을
// Keychain 에서 먼저 읽고 **서비스 이름을 `CLAUDE_CONFIG_DIR` 경로의 sha256 앞 8자로
// 파생한다**(미설정이면 `Claude Code-credentials`). 파일 폴백은 `<configDir>/.credentials.json`.
// 즉 config 디렉터리를 바꾸면 자격증명이 통째로 갈린다 — 빈 디렉터리를 주고 `claude -p` 를
// 돌리면 `Not logged in · Please run /login` 이 뜬다. 세션 파일(`<configDir>/projects`)도
// 같이 따라간다(그래서 `claudeSessions.ts` 가 이 값을 받아야 한다).
//
// **계정 뿌리는 러너 상태 디렉터리 밖이다.** `codexHome` 은 러너별로 격리하는 것이 목적
// (개인 config.toml 을 물려주지 않는다)이지만, 계정은 그 반대다 — 에이전트·인스턴스·서버를
// 가로지르는 자산이고, `resolveAgentStateDir` 아래 두면 에이전트마다 다시 로그인해야 한다.
//
// **목록의 진실은 디스크다.** 별도 설정 파일을 두지 않는다. 파일을 두면 파일과 디스크가
// 갈리는 날이 오고, 그날 러너는 없는 계정을 가리킨다(`ensureCodexHome` 이 `auth.json` 의
// 존재로 판정하는 것과 같은 규율).
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 계정 이름 문법. `config.ts::INSTANCE_PATTERN` 과 **같은 값**이고 같은 이유다 — 이 이름이
 * 경로 세그먼트가 되므로 `..` 나 `/` 가 들어올 여지를 문법에서 끊는다.
 */
export const CLAUDE_ACCOUNT_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface ClaudeAccount {
  name: string;
  /** 이 계정의 `CLAUDE_CONFIG_DIR`. 자격증명·세션·설정이 모두 이 아래 있다. */
  configDir: string;
}

/** 계정 풀의 뿌리. `MURMUR_CLAUDE_ACCOUNTS_DIR` 로 옮길 수 있다(테스트와 다른 볼륨용). */
export function claudeAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.MURMUR_CLAUDE_ACCOUNTS_DIR ?? join(homedir(), '.murmur-agent', 'claude-accounts');
}

/**
 * 계정 풀을 읽는다. **빈 배열은 정상이다** — 풀을 안 만든 러너는 `CLAUDE_CONFIG_DIR` 주입
 * 없이 시스템 기본(`~/.claude`)을 쓴다. 하위 호환이 그 한 줄에 걸려 있다.
 *
 * `order` 는 `MURMUR_CLAUDE_ACCOUNTS`(쉼표 구분)다. 순서와 부분집합을 동시에 정한다.
 * 없는 이름이 오면 **던진다**: 조용히 무시하면 운영자가 계정 B 라고 믿고 띄운 러너가 A 로
 * 돌고, 그 사고는 화면에 아무 흔적을 남기지 않는다(`config.ts::validateInstance` 판례).
 */
export async function loadClaudeAccounts(
  opts: { root?: string; order?: string | undefined } = {},
): Promise<ClaudeAccount[]> {
  const root = opts.root ?? claudeAccountsRoot();

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // 뿌리가 없다 = 계정을 하나도 안 만들었다. "없음"의 정상 경로이지 에러가 아니다
    // (`claudeSessions.ts` 의 같은 판단과 짝을 이룬다).
    return [];
  }

  // 사전순으로 고정한다 — 순서가 예측 불가능하면 로그를 읽어도 다음 계정을 알 수 없다.
  // 문법에 안 맞는 이름은 여기서 걸러 낸다: `.DS_Store` 나 `Lime Backup` 같은 것을 계정으로
  // 세면 러너가 없는 로그인을 가리키고, 계정 축이 한 칸 헛돈다.
  const found = entries
    .filter((e) => e.isDirectory() && CLAUDE_ACCOUNT_PATTERN.test(e.name))
    .map((e) => e.name)
    .sort();

  const order = (opts.order ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!order.length) return found.map((name) => ({ name, configDir: join(root, name) }));

  const missing = order.filter((name) => !found.includes(name));
  if (missing.length) {
    throw new Error(
      `MURMUR_CLAUDE_ACCOUNTS 에 없는 계정이 있다: ${missing.join(', ')}. ` +
      `${root} 아래에 있는 계정은 ${found.length ? found.join(', ') : '(없음)'} 이다.`,
    );
  }
  return order.map((name) => ({ name, configDir: join(root, name) }));
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeAccounts`
Expected: PASS — 9개 전부.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/claudeAccounts.ts packages/agent/test/claudeAccounts.test.ts
git commit -m "feat(agent): claude 계정 풀을 읽는다

계정 하나 = CLAUDE_CONFIG_DIR 하나다. 목록의 진실은 디스크이고,
뿌리는 러너 상태 디렉터리 밖(계정은 에이전트를 가로지르는 자산이다).
풀이 비면 빈 배열 — 기존 동작이 그대로 유지된다."
```

---

### Task 3: 자식 env 에 `CLAUDE_CONFIG_DIR` 를 넣고 인증 주입 키를 지운다

**Files:**
- Modify: `packages/agent/src/turn.ts` — `HARNESS_ENV_DENYLIST`, `childEnv`, `buildTurnCommand` 의 `env:` 줄, `BuildTurnCommandOpts`(`claudeConfigDir` 추가)
- Test: `packages/agent/test/turn.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `ClaudeAccount['configDir']`(문자열)
- Produces: `buildTurnCommand` 가 `claudeConfigDir: string | null` 을 받는다. `harness === 'claude-code'` 이고 값이 `null` 이 아닐 때만 자식 env 에 `CLAUDE_CONFIG_DIR` 가 들어간다. Task 4·5 가 이 옵션을 채운다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/turn.test.ts` 에 describe 를 더한다. **이 파일 12행의 기존 `base` 상수를 그대로 재사용한다** — 새 헬퍼를 만들지 않는다. 기존 호출들이 `{ ...base, harness, mode, sessionId, isFirstTurn }` 형태로 부르므로 같은 형태를 쓴다.

`base` 에 `claudeConfigDir` 를 넣지 **않는다**: 넣으면 기존 테스트 전부가 그 값으로 돌아 "풀이 없을 때"를 아무도 안 재게 된다. 각 테스트가 명시로 넘긴다. 대신 Task 3 의 구현에서 이 필드를 필수로 만들면 `base` 를 쓰는 기존 호출이 타입 오류를 낸다 — 그때 `base` 에 `claudeConfigDir: null` 을 더해 "기본은 계정 지정 없음"을 기존 테스트 전체의 전제로 고정한다.

```ts
describe('계정별 CLAUDE_CONFIG_DIR 주입', () => {
  it('claude 는 CLAUDE_CONFIG_DIR 를 받는다', () => {
    const plan = buildTurnCommand({ ...base, claudeConfigDir: '/pool/aria' });
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe('/pool/aria');
  });

  it('풀이 없으면(null) 주입하지 않는다 — 시스템 기본을 쓴다', () => {
    // 하위 호환이 이 한 줄에 걸려 있다. 빈 문자열을 넣으면 claude 가 그것을 경로로 읽어
    // cwd 아래에 설정을 만든다 — 그래서 "없음"은 반드시 키의 부재여야 한다.
    const plan = buildTurnCommand({ ...base, claudeConfigDir: null });
    expect('CLAUDE_CONFIG_DIR' in plan.env).toBe(false);
  });

  it('codex 에는 주입하지 않는다', () => {
    const plan = buildTurnCommand({
      ...base, harness: 'codex', sessionId: null, codexHome: '/state/codex-home',
      claudeConfigDir: '/pool/aria',
    });
    expect('CLAUDE_CONFIG_DIR' in plan.env).toBe(false);
    expect(plan.env.CODEX_HOME).toBe('/state/codex-home');
  });
});

describe('인증 주입 env 를 자식에게 넘기지 않는다', () => {
  // CLAUDE_CONFIG_DIR 격리는 이 키들 앞에서 무력하다 — claude 는 이것을 먼저 쓴다.
  // 러너는 데몬 env 전체를 상속하므로(runnerLauncher 는 MURMUR_PAT·MURMUR_URL·PATH 만
  // 덮어쓴다) 이 키가 어디서 들어올지 통제할 수 없다. 계정을 바꿨는데 안 바뀌는
  // 이번 결함의 다른 얼굴이라 여기서 끊는다.
  const KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'];

  it.each(KEYS)('%s 를 지운다', (key) => {
    const prev = process.env[key];
    process.env[key] = 'leaked-value';
    try {
      const plan = buildTurnCommand({
        harness: 'claude-code', mode: 'mention', isFirstTurn: true,
        sessionId: '11111111-1111-4111-8111-111111111111',
        model: null, effort: null, systemPrompt: '', systemPromptFile: '/tmp/sp.txt',
        promptCtx: 'hi', mcpConfigPath: '/tmp/mcp.json',
        murmurUrl: 'http://localhost:3400', codexHome: '', pat: 'pat-value',
        stdinFile: '/tmp/prompt.txt', claudeConfigDir: '/pool/aria',
      });
      expect(key in plan.env).toBe(false);
    } finally {
      if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
    }
  });

  it('denylist 에 네 키가 모두 있다', () => {
    for (const key of KEYS) expect(HARNESS_ENV_DENYLIST).toContain(key);
  });
});
```

`HARNESS_ENV_DENYLIST` 를 import 목록에 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/agent test turn`
Expected: FAIL — 타입 오류(`claudeConfigDir` 가 옵션에 없다) 또는 `CLAUDE_CONFIG_DIR` 가 undefined.

- [ ] **Step 3: 최소 구현**

3-1. `HARNESS_ENV_DENYLIST` 를 넓힌다. 상수 위 주석의 마지막 문단("새로 넣을 키는 실측을 먼저 하라") 뒤에 근거를 이어 쓰고 배열을 바꾼다.

```ts
/**
 * ...(기존 주석 유지)...
 *
 * **인증 주입 키 넷(2026-09-07).** `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`·
 * `CLAUDE_CODE_OAUTH_TOKEN`·`AWS_BEARER_TOKEN_BEDROCK` 는 claude 가 자격증명보다 **먼저**
 * 보는 입력이다. 하나라도 부모 env 에 있으면 아래 `CLAUDE_CONFIG_DIR` 격리가 **조용히**
 * 무력해진다 — 계정을 바꿨는데 안 바뀌는 이번 결함의 다른 얼굴이다.
 *
 * 러너는 데몬 env 전체를 상속하고(`desktop/src/lib/runnerLauncher.ts` 의
 * `daemon_spawn_runner` 는 `MURMUR_PAT`·`MURMUR_URL`·`PATH` 만 넘긴다) 데몬은 자기를 띄운
 * 셸의 env 를 상속한다 — 즉 이 키가 어디서 들어올지 우리가 통제할 수 없다. 그래서 상속을
 * 막는 쪽이 맞다.
 *
 * 실측 근거: Orca 도 claude 를 계정별 `CLAUDE_CONFIG_DIR` 로 띄우면서 정확히 이 넷을
 * 지운다(`stripAuthEnv`). 같은 목적에 같은 목록이 필요하다는 독립 확인이다.
 *
 * **API 키로 러너를 돌리던 사람에게는 파괴적 변경이다.** 그러나 `config.ts` 가 이미
 * "claude-code harness 는 claude CLI 의 자격증명을 쓰므로 API 키도 필요 없다"고 적어 뒀다 —
 * 지원한 적 없는 경로다.
 */
export const HARNESS_ENV_DENYLIST = [
  'CLAUDE_CODE_CHILD_SESSION',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const;
```

3-2. `childEnv` 의 시그니처를 옵션 객체로 바꾼다. 인자가 셋이 되면 호출부에서 `null, x` 같은 위치 인자가 읽히지 않는다.

```ts
function childEnv(
  pat: string,
  homes: { codexHome: string | null; claudeConfigDir: string | null },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // 부모에 있어도 자식에는 없어야 하는 키를 뺀다(#374). 복사 뒤에 지우는 이유: 복사 루프에
  // 조건을 섞으면 '전체 상속'이라는 규칙과 그 예외가 한 줄에 엉켜 둘 다 읽기 어려워진다.
  for (const key of HARNESS_ENV_DENYLIST) delete env[key];
  env.MURMUR_PAT = pat;
  if (homes.codexHome !== null) env.CODEX_HOME = homes.codexHome;
  // **`null` 이면 키 자체를 넣지 않는다.** 빈 문자열을 넣으면 claude 가 그것을 경로로 읽어
  // 엉뚱한 자리에 설정을 만든다 — "계정 지정 없음"은 부재로 표현해야 시스템 기본으로 떨어진다.
  if (homes.claudeConfigDir !== null) env.CLAUDE_CONFIG_DIR = homes.claudeConfigDir;
  return env;
}
```

3-3. `BuildTurnCommandOpts`(`buildTurnCommand` 가 받는 옵션 인터페이스, `codexHome: string;` 이 선언된 그 인터페이스)에 필드를 더한다.

```ts
  /**
   * 이 턴을 돌릴 claude 계정의 `CLAUDE_CONFIG_DIR`. **`null` 은 '계정 지정 없음'** 이고,
   * 그때 자식은 시스템 기본(`~/.claude`)을 쓴다 — 계정 풀을 안 만든 러너의 정상 경로다.
   *
   * codex 의 `codexHome` 과 대칭이지만 타입이 다른 이유: `codexHome` 은 러너가 언제나
   * 만들어 두므로 빈 문자열이 곧 결함이지만(아래 검사가 그것을 던진다), 계정은 없는 것이
   * 정상이다.
   */
  claudeConfigDir: string | null;
```

3-4. `buildTurnCommand` 의 반환에서 `env` 를 바꾼다.

```ts
    env: childEnv(opts.pat, {
      codexHome: opts.harness === 'codex' ? opts.codexHome : null,
      claudeConfigDir: opts.harness === 'claude-code' ? opts.claudeConfigDir : null,
    }),
```

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/agent test turn`
Expected: PASS. 이 단계에서 `mentionTurn.ts`·`interactiveTurn.ts` 의 `buildTurnCommand` 호출부가 타입 오류를 낸다 — Task 4 가 그것을 채운다. 지금은 두 호출부에 `claudeConfigDir: null` 을 임시로 넣어 타입을 통과시킨다.

Run: `pnpm --filter @murmur/agent typecheck`
Expected: 성공.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/turn.ts packages/agent/test/turn.test.ts packages/agent/src/mentionTurn.ts packages/agent/src/interactiveTurn.ts
git commit -m "feat(agent): 자식 claude 에 계정별 CLAUDE_CONFIG_DIR 를 넘긴다

CODEX_HOME 과 같은 자리·같은 모양이다. null 이면 키를 넣지 않아
시스템 기본이 그대로 쓰인다.

함께 인증 주입 키 넷(ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
CLAUDE_CODE_OAUTH_TOKEN, AWS_BEARER_TOKEN_BEDROCK)을 denylist 에 넣는다 —
하나라도 상속되면 config 디렉터리 격리가 조용히 무력해진다."
```

---

### Task 4: 세션 실재 판정이 계정 디렉터리를 본다

**Files:**
- Modify: `packages/agent/src/claudeSessions.ts` — `claudeSessionFileExists` 의 기본 경로
- Modify: `packages/agent/src/interactiveTurn.ts:178` — `defaultSessionMaterialized` 와 그 호출 경로
- Test: `packages/agent/test/claudeSessions.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `claudeConfigDir: string | null`
- Produces: `claudeSessionFileExists(sessionId, { projectsDir?, configDir? })` — `configDir` 가 있으면 `<configDir>/projects` 를, 없으면 `~/.claude/projects` 를 본다. `projectsDir` 는 기존 테스트가 쓰는 직접 지정으로 계속 이긴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/claudeSessions.test.ts` 의 describe 안에 더한다.

```ts
  it('configDir 가 있으면 그 아래 projects 를 본다', async () => {
    // 세션 파일도 CLAUDE_CONFIG_DIR 를 따라간다(2026-09-07 실측). 이 판정이 계속
    // ~/.claude/projects 를 보면, 계정 디렉터리로 돌린 세션을 "없음"으로 읽어 다음 턴을
    // 첫 턴으로 조립하고, claude 는 이미 쓰인 id 를 --session-id 로 다시 받아
    // `Session ID <uuid> is already in use.` 로 즉사한다.
    const configDir = mkdtempSync(join(tmpdir(), 'murmur-cfg-'));
    const projects = join(configDir, 'projects', '-tmp-work');
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, `${UUID}.jsonl`), '{}\n');

    expect(await claudeSessionFileExists(UUID, { configDir })).toBe(true);
    expect(await claudeSessionFileExists('00000000-0000-4000-8000-000000000000', { configDir }))
      .toBe(false);
  });

  it('configDir 가 없으면 기존 기본값(~/.claude/projects)을 그대로 쓴다', async () => {
    // 풀을 안 만든 러너의 경로다 — 이 동작이 바뀌면 하위 호환이 깨진다.
    const configDir = mkdtempSync(join(tmpdir(), 'murmur-cfg-empty-'));
    const projects = join(configDir, 'projects', '-tmp-work');
    await mkdir(projects, { recursive: true });
    await writeFile(join(projects, `${UUID}.jsonl`), '{}\n');

    // configDir 를 안 주면 위 파일을 못 본다(그 파일은 홈이 아니라 임시 디렉터리에 있다).
    expect(await claudeSessionFileExists(UUID, {})).toBe(false);
  });
```

파일 위쪽 import 에 `mkdtempSync`(`node:fs`), `mkdir`·`writeFile`(`node:fs/promises`), `tmpdir`(`node:os`), `join`(`node:path`)이 없으면 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeSessions`
Expected: FAIL — 첫 테스트가 `false` 를 받는다(`configDir` 를 무시하고 홈을 본다).

- [ ] **Step 3: 최소 구현**

`claudeSessions.ts` 의 함수를 바꾼다. 모듈 머리 주석의 경로 설명 문단 뒤에 근거를 이어 쓴다.

```ts
/**
 * ...(기존 모듈 주석 유지, 아래 문단을 이어 쓴다)...
 *
 * **경로는 `CLAUDE_CONFIG_DIR` 를 따라간다(2026-09-07).** 계정별 config 디렉터리로 claude 를
 * 띄우면 세션 파일도 `<configDir>/projects` 아래로 옮겨간다(실측). 이 판정이 계속 홈을 보면
 * 계정 디렉터리의 세션을 "없음"으로 읽고, 다음 턴이 첫 턴으로 조립돼 claude 가 이미 쓰인
 * 세션 id 를 `--session-id` 로 다시 받아 즉사한다 — 위 문단이 적은 바로 그 함정이다.
 */
export async function claudeSessionFileExists(
  sessionId: string,
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<boolean> {
  // `projectsDir` 가 이긴다 — 기존 테스트가 projects 디렉터리를 직접 가리킨다. 그 다음이
  // 계정 디렉터리, 마지막이 시스템 기본이다(풀을 안 만든 러너의 정상 경로).
  const root = opts.projectsDir
    ?? (opts.configDir ? join(opts.configDir, 'projects') : join(homedir(), '.claude', 'projects'));
  // ...(이하 기존 본문 그대로)
```

`interactiveTurn.ts` 의 `defaultSessionMaterialized` 가 config 디렉터리를 받게 한다.

```ts
const defaultSessionMaterialized = (
  harness: AgentHarness,
  sessionId: string,
  claudeConfigDir: string | null,
): Promise<boolean> => {
  if (harness === 'claude-code') return claudeSessionFileExists(sessionId, { configDir: claudeConfigDir });
  // codex sessionId 는 rollout 파일에서 발견한 값이라 그 자체로 디스크 실재의 증거다.
  return Promise.resolve(true);
};
```

호출부(같은 파일 안에서 `sessionMaterialized(...)` 를 부르는 자리)에 `deps.claudeConfigDir` 를 넘긴다. `InteractiveTurnDeps` 에 필드를 더한다.

```ts
  /**
   * 이 턴을 돌릴 claude 계정의 `CLAUDE_CONFIG_DIR`. `null` 은 계정 지정 없음이다.
   * 자식 env 와 **세션 실재 판정이 같은 값을 봐야 한다** — 갈리면 판정이 엉뚱한
   * 디렉터리를 뒤져 첫 턴/resume 조립이 뒤집힌다(`codexHome` 주석과 같은 이유).
   */
  claudeConfigDir: string | null;
```

`deps.sessionMaterialized` 를 주입받는 옵셔널 훅이 있으면 그 시그니처도 같이 넓힌다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeSessions`
Expected: PASS. 기존 두 테스트(`projectsDir` 지정)도 그대로 통과한다.

Run: `pnpm --filter @murmur/agent typecheck`
Expected: 성공.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/claudeSessions.ts packages/agent/src/interactiveTurn.ts packages/agent/test/claudeSessions.test.ts
git commit -m "fix(agent): 세션 실재 판정이 계정 디렉터리를 본다

세션 파일도 CLAUDE_CONFIG_DIR 를 따라간다. 계속 홈을 보면 계정 디렉터리의
세션을 '없음'으로 읽어 첫 턴으로 조립하고, claude 가 이미 쓰인 세션 id 를
--session-id 로 다시 받아 죽는다."
```

---

### Task 5: 세션 레코드에 계정을 적고, 계정이 바뀌면 무효화한다

계정을 넘어간 세션을 resume 하지 않게 만드는 태스크다. Task 6 의 페일오버가 이것 위에 선다.

**Files:**
- Modify: `packages/agent/src/sessions.ts` — `SessionRecord`, `isSessionRecord`
- Modify: `packages/agent/src/mentionTurn.ts:389-402`(무효화 분기), `MentionTurnDeps`, `buildTurnCommand` 호출부, 레코드를 새로 만드는 자리(`if (!rec)` 블록)
- Test: `packages/agent/test/sessions.test.ts`, `packages/agent/test/mentionTurn.test.ts`

**Interfaces:**
- Consumes: Task 3 의 `claudeConfigDir`, Task 2 의 계정 `name`
- Produces: `SessionRecord.claudeAccount: string | null`. `MentionTurnDeps.claudeAccount: string | null` 과 `MentionTurnDeps.claudeConfigDir: string | null`. Task 6 이 계정마다 이 둘을 바꿔 가며 `runMentionTurn` 을 다시 부른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/sessions.test.ts` 에 더한다.

```ts
  it('claudeAccount 를 저장하고 다시 읽는다', async () => {
    const store = new SessionStore(path);
    await store.load();
    await store.put('k', {
      workspaceDir: '/w', sessionId: null, harness: 'claude-code',
      lastFedSeq: 0, turnsRun: 0, claudeAccount: 'aria',
    });
    const reloaded = new SessionStore(path);
    await reloaded.load();
    expect(reloaded.get('k')?.claudeAccount).toBe('aria');
  });

  it('claudeAccount 가 없는 옛 레코드도 읽는다', async () => {
    // 이 필드 이전에 쓰인 sessions.json 이 이미 디스크에 있다. 검증에서 떨어뜨리면
    // 러너가 기동하면서 모든 스레드의 세션을 잃는다.
    await writeFile(path, JSON.stringify({
      k: { workspaceDir: '/w', sessionId: null, harness: 'claude-code', lastFedSeq: 3, turnsRun: 1 },
    }));
    const store = new SessionStore(path);
    await store.load();
    expect(store.get('k')?.lastFedSeq).toBe(3);
    expect(store.get('k')?.claudeAccount ?? null).toBe(null);
  });
```

`packages/agent/test/mentionTurn.test.ts` 에 더한다. **514행의 기존 테스트**(`harness 를 바꾸면 다음 턴이 isFirstTurn: true 로 조립되고 옛 sessionId 가 남지 않는다`) 바로 아래에, 그 테스트의 셋업·헬퍼를 그대로 재사용한다. 아래 코드의 `store`·`key`·`deps`·`args` 이름은 그 테스트가 실제로 쓰는 이름으로 맞춰라.

```ts
  it('계정이 바뀌면 세션을 버리고 첫 턴으로 다시 시작한다', async () => {
    // 세션 파일은 계정 디렉터리 안에 있어 계정을 넘어가지 않는다. 남겨 두면 `-r <id>` 가
    // 없는 세션을 재개하려 든다. lastFedSeq 를 0 으로 되돌리는 것이 핵심이다 —
    // prompt.ts 의 isFirstTurn 이 그때 스레드 전체를 다시 먹인다.
    // (기존 'harness 가 바뀌면...' 테스트와 같은 셋업을 쓴다)
    await store.put(key, {
      workspaceDir: '/w', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      harness: 'claude-code', lastFedSeq: 7, turnsRun: 2, claudeAccount: 'cedar',
    });

    await runMentionTurn({ ...deps, claudeAccount: 'aria', claudeConfigDir: '/pool/aria' }, args);

    const rec = store.get(key)!;
    expect(rec.claudeAccount).toBe('aria');
    expect(rec.sessionId).not.toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(rec.workspaceDir).toBe('/w'); // 워크스페이스는 재사용한다 — 산출물은 계정과 무관하다
  });

  it('계정이 같으면 세션을 유지한다', async () => {
    await store.put(key, {
      workspaceDir: '/w', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      harness: 'claude-code', lastFedSeq: 7, turnsRun: 2, claudeAccount: 'aria',
    });

    await runMentionTurn({ ...deps, claudeAccount: 'aria', claudeConfigDir: '/pool/aria' }, args);

    expect(store.get(key)!.sessionId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/agent test sessions mentionTurn`
Expected: FAIL — `claudeAccount` 가 타입에 없고, 무효화가 일어나지 않는다.

- [ ] **Step 3: 최소 구현**

5-1. `sessions.ts` 의 `SessionRecord` 에 필드를 더한다.

```ts
  /**
   * 이 세션을 만든 claude 계정 이름(`claudeAccounts.ts`). `null` 은 '계정 지정 없음'
   * (시스템 기본)이거나 이 필드 이전에 쓰인 옛 레코드다.
   *
   * **왜 세션에 적는가**: claude 세션 파일은 `<CLAUDE_CONFIG_DIR>/projects` 아래 있어
   * 계정을 넘어가지 않는다. 계정이 바뀐 뒤 `-r <id>` 를 넘기면 없는 세션을 재개하려 든다.
   * `harness` 를 적어 두는 것과 정확히 같은 이유다 — 그 필드와 같은 분기에서 함께 쓰인다.
   */
  claudeAccount?: string | null;
```

`isSessionRecord` 를 바꾼다.

```ts
function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isPlainObject(value)) return false;
  const { workspaceDir, sessionId, harness, lastFedSeq, turnsRun, claudeAccount } = value;
  return (
    typeof workspaceDir === 'string' &&
    (sessionId === null || typeof sessionId === 'string') &&
    typeof harness === 'string' &&
    (AGENT_HARNESSES as readonly string[]).includes(harness) &&
    typeof lastFedSeq === 'number' &&
    typeof turnsRun === 'number' &&
    // 옵셔널이다 — 이 필드 이전에 쓰인 sessions.json 이 이미 디스크에 있다. 필수로 하면
    // 러너가 기동하면서 모든 스레드의 세션을 조용히 잃는다.
    (claudeAccount === undefined || claudeAccount === null || typeof claudeAccount === 'string')
  );
}
```

5-2. `MentionTurnDeps` 에 필드 둘을 더한다(`codexHome` 옆).

```ts
  /**
   * 이 턴을 돌릴 claude 계정 이름. `null` 은 계정 지정 없음(시스템 기본)이다.
   * 세션 무효화 판정이 이 값을 쓴다.
   */
  claudeAccount: string | null;
  /**
   * 그 계정의 `CLAUDE_CONFIG_DIR`. 자식 env 와 세션 실재 판정이 **같은 값**을 봐야 한다
   * (`codexHome` 주석과 같은 이유).
   */
  claudeConfigDir: string | null;
```

5-3. `mentionTurn.ts:389` 의 무효화 조건을 넓힌다. 기존 주석을 유지하고 문단을 이어 쓴다.

```ts
  // claude 계정도 같은 부류다(2026-09-07): 세션 파일은 `<CLAUDE_CONFIG_DIR>/projects`
  // 아래 있어 계정을 넘어가지 않는다. 남겨 두면 `-r <id>` 가 없는 세션을 재개하려 든다.
  // 잃는 것이 적은 이유: `prompt.ts` 의 `isFirstTurn`(lastFedSeq 0)이 자기 발화를 포함한
  // 스레드 전체를 다시 먹인다 — 하네스 내부 컨텍스트는 잃지만 스레드의 사실은 남는다.
  //
  // `?? null` 로 정규화해서 비교하는 이유: 옛 레코드에는 이 필드가 `undefined` 다.
  // 그것과 "계정 지정 없음"(`null`)은 같은 상태이므로, 정규화 없이 비교하면 풀을 안 쓰는
  // 러너가 기동할 때마다 모든 세션을 헛되이 버린다.
  if (rec && (rec.harness !== def.harness || (rec.claudeAccount ?? null) !== deps.claudeAccount)) {
    rec = {
      workspaceDir: rec.workspaceDir,
      sessionId: preassignsSessionId(def.harness) ? randomUUID() : null,
      harness: def.harness,
      lastFedSeq: 0,
      turnsRun: 0,
      claudeAccount: deps.claudeAccount,
    };
  }
```

5-4. 레코드를 새로 만드는 자리(`if (!rec)` 블록)에도 `claudeAccount: deps.claudeAccount` 를 더한다.

5-5. 같은 파일의 `buildTurnCommand` 호출부에서 Task 3 이 임시로 넣은 `claudeConfigDir: null` 을 `deps.claudeConfigDir` 로 바꾼다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/agent test sessions mentionTurn`
Expected: PASS.

Run: `pnpm --filter @murmur/agent test`
Expected: PASS — 전체 스위트. `main.ts` 가 아직 새 deps 를 안 채웠으면 타입 오류가 난다. 그때는 `main.ts` 의 `deps` 리터럴에 `claudeAccount: null, claudeConfigDir: null` 을 임시로 넣는다(Task 6 이 채운다). `interactiveTurn` 호출부도 같다.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/sessions.ts packages/agent/src/mentionTurn.ts packages/agent/src/main.ts packages/agent/src/interactiveTurn.ts packages/agent/test/sessions.test.ts packages/agent/test/mentionTurn.test.ts
git commit -m "feat(agent): 세션 레코드에 claude 계정을 적고 바뀌면 무효화한다

세션 파일은 계정 디렉터리 안에 있어 계정을 넘어가지 않는다. harness 변경과
같은 분기에서 같은 모양으로 버린다 — 스레드의 사실은 첫 턴 프롬프트로 복원된다.
옛 레코드(필드 없음)는 그대로 읽는다."
```

---

### Task 6: 한도·자격증명 실패에서 다음 계정으로 같은 멘션을 다시 시도한다

**Files:**
- Modify: `packages/agent/src/main.ts` — 기동부(계정 풀 로드), 멘션 루프의 `try`/`catch`
- Test: `packages/agent/test/claudeAccountFailover.test.ts` (신규)

**Interfaces:**
- Consumes: Task 2 `loadClaudeAccounts`, Task 1 `isCredentialFailure`, `isQuotaExhausted`, Task 5 의 `MentionTurnDeps.claudeAccount`/`claudeConfigDir`
- Produces: `export function nextAccountIndex(...)` — 순수 함수로 빼내 루프 없이 검증한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

방아쇠 판정을 순수 함수로 빼내 검증한다. `packages/agent/test/claudeAccountFailover.test.ts` 를 새로 만든다.

```ts
import { describe, expect, it } from 'vitest';

import { ExecutableNotFoundError } from '../src/policy.js';
import { switchesAccount } from '../src/claudeAccounts.js';

describe('계정 전환 방아쇠', () => {
  it('사용량 한도는 계정을 바꾼다', () => {
    // 로그인은 멀쩡하고 시간이 지나면 낫는다 — 그러나 다른 계정이면 지금 낫는다.
    expect(switchesAccount(new Error("harness 종료 1: You've hit your session limit · resets 4:10pm (Asia/Seoul)")))
      .toBe(true);
  });

  it('harness 자격증명 실패는 계정을 바꾼다', () => {
    expect(switchesAccount(new Error('harness 종료 1: Failed to authenticate: OAuth session expired and could not be refreshed')))
      .toBe(true);
  });

  it('미로그인도 계정을 바꾼다', () => {
    expect(switchesAccount(new Error('harness 종료 1: Not logged in · Please run /login')))
      .toBe(true);
  });

  it('murmur PAT 실패는 계정을 바꾸지 않는다', () => {
    // 계정과 무관하다 — 바꿔도 같은 자리에서 실패하고, 러너는 물러나야 한다.
    const err = Object.assign(new Error('unauthorized'), { source: 'murmur-client', status: 401 });
    expect(switchesAccount(err)).toBe(false);
  });

  it('실행 파일 부재는 계정을 바꾸지 않는다', () => {
    // PATH 문제다. 계정을 바꿔도 같은 자리에서 실패한다.
    expect(switchesAccount(new ExecutableNotFoundError('claude', '/usr/bin'))).toBe(false);
  });

  it('평범한 실패는 계정을 바꾸지 않는다 — 재시도 회계로 간다', () => {
    expect(switchesAccount(new Error('harness 종료 1: something else went wrong'))).toBe(false);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeAccountFailover`
Expected: FAIL — `switchesAccount` 가 `claudeAccounts.ts` 에 없다.

- [ ] **Step 3: 최소 구현**

6-1. `claudeAccounts.ts` 에 판정을 더한다. `policy.ts` 가 아니라 여기 두는 이유를 주석에 적는다.

```ts
import { isCredentialFailure, isExecutableNotFound, isQuotaExhausted } from './policy.js';

/**
 * 이 오류에서 **계정을 바꿔 다시 해 볼 만한가**.
 *
 * `policy.ts` 가 아니라 여기 있는 이유: 그 파일은 아무것도 import 하지 않는다는 규율이
 * 있고(파일 머리 주석), 이 판정은 그 파일의 세 판정을 **조합**한다. 조합을 거기 두면
 * 규율이 깨지고, 여기 두면 "계정 축의 판단은 계정 모듈에 있다"가 성립한다.
 *
 * 참인 경우 둘:
 * - **사용량 한도** — 로그인은 멀쩡하고 시간이 지나면 낫지만, 다른 계정이면 **지금** 낫는다.
 * - **harness 자격증명 실패** — 그 계정의 로그인이 만료·부재다. 다른 계정은 멀쩡할 수 있다.
 *
 * 거짓인 경우: murmur PAT 실패(계정과 무관하다 — 러너가 물러나야 한다), 실행 파일 부재
 * (PATH 문제다), 그리고 평범한 실패(기존 재시도 회계로 간다).
 */
export function switchesAccount(err: unknown): boolean {
  if (isExecutableNotFound(err) === 'executable-not-found') return false;
  if (isQuotaExhausted(err) !== null) return true;
  return isCredentialFailure(err) === 'harness-credential';
}
```

6-2. `main.ts` 기동부. `codexHome` 준비 바로 아래에 계정 풀을 읽는다.

```ts
// claude 계정 풀(2026-09-07). **비어 있는 것이 정상이다** — 그때는 `CLAUDE_CONFIG_DIR` 를
// 주입하지 않아 자식이 시스템 기본(`~/.claude`)을 쓴다(기존 동작).
//
// `MURMUR_CLAUDE_ACCOUNTS` 에 없는 계정이 오면 이 호출이 던지고 러너는 뜨지 않는다 —
// 조용히 무시하면 운영자가 계정 B 라고 믿고 띄운 러너가 A 로 돈다.
const claudeAccounts = await loadClaudeAccounts({ order: process.env.MURMUR_CLAUDE_ACCOUNTS });
if (claudeAccounts.length) {
  // **이름만 적는다** — 이메일·토큰·Keychain 서비스명은 적지 않는다.
  console.log(`claude 계정 ${claudeAccounts.length}개: ${claudeAccounts.map((a) => a.name).join(', ')}`);
} else {
  console.log('claude 계정 풀이 비어 있다 — 시스템 기본 로그인을 쓴다');
}
```

6-3. 멘션 루프. `const tried = ...` 아래의 `try { ... } catch` 를 계정 축으로 감싼다. 기존 `try` 안의 내용과 `catch` 안의 내용은 그대로 두고, 다음을 더한다.

```ts
      // 계정 축(2026-09-07). 재시도 회계(`attempts`)와 **별개**로 돈다: 계정을 바꾼 것은
      // "같은 조건으로 또 해 봤다"가 아니라 조건이 달라진 것이다. 두 축을 곱하면
      // 계정 3개 × MAX_ATTEMPTS 3회 = 9번을 태우고, 그중 8번은 이미 답을 아는 실패다.
      //
      // 풀이 비면 이 배열은 `[null]` — 루프가 정확히 한 번 돌아 기존 동작과 같아진다.
      const accountLane: (ClaudeAccount | null)[] = claudeAccounts.length ? claudeAccounts : [null];
      let lastAccountErr: unknown = null;
      let switchedFrom: string | null = null;

      for (const [laneIdx, account] of accountLane.entries()) {
        if (laneIdx > 0) {
          console.error(
            `  ${entry.messageId} 계정 전환: ${switchedFrom ?? '(기본)'} → ${account?.name ?? '(기본)'}`,
          );
        }
        try {
          // ...(기존 try 본문 그대로. deps 리터럴의 두 필드를 이 계정으로 채운다:)
          //   claudeAccount: account?.name ?? null,
          //   claudeConfigDir: account?.configDir ?? null,
          lastAccountErr = null;
          break; // 성공했으면 계정 축을 더 돌지 않는다
        } catch (err) {
          // 계정을 바꿔서 나을 실패가 아니면 여기서 계정 축을 끝낸다 — 기존 catch 로 간다.
          if (!switchesAccount(err) || laneIdx === accountLane.length - 1) {
            lastAccountErr = err;
            break;
          }
          switchedFrom = account?.name ?? null;
          lastAccountErr = err;
          // 다음 계정으로 넘어간다. 세션은 `mentionTurn` 이 계정 변경을 보고 스스로 버린다
          // (Task 5) — 여기서 store 를 직접 만지지 않는다. 그 판단이 한 자리에 있어야
          // 인터랙티브 턴도 같은 규칙을 따른다.
        }
      }

      if (lastAccountErr !== null) {
        // ...(기존 catch 본문 그대로. `err` 를 `lastAccountErr` 로 읽는다)
      }
```

**구현 주의**: 기존 `try`/`catch` 는 `for` 루프 안의 `continue`·`break` 를 이미 쓰고 있다(유예 분기, 종료 요청 분기). 계정 루프를 안쪽에 넣으면 그 `continue`·`break` 가 **계정 루프**를 향하게 되어 멘션 루프를 못 벗어난다. 그래서 성공 경로의 `done.push`·`break`(종료 요청)와 한도 경로의 `continue` 를 계정 루프 **밖**으로 끌어내야 한다. 가장 안전한 리팩터는 계정 축을 **별 함수로 빼는 것**이다:

```ts
/**
 * 계정 축을 돌며 멘션 턴을 시도한다. 계정을 바꿔서 나을 실패(`switchesAccount`)면 다음
 * 계정으로 **같은 멘션**을 다시 시도하고, 아니면 즉시 그 오류를 던진다.
 *
 * **별 함수로 빼낸 이유**: 멘션 루프의 `continue`·`break` 가 계정 루프를 향하게 되면
 * 유예·종료요청·한도 분기가 조용히 멘션 루프를 못 벗어난다. 제어 흐름이 겹치는 자리를
 * 함수 경계로 끊는다.
 *
 * 풀이 비면 `accounts` 는 `[null]` 이고 루프는 한 번 돈다 — 기존 동작과 같다.
 */
async function runWithAccountFailover(
  accounts: (ClaudeAccount | null)[],
  attempt: (account: ClaudeAccount | null) => Promise<MentionTurnResult>,
  log: (from: string | null, to: string | null) => void,
): Promise<MentionTurnResult> {
  let last: unknown = new Error('계정 축이 한 번도 돌지 않았다 — 호출자가 빈 배열을 넘겼다');
  for (const [idx, account] of accounts.entries()) {
    if (idx > 0) log(accounts[idx - 1]?.name ?? null, account?.name ?? null);
    try {
      return await attempt(account);
    } catch (err) {
      last = err;
      if (!switchesAccount(err)) throw err;
    }
  }
  throw last;
}
```

멘션 루프의 `try` 안은 이렇게 된다.

```ts
        const turn = await runWithAccountFailover(
          accountLane,
          (account) => runMentionTurn(
            { ...depsBase, claudeAccount: account?.name ?? null, claudeConfigDir: account?.configDir ?? null },
            turnArgs,
          ),
          (from, to) => console.error(
            `  ${entry.messageId} 계정 전환: ${from ?? '(기본)'} → ${to ?? '(기본)'}`,
          ),
        );
```

`deps` 리터럴을 `depsBase` 로 이름만 바꿔 두고(두 필드를 뺀 나머지), `runMentionTurn` 인자 객체를 `turnArgs` 로 빼낸다. `MentionTurnResult` 는 `runMentionTurn` 의 실제 반환 타입 이름을 쓴다 — `mentionTurn.ts` 에서 확인하라.

6-4. `interactiveTurn` 을 만드는 자리에 계정을 넘긴다. 인터랙티브 턴은 페일오버하지 않는다 — 사람이 앉아 있고, 계정을 바꾸면 그 사람이 보던 세션이 사라진다. 첫 계정(`claudeAccounts[0] ?? null`)을 쓴다. 그 판단을 주석으로 적는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeAccountFailover`
Expected: PASS — 6개.

Run: `pnpm --filter @murmur/agent test`
Expected: PASS — 전체 스위트.

Run: `pnpm --filter @murmur/agent typecheck`
Expected: 성공.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/claudeAccounts.ts packages/agent/src/main.ts packages/agent/test/claudeAccountFailover.test.ts
git commit -m "feat(agent): 한도·자격증명 실패에서 다음 claude 계정으로 같은 멘션을 다시 시도한다

계정 축은 재시도 회계와 별개로 돌고 계정 수만큼만 돈다. 풀이 비면
한 번 돌아 기존 동작과 같다. 계정 축을 별 함수로 뺀 이유는 멘션 루프의
continue/break 와 제어 흐름이 겹치기 때문이다."
```

---

### Task 7: 계정 등록 절차를 README 에 적는다

러너가 대신 할 수 없는 유일한 단계다. 적어 두지 않으면 이 기능은 아무도 못 쓴다.

**Files:**
- Modify: `packages/agent/README.md`

**Interfaces:**
- Consumes: Task 2 의 뿌리 경로와 env 이름
- Produces: 없음(문서)

- [ ] **Step 1: 절을 더한다**

`packages/agent/README.md` 의 `## 자격증명` 절(현재 261행) 바로 뒤에 더한다. 기존 문서의 말투(단정, 근거 포함)를 따른다.

```markdown
## claude 다중 계정

러너는 계정별 `CLAUDE_CONFIG_DIR` 로 claude 를 띄운다. 한도나 로그인 만료를 만나면 **같은
멘션을** 다음 계정으로 다시 시도한다.

계정은 `~/.murmur-agent/claude-accounts/<name>/` 에 산다. 이름 문법은 `[a-z0-9-]{1,32}` 다.
**이 디렉터리를 안 만들면 지금까지처럼 시스템 기본 로그인(`~/.claude`)을 쓴다.**

등록은 계정마다 한 번, 사람이 해야 한다 — OAuth 는 브라우저를 요구한다.

```sh
mkdir -p ~/.murmur-agent/claude-accounts/aria
CLAUDE_CONFIG_DIR=~/.murmur-agent/claude-accounts/aria claude
# 뜬 화면에서 /login → 브라우저에서 그 계정으로 로그인 → 닫는다
```

**두 번째 계정부터는 브라우저 시크릿 창을 써라.** 그러지 않으면 기존 세션 쿠키를 재사용해
같은 계정으로 다시 로그인된다.

확인:

```sh
CLAUDE_CONFIG_DIR=~/.murmur-agent/claude-accounts/aria claude -p 'reply with OK'
```

- `MURMUR_CLAUDE_ACCOUNTS_DIR` — 뿌리를 옮긴다.
- `MURMUR_CLAUDE_ACCOUNTS` — 쉼표로 순서와 부분집합을 정한다(예: `cedar,aria`). 없는 이름을
  적으면 러너가 뜨지 않는다.

지정이 없으면 이름 사전순이다.

**계정을 바꾸면 그 스레드의 claude 세션은 버려진다.** 세션 파일이 계정 디렉터리 안에 있어
계정을 넘어가지 않기 때문이다. 스레드의 사실은 다음 턴 프롬프트가 전체를 다시 먹여 복원한다 —
잃는 것은 하네스 내부 컨텍스트다.

**API 키·OAuth 토큰 env 는 자식에게 넘어가지 않는다**(`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`). 하나라도
상속되면 계정 격리가 조용히 무력해진다.
```

- [ ] **Step 2: 커밋**

```bash
git add packages/agent/README.md
git commit -m "docs(agent): claude 다중 계정 등록 절차"
```

---

### Task 8: 실물 검증

테스트가 대신할 수 없다. 자격증명·Keychain·PTY 가 다 걸린다.

**Files:** 없음(관측만)

- [ ] **Step 1: 계정 둘을 등록한다**

Task 7 의 절차로 `aria` 과 하나 더. 둘째는 시크릿 창.

- [ ] **Step 2: 러너와 같은 방식으로 각 계정이 도는지 확인한다**

```sh
for a in ~/.murmur-agent/claude-accounts/*/; do
  echo "== $a"
  CLAUDE_CONFIG_DIR="$a" claude -p 'reply with exactly: OK'
done
```

Expected: 각 계정이 `OK`.

- [ ] **Step 3: 러너를 새로 띄운다**

러너 종료 → 앱 재시작 순서다. `controller.ts::startRunners` 는 앱 세션당 한 번만 돌아, 러너만
죽이면 다시 안 뜬다.

로그에서 계정 목록 줄을 확인한다.

```sh
grep -h "claude 계정" ~/Library/Application\ Support/app.murmur.desktop/daemon/runner-*.log | tail -5
```

Expected: `claude 계정 2개: aria, <다른 이름>`

- [ ] **Step 4: 페일오버를 관측한다**

첫 계정을 일부러 못 쓰게 만든다 — 그 디렉터리의 자격증명을 치운다(되돌릴 수 있게 옮긴다).

```sh
mv ~/.murmur-agent/claude-accounts/aria/.credentials.json /tmp/lime-creds.bak 2>/dev/null
security delete-generic-password \
  -s "Claude Code-credentials-$(printf %s "$HOME/.murmur-agent/claude-accounts/aria" | shasum -a 256 | cut -c1-8)" 2>/dev/null
CLAUDE_CONFIG_DIR=~/.murmur-agent/claude-accounts/aria claude -p 'x'   # → Not logged in 확인
```

멘션을 하나 보낸다. Expected: 스레드에 **정상 답변**이 온다. 러너 로그에 계정 전환 줄이 남는다.

```sh
grep -h "계정 전환" ~/Library/Application\ Support/app.murmur.desktop/daemon/runner-*.log | tail -5
```

- [ ] **Step 5: 되돌린다**

```sh
mv /tmp/lime-creds.bak ~/.murmur-agent/claude-accounts/aria/.credentials.json 2>/dev/null
# 또는 그 디렉터리에서 다시 로그인한다
```

- [ ] **Step 6: 결과를 기록한다**

관측한 것을 `docs/specs/2026-09-07-claude-multi-account-design.md` 아래 "실물 검증" 절로 덧붙여
커밋한다. 무엇이 통했고 무엇이 안 통했는지 그대로 적는다.

---

## 자체 검토

**스펙 커버리지**

| 스펙 절 | 태스크 |
|---|---|
| §4-1 계정 풀 | Task 2 |
| §4-2 env 주입 + denylist | Task 3 |
| §4-3 세션 경로 | Task 4 |
| §4-4 페일오버 방아쇠·계정 축·세션 초기화 | Task 1(판정), Task 5(세션), Task 6(축) |
| §4-5 관측(계정 이름만) | Task 6 의 로그 두 줄 |
| §5 사람이 하는 계정 등록 | Task 7, Task 8 |
| §6 테스트 표 | Task 1~6 의 Step 1 |
| §7 범위 밖 | 태스크 없음(의도) |

**타입 일관성**

- `ClaudeAccount { name, configDir }` — Task 2 가 정의하고 Task 6 이 쓴다.
- `claudeConfigDir: string | null` — Task 3(`buildTurnCommand`), Task 4(`claudeSessionFileExists` 의 `configDir`), Task 5(`MentionTurnDeps`)에서 같은 이름·같은 타입.
- `claudeAccount: string | null` — Task 5 의 `SessionRecord`(옵셔널)와 `MentionTurnDeps`(필수). 비교는 `?? null` 로 정규화한다.
- `switchesAccount(err): boolean` — Task 6 이 정의하고 같은 태스크에서 쓴다.

**남은 위험**

- Task 6 의 제어 흐름 리팩터가 이 계획의 가장 큰 조각이다. 기존 `continue`·`break` 를 계정
  루프에 가두면 유예·종료요청·한도 분기가 조용히 깨진다. 함수 추출로 끊되, 추출 후 기존
  `main` 테스트가 전부 통과하는지 반드시 확인하라.
- `HARNESS_ENV_DENYLIST` 확장은 API 키로 러너를 돌리던 사람에게 파괴적이다. `config.ts` 가
  지원하지 않는다고 이미 적어 뒀지만, 커밋 메시지에 그 사실을 남긴다.
