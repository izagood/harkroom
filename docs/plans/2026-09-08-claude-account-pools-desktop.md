# 데스크탑의 claude 계정 풀 관리 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 계정을 풀(그룹)로 묶고, 기본 풀을 지정하고, 에이전트별로 풀을 정하고, 그 전부를 데스크탑 설정 화면에서 관리한다.

**Architecture:** 웹뷰에는 로컬을 다룰 표면이 의도적으로 없다. 그래서 일반 실행 원시연산을 열지 않고 **데몬에 이름 붙은 연산 여덟**을 더한다 — 데몬은 이미 로컬 프로세스를 소유하는 경계다. 디스크가 멤버십의 진실이고(풀=디렉터리, 계정=그 안 디렉터리), `pools.json` 은 디스크가 표현할 수 없는 셋(기본 풀·순서·에이전트 배정)만 담는다. 러너는 그 파일을 **읽기만** 한다.

**Tech Stack:** TypeScript(ESM, NodeNext), Rust(Tauri 2), vitest, jsdom, React. 유닉스 소켓 위의 자체 프로토콜(`@murmur/shared/daemonProtocol`).

**Spec:** `docs/specs/2026-09-08-claude-account-pools-desktop-design.md`
**선행 Spec:** `docs/specs/2026-09-07-claude-multi-account-design.md`

## Global Constraints

- 주석·로그·커밋 메시지는 **한국어**. 코드 식별자는 영어. **UI 문자열은 영어** — 저장소 관례이고 한 번 어겨 되돌린 적이 있다.
- 테스트: 루트에서 `pnpm test`(전체) 또는 `pnpm --filter @murmur/<pkg> test <파일명>`. 타입은 `pnpm --filter @murmur/<pkg> typecheck`. **`build` 스크립트는 없다.**
- 이름 문법은 풀·계정 모두 `^[a-z0-9-]{1,32}$`. **데몬이 다시 검증한다** — 이 이름이 경로 세그먼트가 되고 데몬은 웹뷰를 신뢰하는 자리가 아니다.
- **비밀을 로그·argv 에 올리지 않는다.** 계정은 이름만 적는다. `claude auth status --json` 출력에는 비밀값이 없으므로(실측) 그대로 실어도 된다.
- **capability 를 늘리지 않는다.** `capabilities/default.json` 은 그대로다. `shell:allow-execute` 는 계속 0개여야 한다.
- **서버·DB·`AgentConfig` 를 건드리지 않는다.** 에이전트→풀 배정은 기기 로컬이다(spec §4-2).
- **러너는 `pools.json` 을 쓰지 않는다.** 읽기만 한다(spec §4-1 불변식).
- 각 태스크는 RED → GREEN → 커밋으로 끝난다.

## File Structure

**`packages/shared`**
- `src/claudePools.ts` (신규) — `pools.json` 의 **타입과 순수 해석 함수**. Node 의존 없음(웹뷰도 타입을 쓴다). 파일 I/O 는 여기 두지 않는다. `package.json` 의 `exports` 에 서브패스 `./claudePools` 를 더한다.
- `src/daemonProtocol.ts` (수정) — `REQUEST_TYPES` 에 여덟, `EVENT_NAMES` 에 하나, params/result 타입과 `read<X>Params` 검증자.

**`packages/agent`**
- `src/claudeAccounts.ts` (수정) — 풀 축을 얹는다. `loadClaudeAccounts` 는 그대로 두고 그 위에 `resolveClaudePool` 을 더한다.
- `src/main.ts` (수정) — 해석 결과를 `accountLane` 으로.

**`packages/daemon`**
- `src/claudeAccounts.ts` (신규) — 파일시스템·프로세스를 실제로 다루는 곳. 목록·설정 쓰기·로그인 프로세스 수명·이전.
- `src/server.ts` (수정) — `dispatch` 에 여덟 분기, `DaemonServerDeps` 에 포트 하나(`adoptOrphans` 판례).

**`packages/desktop/src-tauri`**
- `src/claude_accounts.rs` (신규) — `#[tauri::command]` 여덟. 소켓으로 넘기기만 한다.
- `src/main.rs` (수정) — `invoke_handler` 등록, 이벤트 상수.
- `src/daemon_client.rs` (수정) — 새 메서드 호출부와 `claudeLoginOutput` 이벤트 분기.

**`packages/desktop/src`**
- `components/settings/ClaudeAccountsSettings.tsx` (신규) — 섹션 화면.
- `components/settings/sections.ts` (수정) — 목차 한 줄.
- `screens/SettingsScreen.tsx` (수정) — import·렌더 분기 한 줄.
- `lib/claudeAccounts.ts` (신규) — invoke 래퍼와 이벤트 listen.
- `state/controller.ts`·`state/appStore.ts` (수정) — 상태를 밀어 넣는다(러너 상태 판례).
- `components/settings/AgentsSettings.tsx` (수정) — 실행 묶음에 풀 선택.

## 단계

**1단계(태스크 1~3)만으로도 쓸 수 있다** — 풀을 손으로 만들고 env 로 지정하면 동작한다. 2단계(4~6)가 데몬·Rust 표면을, 3단계(7~9)가 UI 를 얹는다. 각 단계 끝에서 전체 테스트가 초록이어야 한다.

---

### Task 1: `pools.json` 의 타입과 순수 해석

**Files:**
- Create: `packages/shared/src/claudePools.ts`
- Create: `packages/shared/test/claudePools.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export const CLAUDE_POOL_NAME_PATTERN: RegExp`
  - `export interface ClaudePoolsConfig { defaultPool: string | null; order: Record<string, string[]>; agents: Record<string, string> }`
  - `export function parseClaudePoolsConfig(raw: unknown): ClaudePoolsConfig` — 관용적. 모양이 틀린 항목만 버린다.
  - `export function resolvePoolName(cfg: ClaudePoolsConfig, agentId: string, forced?: string | null): string | null`
  - `export function orderAccounts(cfg: ClaudePoolsConfig, pool: string, found: string[]): string[]`

  Task 2 가 `resolvePoolName`·`orderAccounts` 를, Task 4 가 `parseClaudePoolsConfig` 를, Task 8 이 `ClaudePoolsConfig` 타입을 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/test/claudePools.test.ts` 를 새로 만든다.

```ts
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_POOL_NAME_PATTERN,
  orderAccounts,
  parseClaudePoolsConfig,
  resolvePoolName,
} from '../src/claudePools.js';

const EMPTY = { defaultPool: null, order: {}, agents: {} };

describe('parseClaudePoolsConfig', () => {
  it('빈 값·쓰레기 값에서 빈 설정을 낸다 — 던지지 않는다', () => {
    // 이 파일은 UI 가 쓰고 사람이 손댈 수 있다. 던지면 러너가 뜨지 않고, 그때
    // 사용자는 앱에서 고칠 방법이 없다(spec §5-1).
    for (const raw of [undefined, null, 42, 'x', [], {}]) {
      expect(parseClaudePoolsConfig(raw)).toEqual(EMPTY);
    }
  });

  it('세 필드를 읽는다', () => {
    expect(parseClaudePoolsConfig({
      defaultPool: 'work',
      order: { work: ['aria', 'cedar'] },
      agents: { 'a1': 'personal' },
    })).toEqual({ defaultPool: 'work', order: { work: ['aria', 'cedar'] }, agents: { a1: 'personal' } });
  });

  it('모양이 틀린 항목만 버리고 나머지는 살린다', () => {
    const cfg = parseClaudePoolsConfig({
      defaultPool: 42,                       // 문자열이 아니다
      order: { work: ['aria', 7], bad: 'x' }, // 원소·값이 배열이 아니다
      agents: { a1: 'personal', a2: 9 },      // 값이 문자열이 아니다
    });
    expect(cfg.defaultPool).toBe(null);
    expect(cfg.order).toEqual({ work: ['aria'] });
    expect(cfg.agents).toEqual({ a1: 'personal' });
  });

  it('이름 문법에 안 맞는 풀·계정 이름을 버린다', () => {
    // 이 이름은 경로 세그먼트가 된다 — 문법에서 끊는다.
    const cfg = parseClaudePoolsConfig({
      defaultPool: '../escape',
      order: { 'Work Pool': ['aria'], work: ['Lime', 'cedar'] },
      agents: { a1: '../escape' },
    });
    expect(cfg.defaultPool).toBe(null);
    expect(cfg.order).toEqual({ work: ['cedar'] });
    expect(cfg.agents).toEqual({});
  });
});

describe('resolvePoolName', () => {
  const cfg = parseClaudePoolsConfig({
    defaultPool: 'work',
    order: {},
    agents: { a1: 'personal' },
  });

  it('강제 지정이 가장 세다', () => {
    expect(resolvePoolName(cfg, 'a1', 'forced')).toBe('forced');
  });

  it('에이전트 배정이 기본 풀보다 세다', () => {
    expect(resolvePoolName(cfg, 'a1')).toBe('personal');
  });

  it('배정이 없으면 기본 풀이다', () => {
    expect(resolvePoolName(cfg, 'a2')).toBe('work');
  });

  it('아무것도 없으면 null — 호출자가 암묵 풀로 떨어진다', () => {
    expect(resolvePoolName(EMPTY, 'a1')).toBe(null);
  });
});

describe('orderAccounts', () => {
  it('설정 순서를 따르고 나머지를 사전순으로 뒤에 붙인다', () => {
    // 뒤에 붙이는 이유: UI 가 순서를 쓴 뒤 사람이 계정을 새로 만들 수 있다.
    // 그때 그 계정이 사라지면 "만들었는데 안 쓴다"가 된다.
    const cfg = parseClaudePoolsConfig({ order: { work: ['cedar', 'aria'] } });
    expect(orderAccounts(cfg, 'work', ['aria', 'cedar', 'zebra'])).toEqual(['cedar', 'aria', 'zebra']);
  });

  it('설정에 있지만 디스크에 없는 이름은 조용히 빠진다', () => {
    // 디스크가 멤버십의 진실이다. 사람이 파인더에서 지웠을 수 있다.
    const cfg = parseClaudePoolsConfig({ order: { work: ['gone', 'aria'] } });
    expect(orderAccounts(cfg, 'work', ['aria'])).toEqual(['aria']);
  });

  it('순서 지정이 없으면 사전순이다', () => {
    expect(orderAccounts(EMPTY, 'work', ['cedar', 'aria'])).toEqual(['aria', 'cedar']);
  });
});

describe('CLAUDE_POOL_NAME_PATTERN', () => {
  it('경로 탈출과 대문자·공백을 거절한다', () => {
    for (const bad of ['..', '../x', 'a/b', 'Work', 'a b', '', 'x'.repeat(33)]) {
      expect(CLAUDE_POOL_NAME_PATTERN.test(bad)).toBe(false);
    }
    for (const ok of ['work', 'personal-2', 'a', 'x'.repeat(32)]) {
      expect(CLAUDE_POOL_NAME_PATTERN.test(ok)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/shared test claudePools`
Expected: FAIL — `Cannot find module '../src/claudePools.js'`

- [ ] **Step 3: 최소 구현**

`packages/shared/src/claudePools.ts` 를 새로 만든다.

```ts
// claude 계정 **풀**의 타입과 순수 해석. `pools.json` 이 이 모듈의 대상이다.
//
// **서브패스로 낸다**(`@murmur/shared/claudePools`). 이 패키지의 별 모듈은 전부 그 모양이고
// (`./daemonEndpoint`, `./daemonProtocol`), `index.ts` 는 재수출이 하나도 없는 평평한 파일이다.
// 그 둘이 서브패스인 이유로 적힌 것은 Node 의존이지만 — 이 파일에는 Node 의존이 **없다** —
// 파일 조직의 관례는 그것과 별개다. 웹뷰가 직접 import 해도 안전하다.
//
// **파일 I/O 가 여기 없는 것이 요점이다.** 읽는 쪽(러너)과 쓰는 쪽(데몬)이 다른 프로세스이고
// 각자 자기 방식으로 읽고 쓴다 — 공유해야 하는 것은 **그 내용의 뜻**뿐이다. I/O 를 여기 넣으면
// 이 파일이 `node:fs` 를 물어 웹뷰 번들이 깨진다.
//
// **관용적으로 파싱하는 것이 규율이다.** 이 파일은 UI 가 쓰고 사람이 파인더·에디터로 손댈 수
// 있다. 모양이 틀렸다고 던지면 러너가 뜨지 않고, 그때 사용자는 앱에서 고칠 방법이 없다
// (spec §5-1). 그래서 **틀린 항목만 버리고 나머지는 살린다.**

/**
 * 풀·계정 이름 문법. `agent/src/claudeAccounts.ts::CLAUDE_ACCOUNT_PATTERN` 과 **같은 값**이고
 * 같은 이유다 — 이 이름이 경로 세그먼트가 되므로 `..` 나 `/` 가 들어올 여지를 문법에서 끊는다.
 *
 * 두 곳에 같은 값이 있는 것이 마음에 걸리지만, 러너의 것은 `@murmur/shared` 를 물지 않는
 * 자리에서도 쓰인다. 하나로 합치려면 그 의존을 먼저 재야 한다.
 */
export const CLAUDE_POOL_NAME_PATTERN = /^[a-z0-9-]{1,32}$/;

export interface ClaudePoolsConfig {
  /** 어느 풀이 기본인가. `null` 은 지정 없음. */
  defaultPool: string | null;
  /** 풀별 계정 순서(페일오버 순서). 디스크에서 유도할 수 없으므로 파일이 유일한 표현이다. */
  order: Record<string, string[]>;
  /** 에이전트 계정 id → 풀 이름. 배정이 없는 에이전트는 여기 없다. */
  agents: Record<string, string>;
}

const EMPTY: ClaudePoolsConfig = { defaultPool: null, order: {}, agents: {} };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function name(v: unknown): string | null {
  return typeof v === 'string' && CLAUDE_POOL_NAME_PATTERN.test(v) ? v : null;
}

/** `pools.json` 을 읽는다. **던지지 않는다** — 위 모듈 주석의 규율. */
export function parseClaudePoolsConfig(raw: unknown): ClaudePoolsConfig {
  if (!isRecord(raw)) return { ...EMPTY, order: {}, agents: {} };

  const order: Record<string, string[]> = {};
  if (isRecord(raw.order)) {
    for (const [pool, list] of Object.entries(raw.order)) {
      if (name(pool) === null || !Array.isArray(list)) continue;
      const accounts = list.map(name).filter((n): n is string => n !== null);
      order[pool] = accounts;
    }
  }

  const agents: Record<string, string> = {};
  if (isRecord(raw.agents)) {
    for (const [agentId, pool] of Object.entries(raw.agents)) {
      // agentId 는 서버가 발급한 UUID 라 문법을 여기서 재지 않는다(재면 서버의 형식 변경이
      // 이 파일을 깨뜨린다). 풀 이름만 잰다 — 그것이 경로가 되는 쪽이다.
      const p = name(pool);
      if (p !== null) agents[agentId] = p;
    }
  }

  return { defaultPool: name(raw.defaultPool), order, agents };
}

/**
 * 이 에이전트가 쓸 풀 이름. `null` 은 "지정 없음"이고 호출자가 암묵 풀로 떨어진다.
 *
 * `forced` 는 `MURMUR_CLAUDE_POOL` 이다 — **운영자가 방금 타이핑한 의도라 가장 세다.**
 * 그 값이 없는 풀을 가리키는지는 여기서 모른다(디스크를 안 본다). 호출자가 잰다.
 */
export function resolvePoolName(
  cfg: ClaudePoolsConfig,
  agentId: string,
  forced?: string | null,
): string | null {
  if (forced) return forced;
  return cfg.agents[agentId] ?? cfg.defaultPool;
}

/**
 * 풀 안 계정을 페일오버 순서로 늘어놓는다.
 *
 * `found` 는 **디스크에서 읽은 목록**이다 — 그것이 멤버십의 진실이므로, 설정에 있지만 디스크에
 * 없는 이름은 빠지고(사람이 지웠다) 디스크에 있지만 설정에 없는 이름은 **뒤에 붙는다**
 * (UI 가 순서를 쓴 뒤 사람이 계정을 새로 만들었다 — 그때 빠뜨리면 "만들었는데 안 쓴다"가 된다).
 */
export function orderAccounts(
  cfg: ClaudePoolsConfig,
  pool: string,
  found: string[],
): string[] {
  const wanted = cfg.order[pool] ?? [];
  const inOrder = wanted.filter((n) => found.includes(n));
  const rest = found.filter((n) => !inOrder.includes(n)).sort();
  return [...inOrder, ...rest];
}
```

**`index.ts` 에서 재수출하지 않는다 — 이 패키지의 관례는 서브패스 export 다.**
`packages/shared/package.json` 의 `exports` 에 한 줄 더한다:

```json
    "./claudePools": "./src/claudePools.ts"
```

`index.ts` 는 재수출이 하나도 없는 평평한 파일이고(확인함), 별 모듈은 `./daemonEndpoint`·
`./daemonProtocol` 처럼 서브패스로 낸다. 그 둘이 서브패스인 **이유**로 적힌 것은 Node 의존
(`node:crypto`)이지만, 파일 조직의 관례는 그것과 별개로 이미 서브패스다 — `index.ts` 에
`export * from` 을 처음 들이는 것보다 있는 모양을 따르는 편이 낫다.

가져오는 쪽은 `import { ... } from '@murmur/shared/claudePools'` 다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/shared test claudePools`
Expected: PASS — 12개.

Run: `pnpm --filter @murmur/shared typecheck`
Expected: 성공.

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/claudePools.ts packages/shared/package.json packages/shared/test/claudePools.test.ts
git commit -m "feat(shared): claude 계정 풀 설정의 타입과 순수 해석

pools.json 은 디스크가 표현할 수 없는 셋(기본 풀·순서·배정)만 담는다.
관용적으로 파싱한다 — UI 가 쓰고 사람이 손댈 수 있는 파일이라, 던지면
러너가 뜨지 않고 그때 사용자는 앱에서 고칠 방법이 없다.

파일 I/O 는 여기 없다: 읽는 쪽(러너)과 쓰는 쪽(데몬)이 다른 프로세스이고
공유해야 하는 것은 내용의 뜻뿐이다. node:fs 를 물면 웹뷰 번들이 깨진다."
```

---

### Task 2: 러너가 풀을 해석한다

**Files:**
- Modify: `packages/agent/src/claudeAccounts.ts`
- Modify: `packages/agent/src/main.ts`
- Test: `packages/agent/test/claudeAccounts.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `parseClaudePoolsConfig`·`resolvePoolName`·`orderAccounts`
- Produces: `export async function loadClaudeAccountLane(opts: { root?: string; agentId: string; forcedPool?: string | undefined; order?: string | undefined }): Promise<{ pool: string | null; accounts: ClaudeAccount[] }>` — Task 3 이 `main.ts` 에서 부른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/claudeAccounts.test.ts` 에 describe 를 더한다. 파일 위 `fixture` 헬퍼를 재사용하고, 풀 구조를 만드는 헬퍼를 하나 더 만든다.

```ts
async function poolFixture(
  pools: Record<string, string[]>,
  cfg?: unknown,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'murmur-pools-'));
  for (const [pool, accounts] of Object.entries(pools)) {
    for (const a of accounts) await mkdir(join(root, pool, a), { recursive: true });
    if (!accounts.length) await mkdir(join(root, pool), { recursive: true });
  }
  if (cfg !== undefined) await writeFile(join(root, 'pools.json'), JSON.stringify(cfg));
  return root;
}

describe('loadClaudeAccountLane — 풀 축', () => {
  it('pools.json 이 없으면 뿌리가 암묵 풀이다 — 어제 동작 그대로', async () => {
    // 하위 호환이 이 한 줄에 걸려 있다(spec §4-3). 술어는 파일의 존재 하나다.
    const root = await fixture(['aria', 'cedar']);
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe(null);
    expect(lane.accounts.map((a) => a.name)).toEqual(['aria', 'cedar']);
    expect(lane.accounts[0]!.configDir).toBe(join(root, 'aria'));
  });

  it('pools.json 이 있으면 하위 디렉터리가 풀이다', async () => {
    const root = await poolFixture({ work: ['aria'], personal: ['gmail'] }, { defaultPool: 'work' });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe('work');
    expect(lane.accounts.map((a) => a.name)).toEqual(['aria']);
    expect(lane.accounts[0]!.configDir).toBe(join(root, 'work', 'aria'));
  });

  it('에이전트 배정이 기본 풀을 덮는다', async () => {
    const root = await poolFixture(
      { work: ['aria'], personal: ['gmail'] },
      { defaultPool: 'work', agents: { a1: 'personal' } },
    );
    expect((await loadClaudeAccountLane({ root, agentId: 'a1' })).pool).toBe('personal');
    expect((await loadClaudeAccountLane({ root, agentId: 'a2' })).pool).toBe('work');
  });

  it('MURMUR_CLAUDE_POOL 이 가장 세다', async () => {
    const root = await poolFixture(
      { work: ['aria'], personal: ['gmail'] },
      { defaultPool: 'work', agents: { a1: 'work' } },
    );
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1', forcedPool: 'personal' });
    expect(lane.pool).toBe('personal');
    expect(lane.accounts.map((a) => a.name)).toEqual(['gmail']);
  });

  it('MURMUR_CLAUDE_POOL 이 없는 풀을 가리키면 던진다 — 사람이 타이핑한 의도다', async () => {
    const root = await poolFixture({ work: ['aria'] }, { defaultPool: 'work' });
    await expect(loadClaudeAccountLane({ root, agentId: 'a1', forcedPool: 'ghost' }))
      .rejects.toThrow(/ghost/);
  });

  it('pools.json 이 없는 풀을 가리키면 경고하고 무시한다 — 던지지 않는다', async () => {
    // UI 가 쓴 뒤 사람이 디렉터리를 지울 수 있다. 던지면 러너가 안 뜨고 사용자는
    // 앱에서 고칠 수 없다(spec §5-1). 다음 단계로 떨어진다.
    const root = await poolFixture({ work: ['aria'] }, { defaultPool: 'work', agents: { a1: 'gone' } });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe('work'); // 배정을 무시하고 기본 풀로 떨어졌다
  });

  it('기본 풀도 없으면 계정 지정 없음이다', async () => {
    const root = await poolFixture({ work: ['aria'] }, { agents: { a1: 'gone' } });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe(null);
    expect(lane.accounts).toEqual([]);
  });

  it('풀 안 순서를 pools.json 이 정한다', async () => {
    const root = await poolFixture(
      { work: ['aria', 'cedar', 'zebra'] },
      { defaultPool: 'work', order: { work: ['cedar', 'aria'] } },
    );
    expect((await loadClaudeAccountLane({ root, agentId: 'a1' })).accounts.map((a) => a.name))
      .toEqual(['cedar', 'aria', 'zebra']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 풀 안 순서를 덮는다', async () => {
    const root = await poolFixture(
      { work: ['aria', 'cedar'] },
      { defaultPool: 'work', order: { work: ['aria', 'cedar'] } },
    );
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1', order: 'cedar' });
    expect(lane.accounts.map((a) => a.name)).toEqual(['cedar']);
  });

  it('빈 풀은 계정 0개다 — 오류가 아니다', async () => {
    const root = await poolFixture({ work: [] }, { defaultPool: 'work' });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe('work');
    expect(lane.accounts).toEqual([]);
  });

  it('깨진 pools.json 은 없는 것으로 본다', async () => {
    // 파싱 실패로 러너가 안 뜨면 사용자는 앱에서 고칠 수 없다.
    const root = mkdtempSync(join(tmpdir(), 'murmur-pools-broken-'));
    await mkdir(join(root, 'aria'), { recursive: true });
    await writeFile(join(root, 'pools.json'), '{ not json');
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    // 파일이 **있으므로** 풀 모드다. 하위 디렉터리 `aria` 은 풀로 읽히고 그 안에 계정이 없다.
    expect(lane.accounts).toEqual([]);
  });
});
```

import 에 `loadClaudeAccountLane` 를 더하고, `writeFile` 이 이미 import 돼 있는지 확인한다(있다).

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeAccounts`
Expected: FAIL — `loadClaudeAccountLane` 가 없다.

- [ ] **Step 3: 최소 구현**

`packages/agent/src/claudeAccounts.ts` 에 더한다. `loadClaudeAccounts` 는 **그대로 둔다** — 암묵 풀 경로가 그것을 그대로 쓴다.

```ts
import { readFile } from 'node:fs/promises';

import {
  orderAccounts,
  parseClaudePoolsConfig,
  type ClaudePoolsConfig,
} from '@murmur/shared/claudePools';

/** `pools.json` 의 경로. 뿌리 바로 아래다 — 풀 이름 문법이 `.` 를 안 받으므로 풀과 안 겹친다. */
function poolsConfigPath(root: string): string {
  return join(root, 'pools.json');
}

/**
 * `pools.json` 을 읽는다. **없으면 `null`, 깨졌으면 빈 설정**이다 — 이 둘을 가르는 것이
 * 요점이다(spec §4-3): **파일의 존재가 풀 모드의 스위치**이므로, 깨진 파일을 "없음"으로
 * 읽으면 풀 모드였던 러너가 조용히 암묵 풀 모드로 되돌아가 **계정을 풀로 읽는다.**
 */
async function readPoolsConfig(root: string): Promise<ClaudePoolsConfig | null> {
  let text: string;
  try {
    text = await readFile(poolsConfigPath(root), 'utf8');
  } catch {
    return null; // 파일이 없다 = 암묵 풀 모드(어제 구조)
  }
  try {
    return parseClaudePoolsConfig(JSON.parse(text));
  } catch {
    // 파싱 실패. **파일은 있으므로 풀 모드는 유지한다.** 던지지 않는 이유는 위 주석.
    console.warn(`[claudeAccounts] pools.json 을 읽을 수 없다 — 빈 설정으로 본다: ${poolsConfigPath(root)}`);
    return parseClaudePoolsConfig(undefined);
  }
}

/**
 * 이 러너가 쓸 계정 목록(페일오버 순서)과 그 풀 이름.
 *
 * 해석 순서는 spec §5 다: 강제(env) → 에이전트 배정 → 기본 풀 → 암묵 풀 → 없음.
 *
 * **관용성이 갈린다**(spec §5-1): `forcedPool` 이 없는 풀을 가리키면 **던진다**(사람이 방금
 * 타이핑한 의도다). `pools.json` 이 가리키면 **경고하고 다음 단계로 떨어진다**(UI 가 쓴 뒤
 * 사람이 디렉터리를 지울 수 있고, 그때 러너가 안 뜨면 앱에서 고칠 방법이 없다).
 */
export async function loadClaudeAccountLane(opts: {
  root?: string;
  agentId: string;
  forcedPool?: string | undefined;
  order?: string | undefined;
}): Promise<{ pool: string | null; accounts: ClaudeAccount[] }> {
  const root = opts.root ?? claudeAccountsRoot();
  const cfg = await readPoolsConfig(root);

  // 파일이 없다 = 암묵 풀. 뿌리의 하위 디렉터리가 계정이다(어제 구조 그대로).
  if (cfg === null) {
    return { pool: null, accounts: await loadClaudeAccounts({ root, order: opts.order }) };
  }

  const pools = await listPoolNames(root);

  if (opts.forcedPool) {
    if (!pools.includes(opts.forcedPool)) {
      throw new Error(
        `MURMUR_CLAUDE_POOL 이 없는 풀을 가리킨다: ${opts.forcedPool}. ` +
        `${root} 아래에 있는 풀은 ${pools.length ? pools.join(', ') : '(없음)'} 이다.`,
      );
    }
    return { pool: opts.forcedPool, accounts: await accountsIn(root, opts.forcedPool, cfg, opts.order) };
  }

  // 배정 → 기본 풀. 각 단계에서 **없는 풀이면 경고하고 다음으로 떨어진다.**
  for (const [label, candidate] of [
    ['에이전트 배정', cfg.agents[opts.agentId]],
    ['기본 풀', cfg.defaultPool],
  ] as const) {
    if (!candidate) continue;
    if (!pools.includes(candidate)) {
      console.warn(`[claudeAccounts] ${label}이 없는 풀을 가리킨다 — 무시한다: ${candidate}`);
      continue;
    }
    return { pool: candidate, accounts: await accountsIn(root, candidate, cfg, opts.order) };
  }
  return { pool: null, accounts: [] };
}

/** 뿌리 아래 풀 이름. 판정 규율은 `loadClaudeAccounts` 와 같다(`stat` 으로 링크를 따라간다). */
async function listPoolNames(root: string): Promise<string[]> {
  return (await loadClaudeAccounts({ root })).map((p) => p.name);
}

/** 한 풀 안의 계정을 순서대로. `order` env 가 있으면 그것이 마지막에 이긴다. */
async function accountsIn(
  root: string, pool: string, cfg: ClaudePoolsConfig, order: string | undefined,
): Promise<ClaudeAccount[]> {
  const dir = join(root, pool);
  // env 지정이 있으면 그것에 맡긴다 — 없는 이름이면 던진다(기존 동작 유지).
  if (order && order.trim()) return loadClaudeAccounts({ root: dir, order });
  const found = (await loadClaudeAccounts({ root: dir })).map((a) => a.name);
  return orderAccounts(cfg, pool, found).map((name) => ({ name, configDir: join(dir, name) }));
}
```

`resolvePoolName` 을 직접 안 쓰는 이유를 주석으로 적어라: **없는 풀을 건너뛰어야 하므로**
"이름 하나를 고르는" 순수 함수로는 부족하다. 그 함수는 Task 8 의 UI 가 "지금 어느 풀이
쓰일 것인가"를 미리 보여 줄 때 쓴다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/agent test claudeAccounts`
Expected: PASS — 기존 13개 + 새 11개.

Run: `pnpm --filter @murmur/agent typecheck`
Expected: 성공.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/claudeAccounts.ts packages/agent/test/claudeAccounts.test.ts
git commit -m "feat(agent): 러너가 계정 풀을 해석한다

해석 순서는 강제(env) → 에이전트 배정 → 기본 풀 → 암묵 풀 → 없음이다.
pools.json 의 **존재**가 풀 모드의 스위치다 — 디렉터리 모양을 추측하지 않는다
(갓 만든 빈 풀과 계정은 모양이 같아 그 추측은 원리적으로 갈리지 않는다).

관용성이 갈린다: env 가 없는 풀을 가리키면 던지고(사람이 방금 타이핑한 의도),
pools.json 이 가리키면 경고하고 다음 단계로 떨어진다(UI 가 쓴 파일 때문에
러너가 안 뜨면 사용자는 앱에서 고칠 방법이 없다).

깨진 pools.json 은 '없음'이 아니라 '빈 설정'이다 — 없음으로 읽으면 풀 모드
러너가 조용히 암묵 풀로 되돌아가 계정을 풀로 읽는다."
```

---

### Task 3: `main.ts` 가 풀 축을 쓴다

**Files:**
- Modify: `packages/agent/src/main.ts`
- Test: `packages/agent/test/claudeAccountFailover.test.ts` (로그 문구는 소스 대조로)

**Interfaces:**
- Consumes: Task 2 의 `loadClaudeAccountLane`
- Produces: 없음(배선)

- [ ] **Step 1: 배선을 바꾼다**

`main.ts` 의 기동부에서 `loadClaudeAccounts` 호출을 `loadClaudeAccountLane` 로 바꾼다.
`me.id` 는 그 위에서 이미 해석돼 있다.

```ts
// claude 계정 풀. **비어 있는 것이 정상이다** — 그때는 `CLAUDE_CONFIG_DIR` 를 주입하지 않아
// 자식이 시스템 기본(`~/.claude`)을 쓴다(기존 동작).
//
// 풀 축(spec §5): 어느 풀을 쓸지는 `MURMUR_CLAUDE_POOL` → `pools.json` 의 이 에이전트 배정 →
// 기본 풀 → 암묵 풀(뿌리 자체) 순으로 정해진다. **키는 `me.id`** 다 — handle 이 아닌 이유는
// `stateDir.ts` 판단과 같다(handle 은 바뀌고 서로 다른 서버의 같은 handle 은 다른 계정이다).
//
// **러너는 `pools.json` 을 쓰지 않는다**(spec §4-1 불변식). 읽기만 한다 — 그 파일의 writer 는
// 데몬 하나이고, 두 번째 writer 가 생기면 lost update 가 조용히 난다.
const lane = await loadClaudeAccountLane({
  agentId: me.id,
  forcedPool: process.env.MURMUR_CLAUDE_POOL,
  order: process.env.MURMUR_CLAUDE_ACCOUNTS,
});
const claudeAccounts = lane.accounts;
// **이름만 적는다** — 이메일·토큰·Keychain 서비스명은 적지 않는다(PAT 규율과 같다).
console.log(claudeAccounts.length
  ? `claude 계정 ${claudeAccounts.length}개 (풀: ${lane.pool ?? '기본(뿌리)'}): ${claudeAccounts.map((a) => a.name).join(', ')}`
  : `claude 계정 풀이 비어 있다 (풀: ${lane.pool ?? '지정 없음'}) — 시스템 기본 로그인을 쓴다`);
```

`accountLane` 유도 줄은 그대로 둔다.

- [ ] **Step 2: 회귀선을 더한다**

`packages/agent/test/claudeAccountFailover.test.ts` 에 소스 대조 테스트를 더한다.
`main.ts` 는 top-level await 라 import 할 수 없다 — `mainCredentialSites.test.ts` 와 같은 방식이다.

```ts
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// main.ts 는 top-level await 로 서버에 붙으므로 테스트가 import 할 수 없다. 판정 자체는
// claudeAccounts.test.ts 가 실물로 확인하고, 여기서는 **배선이 그 자리에 있는지**만 본다 —
// `mainCredentialSites.test.ts` 와 같은 종류의 약한 검사이고 같은 이유로 필요하다.
describe('main.ts 의 풀 배선', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

  it('풀 해석 함수를 쓴다 — 평평한 목록 함수를 직접 부르지 않는다', () => {
    expect(source).toContain('loadClaudeAccountLane(');
    // 기동부에서 평평한 목록을 직접 부르면 풀 축이 통째로 빠진다.
    expect(source).not.toContain('await loadClaudeAccounts(');
  });

  it('풀 결정 키가 me.id 다 — handle 이 아니다', () => {
    expect(source).toContain('agentId: me.id');
  });

  it('강제 지정과 순서를 env 에서 읽는다', () => {
    expect(source).toContain('MURMUR_CLAUDE_POOL');
    expect(source).toContain('MURMUR_CLAUDE_ACCOUNTS');
  });
});
```

- [ ] **Step 3: 확인한다**

Run: `pnpm --filter @murmur/agent test`
Expected: PASS — 전체.

Run: `pnpm --filter @murmur/agent typecheck`
Expected: 성공.

- [ ] **Step 4: 커밋**

```bash
git add packages/agent/src/main.ts packages/agent/test/claudeAccountFailover.test.ts
git commit -m "feat(agent): 기동부가 풀 축으로 계정을 해석한다

풀 결정 키는 me.id 다 — handle 은 바뀌고 서로 다른 서버의 같은 handle 은
다른 계정이다(stateDir.ts 판단과 같다). 로그에 풀 이름을 함께 적는다.

main.ts 는 import 할 수 없어 배선을 소스 대조로 고정한다
(mainCredentialSites.test.ts 와 같은 종류의 약한 검사, 같은 이유)."
```

**여기까지가 1단계다.** 풀을 손으로 만들고 `pools.json` 을 직접 쓰면 이미 동작한다.

---

### Task 4: 데몬의 계정 포트 — 파일시스템

**Files:**
- Create: `packages/daemon/src/claudeAccounts.ts`
- Create: `packages/daemon/test/claudeAccounts.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `parseClaudePoolsConfig`·`CLAUDE_POOL_NAME_PATTERN`
- Produces:
  - `export interface ClaudeAccountsPort { list(): Promise<ClaudeAccountsSnapshot>; configure(cfg): Promise<void>; removeAccount(pool, account): Promise<void>; removePool(pool): Promise<void>; move(account, toPool): Promise<{ loggedIn: boolean }>; }`
  - `export function createClaudeAccountsPort(opts: { root?: string; runStatus?: (configDir: string) => Promise<unknown> }): ClaudeAccountsPort`
  - `export interface ClaudeAccountsSnapshot { root: string; mode: 'flat' | 'pools'; defaultPool: string | null; agents: Record<string,string>; pools: { name: string; accounts: { name: string; status: ClaudeAuthStatus }[] }[]; strays: string[] }`

  Task 5 가 이 포트를 `DaemonServerDeps` 로 주입받는다. `runStatus` 를 주입 가능하게 하는 이유: 테스트가 실제 `claude` 를 부르지 않아야 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/daemon/test/claudeAccounts.test.ts` 를 새로 만든다. `runStatus` 를 목으로 주입한다.

```ts
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeAccountsPort } from '../src/claudeAccounts.js';

const LOGGED_IN = { loggedIn: true, email: 'a@b.c', orgName: 'Org', subscriptionType: 'team' };
const LOGGED_OUT = { loggedIn: false };

function port(root: string, status: unknown = LOGGED_IN) {
  // 실제 `claude` 를 부르지 않는다 — 테스트가 로그인 상태에 의존하면 CI 에서 갈린다.
  return createClaudeAccountsPort({ root, runStatus: vi.fn(async () => status) });
}

describe('list', () => {
  it('pools.json 이 없으면 flat 모드로 뿌리의 계정을 준다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'aria'), { recursive: true });
    const snap = await port(root).list();
    expect(snap.mode).toBe('flat');
    expect(snap.pools).toHaveLength(1);
    expect(snap.pools[0]!.accounts.map((a) => a.name)).toEqual(['aria']);
  });

  it('pools.json 이 있으면 pools 모드로 풀별 계정을 준다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    const snap = await port(root).list();
    expect(snap.mode).toBe('pools');
    expect(snap.defaultPool).toBe('work');
    expect(snap.pools.map((p) => p.name)).toEqual(['work']);
  });

  it('로그인 상태를 계정마다 실어 준다 — 비밀값은 없다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'aria'), { recursive: true });
    const snap = await port(root, LOGGED_IN).list();
    expect(snap.pools[0]!.accounts[0]!.status).toMatchObject({ loggedIn: true, email: 'a@b.c' });
  });

  it('미로그인 계정도 목록에 남는다 — 사람이 로그인해야 하는 대상이다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'aria'), { recursive: true });
    const snap = await port(root, LOGGED_OUT).list();
    expect(snap.pools[0]!.accounts[0]!.status.loggedIn).toBe(false);
  });

  it('풀 모드에서 뿌리에 남은 평평한 계정을 strays 로 보고한다', async () => {
    // 사용자가 풀을 만든 순간 평평한 계정은 목록에서 사라진다(spec §4-3).
    // 조용히 사라지면 "계정이 없어졌다"가 되므로 따로 보고한다.
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    await mkdir(join(root, 'leftover'), { recursive: true });
    await writeFile(join(root, 'leftover', '.credentials.json'), '{}');
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    const snap = await port(root).list();
    expect(snap.strays).toEqual(['leftover']);
    expect(snap.pools.map((p) => p.name)).toEqual(['work']);
  });

  it('뿌리가 없으면 빈 스냅샷이다 — 오류가 아니다', async () => {
    const snap = await port('/nonexistent/murmur/pool').list();
    expect(snap.pools).toEqual([]);
    expect(snap.mode).toBe('flat');
  });
});

describe('configure', () => {
  it('pools.json 을 쓰고 없는 풀 디렉터리를 만든다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await port(root).configure({ defaultPool: 'work', order: { work: [] }, agents: {} });
    expect(JSON.parse(await readFile(join(root, 'pools.json'), 'utf8')).defaultPool).toBe('work');
    // 풀 생성 경로가 이것이다 — 별도 createPool 을 두지 않는다.
    expect((await port(root).list()).pools.map((p) => p.name)).toEqual(['work']);
  });

  it('이름 문법을 다시 잰다 — 웹뷰를 신뢰하지 않는다', async () => {
    // 이 이름이 경로 세그먼트가 된다. 데몬은 웹뷰를 신뢰하는 자리가 아니다(spec §6-2).
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await expect(port(root).configure({ defaultPool: '../escape', order: {}, agents: {} }))
      .rejects.toThrow();
  });

  it('원자적으로 쓴다 — 임시 파일 뒤 rename', async () => {
    // 쓰다 죽으면 반쪽 JSON 이 남고, 그것을 읽은 러너는 빈 설정으로 떨어진다(Task 2).
    // 반쪽이 남지 않는 것이 이 단언의 대상이다.
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    const p = port(root);
    await Promise.all([
      p.configure({ defaultPool: 'a', order: {}, agents: {} }),
      p.configure({ defaultPool: 'b', order: {}, agents: {} }),
    ]);
    const cfg = JSON.parse(await readFile(join(root, 'pools.json'), 'utf8'));
    expect(['a', 'b']).toContain(cfg.defaultPool); // 어느 쪽이든 온전하다
  });
});

describe('removeAccount · removePool', () => {
  it('계정 디렉터리를 지운다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    await mkdir(join(root, 'work', 'cedar'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    await port(root).removeAccount('work', 'aria');
    const snap = await port(root).list();
    expect(snap.pools[0]!.accounts.map((a) => a.name)).toEqual(['cedar']);
  });

  it('풀 디렉터리를 지운다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    await port(root).removePool('work');
    expect((await port(root).list()).pools).toEqual([]);
  });

  it('뿌리 밖을 지우려는 이름을 거절한다', async () => {
    // 파괴적 연산이다. 이름 문법이 이미 막지만, 그 방어가 여기 있다는 사실을 고정한다.
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await expect(port(root).removePool('..')).rejects.toThrow();
    await expect(port(root).removeAccount('..', 'x')).rejects.toThrow();
  });
});

describe('move', () => {
  it('평평한 계정을 풀 안으로 옮기고 상태를 다시 잰다', async () => {
    // 실측(spec §4-3): 자격증명 파일이 디렉터리와 함께 움직이므로 로그인이 유지된다.
    // 그러나 무조건 성공한다고 말하지 않는다 — 옮긴 뒤 다시 재서 사실을 돌려준다.
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'leftover'), { recursive: true });
    await writeFile(join(root, 'leftover', '.credentials.json'), '{}');
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));

    const res = await port(root, LOGGED_IN).move('leftover', 'work');
    expect(res.loggedIn).toBe(true);
    const snap = await port(root).list();
    expect(snap.strays).toEqual([]);
    expect(snap.pools[0]!.accounts.map((a) => a.name)).toEqual(['leftover']);
  });

  it('옮긴 뒤 미로그인이면 그 사실을 돌려준다 — 되돌리지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'leftover'), { recursive: true });
    await mkdir(join(root, 'work'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    const res = await port(root, LOGGED_OUT).move('leftover', 'work');
    expect(res.loggedIn).toBe(false);
    // 옮긴 것은 그대로다 — 되돌리면 사용자가 이전을 또 해야 한다(spec §4-3).
    expect((await port(root).list()).pools[0]!.accounts.map((a) => a.name)).toEqual(['leftover']);
  });

  it('대상 이름이 이미 있으면 거절한다 — 덮어쓰지 않는다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'd-acc-'));
    await mkdir(join(root, 'aria'), { recursive: true });
    await mkdir(join(root, 'work', 'aria'), { recursive: true });
    await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
    await expect(port(root).move('aria', 'work')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @murmur/daemon test claudeAccounts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 최소 구현**

`packages/daemon/src/claudeAccounts.ts` 를 만든다. 구현 규율:

- **뿌리 기준으로 경로를 조립하고, 조립한 경로가 뿌리 아래인지 `resolve` 로 다시 확인한다.**
  이름 문법이 이미 막지만 파괴적 연산이므로 방어를 두 겹 둔다.
- `list()` 는 계정마다 `runStatus(configDir)` 를 부른다. 기본 구현은
  `execFile('claude', ['auth','status','--json'], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } })`
  이고 **종료 코드 1 을 정상으로 받는다**(미로그인이 1 이다 — 실측). stdout 을 JSON 으로 읽고
  실패하면 `{ loggedIn: false }` 로 본다.
- `configure()` 는 `parseClaudePoolsConfig` 로 **한 번 더 정규화한 뒤** 유일한 임시 이름으로 쓰고
  `rename` 한다(`sessions.json` 의 원자적 쓰기와 같은 규율 — 그 파일의 주석을 참고하라).
  정규화에서 이름이 떨어져 나가면 **던진다** — 웹뷰가 잘못된 이름을 보냈다는 뜻이고 조용히
  버리면 UI 가 쓴 것과 디스크가 갈린다.
- `strays` 는 **풀 모드일 때만** 채운다. 뿌리 하위 디렉터리 중 `.credentials.json` 또는
  `.claude.json` 을 가진 것을 고른다. 그것이 "계정이었던 것"의 유일한 관측 가능한 표식이다.
- `move()` 는 같은 볼륨 `rename` 을 쓴다. 대상이 있으면 던진다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm --filter @murmur/daemon test claudeAccounts`
Expected: PASS — 15개.

- [ ] **Step 5: 커밋**

```bash
git add packages/daemon/src/claudeAccounts.ts packages/daemon/test/claudeAccounts.test.ts
git commit -m "feat(daemon): 계정 풀의 파일시스템 연산

목록·설정 쓰기·삭제·이전. auth status 는 주입 가능하다 — 테스트가 실제
claude 를 부르면 CI 에서 로그인 상태에 따라 갈린다. 미로그인의 종료 코드 1 을
정상으로 받는다(실측).

경로는 뿌리 기준으로 조립하고 resolve 로 다시 확인한다. 이름 문법이 이미
막지만 파괴적 연산이라 방어를 두 겹 둔다. 설정 쓰기는 원자적이다 —
반쪽 JSON 이 남으면 러너가 빈 설정으로 떨어진다."
```

---

### Task 5: 로그인 프로세스 수명

**Files:**
- Modify: `packages/daemon/src/claudeAccounts.ts`
- Test: `packages/daemon/test/claudeLogin.test.ts` (신규)

**Interfaces:**
- Consumes: Task 4 의 포트
- Produces: 포트에 `loginStart(pool, account): Promise<{ loginId: string }>`, `loginSubmit(loginId, code): Promise<void>`, `loginCancel(loginId): Promise<void>`, `onLoginEvent(cb): void` 를 더한다. Task 6 이 `onLoginEvent` 를 소켓 이벤트로 흘린다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

프로세스를 주입한다(`spawn` 을 옵션으로). 실측 바이트로 URL 추출을 잰다.

```ts
// 실측 바이트(2026-09-07, claude 2.1.263). OSC 8 하이퍼링크로 감싸여 **URL 이 두 번** 나온다.
// 프론트가 이 파싱을 하면 하이퍼링크 규격을 프론트가 알아야 한다 — 한 곳에서 한다(spec §6-1).
const REAL_OUTPUT =
  'Opening browser to sign in…\r\n' +
  'If the browser didn\'t open, visit: ]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=X&state=Y' +
  'https://claude.com/cai/oauth/authorize?code=true&client_id=X&state=Y]8;;\r\n' +
  'Paste code here if prompted > ';

it('실측 출력에서 URL 을 한 번만 뽑는다', async () => { /* onLoginEvent 로 온 url 을 단언 */ });
it('코드를 stdin 에 한 줄로 쓴다', async () => { /* 가짜 프로세스의 stdin 기록을 단언 */ });
it('취소는 SIGTERM 뒤 유예 후 SIGKILL 이다', async () => { /* 러너 회수와 같은 규율 */ });
it('프로세스가 끝나면 done 이벤트가 온다', async () => { /* 성공·실패 모두 */ });
it('모르는 loginId 에 코드를 넣으면 거절한다', async () => { /* 조용히 무시하지 않는다 */ });
it('같은 계정에 로그인이 이미 돌고 있으면 거절한다', async () => { /* 둘이 같은 디렉터리를 밟는다 */ });
```

각 테스트의 본문은 구현자가 가짜 프로세스(`EventEmitter` + 기록용 `stdin`)로 채운다.
**단언 대상은 위 주석에 적힌 사실들**이고, 그것을 재지 않는 테스트는 이 태스크를 통과시키지 않는다.

- [ ] **Step 2~4: RED → 구현 → GREEN**

Run: `pnpm --filter @murmur/daemon test claudeLogin`

구현 규율:
- `claude auth login` 을 `CLAUDE_CONFIG_DIR=<pool>/<account>` 로 띄운다. 디렉터리를 먼저 만든다.
- **stdout 을 그대로 흘리지 않는다.** `https://\S+` 를 뽑아 **첫 번째 것만** 이벤트로 낸다.
- 회수는 SIGTERM → 유예 → SIGKILL. `pty.ts::SIGKILL_GRACE_MS` 와 같은 이유(정리 기회를 준다).
- 같은 계정에 로그인이 이미 있으면 거절한다 — 둘이 같은 디렉터리를 밟는다.
- 데몬이 죽을 때 진행 중인 로그인은 회수한다(러너와 달리 **살려 두지 않는다** — 사람이
  브라우저에서 완료해도 코드를 받을 프로세스가 없다).

- [ ] **Step 5: 커밋**

```bash
git commit -m "feat(daemon): claude 로그인 프로세스의 수명

auth login 을 계정 디렉터리로 띄우고, URL 을 뽑아 이벤트로 내고, 코드를
stdin 으로 넘긴다. PTY 가 필요 없다 — 파이프에서도 URL 을 찍고 stdin 을
읽는다(실측).

stdout 을 그대로 흘리지 않는다: OSC 8 하이퍼링크 때문에 URL 이 두 번 나오고,
프론트가 그 파싱을 하면 하이퍼링크 규격을 프론트가 알아야 한다.

데몬 종료 시 진행 중인 로그인은 회수한다 — 러너와 달리 살려 둘 이유가 없다.
사람이 브라우저에서 완료해도 코드를 받을 프로세스가 없다."
```

---

### Task 6: 프로토콜과 데몬 분기

**Files:**
- Modify: `packages/shared/src/daemonProtocol.ts`
- Modify: `packages/daemon/src/server.ts`
- Test: `packages/shared/test/daemonProtocol.test.ts`(기존), `packages/daemon/test/server*.test.ts`(기존 패턴)

**Interfaces:**
- Consumes: Task 4·5 의 포트
- Produces: `REQUEST_TYPES` 에 여덟, `EVENT_NAMES` 에 `'claudeLoginOutput'`, `DaemonServerDeps.claudeAccounts?: ClaudeAccountsPort`

- [ ] **Step 1: RED**

- `REQUEST_TYPES` 에 여덟이 있는지, `EVENT_NAMES` 에 새 이벤트가 있는지.
- `read<X>Params` 가 이름 문법을 거절하는지(풀·계정·loginId·code).
- 포트가 없으면 `dispatch` 가 **`unknown-request` 가 아니라** "이 daemon 에는 배선되지 않았다"로
  답하는지 — `adoptRunner` 의 판례를 그대로 따른다(프로토콜이 아는 요청인데 이 daemon 이 못
  하는 것이므로, `unknown-request` 로 답하면 앱이 프로토콜 버전을 의심한다).

- [ ] **Step 2~4: 구현 → GREEN**

`dispatch` 에 여덟 분기를 더한다. `spawnRunner` 분기의 모양(`read<X>Params` → `isDaemonError`
가드 → 실행 → 로그)을 그대로 따른다. **로그에 이메일·코드를 적지 않는다** — 계정 이름만.

Run: `pnpm --filter @murmur/shared test && pnpm --filter @murmur/daemon test`

- [ ] **Step 5: 커밋**

---

### Task 7: Rust 명령과 이벤트

**Files:**
- Create: `packages/desktop/src-tauri/src/claude_accounts.rs`
- Modify: `packages/desktop/src-tauri/src/main.rs`, `src/daemon_client.rs`
- Test: `packages/desktop/test/runnerShellScope.test.ts`, `test/invokeCommands.test.ts`

**Interfaces:**
- Consumes: Task 6 의 프로토콜
- Produces: `#[tauri::command]` 여덟과 `CLAUDE_LOGIN_EVENT` 상수

- [ ] **Step 1: 회귀선을 먼저 더한다 (RED)**

`test/runnerShellScope.test.ts` 에 `daemon_spawn_runner` 단언과 **같은 모양**으로 여덟을 더한다.
각 명령의 웹뷰 파라미터가 이름·코드·id 뿐이고 **경로나 프로그램이 없다**는 것을 단언한다.

```ts
// spec §7-1: 이 파일은 회귀선을 **확장**한다. (a) shell:allow-execute 0개와
// (b) 프로세스 실행 자리 감시는 그대로 유지되고, (c) 웹뷰 파라미터 단언에 여덟이 더해진다.
// 새 명령은 프로세스를 띄우지 않는다 — 소켓으로 넘길 뿐이다. 실행은 데몬이 한다.
```

- [ ] **Step 2~4: 구현 → GREEN**

- `claude_accounts.rs` 에 여덟. 각 명령은 `ensure_daemon` 뒤 `conn.<method>` 호출뿐이다.
- `main.rs` 의 `generate_handler![...]` 에 여덟 등록. `CLAUDE_LOGIN_EVENT` 상수를
  `RUNNER_EXIT_EVENT` 옆에 둔다.
- `daemon_client.rs` 의 이벤트 분기에 `claudeLoginOutput` 을 더해 웹뷰로 emit 한다
  (`runnerExit` 분기가 판례다).

Run: `pnpm --filter @murmur/desktop test runnerShellScope invokeCommands`
Expected: PASS.

`cargo check` 로 Rust 를 확인한다(경로: `packages/desktop/src-tauri`).

- [ ] **Step 5: 커밋**

---

### Task 8: 설정 섹션 UI

**Files:**
- Create: `packages/desktop/src/components/settings/ClaudeAccountsSettings.tsx`
- Create: `packages/desktop/src/lib/claudeAccounts.ts`
- Modify: `packages/desktop/src/components/settings/sections.ts`, `src/screens/SettingsScreen.tsx`, `src/state/appStore.ts`, `src/state/controller.ts`
- Test: `packages/desktop/src/components/settings/ClaudeAccountsSettings.test.tsx` (신규), `test/settingsSections.test.tsx`(기존이 목차를 검사한다)

**Interfaces:**
- Consumes: Task 7 의 invoke 이름들, Task 1 의 `ClaudePoolsConfig`
- Produces: 섹션 id `'claude-accounts'`

- [ ] **Step 1: RED**

`settingsSections.test.tsx` 가 목차를 검사하므로 먼저 그것을 통과시키는 테스트를 더한다.
새 컴포넌트 테스트는 `settingsScreen.test.tsx` 의 골격(`setController` 주입 + `cleanup`)을 따르고,
Tauri 표면은 `vi.stubGlobal('__TAURI_INTERNALS__', { invoke })` 로 위조한다(기존 판례).

단언 대상:
- 풀과 계정이 그려진다. 로그인 계정은 이메일·조직·구독이, 미로그인은 그 사실이 보인다.
- 기본 풀이 표시되고 바꿀 수 있다.
- **삭제에 확인 단계가 있다** — 자격증명이 사라지는 일이다.
- `strays` 가 있으면 이전 안내가 보인다.
- **러너 재시작이 필요하다는 안내가 보인다**(spec §5-2).
- Tauri 표면이 없으면 "이 빌드에서는 쓸 수 없다"를 말한다.
- **UI 문자열이 영어다.**

- [ ] **Step 2~4: 구현 → GREEN**

읽기는 `useActiveStore`, 쓰기·왕복은 `getController()`. 컨트롤러가 `claude_accounts_list` 를
불러 스토어에 밀어 넣고 **화면은 읽기만** 한다(러너 상태가 이미 그 모양이다).

계정 추가 흐름(spec §8-2): 이름 입력 → `loginStart` → 이벤트의 URL 을 **클릭 가능한 링크**로
(`openExternal`) → **시크릿 창 안내를 그 자리에 적는다** → 코드 입력 → `loginSubmit` → 목록 갱신.

- [ ] **Step 5: 커밋**

---

### Task 9: 에이전트별 풀 선택

**Files:**
- Modify: `packages/desktop/src/components/settings/AgentsSettings.tsx`
- Test: `packages/desktop/src/components/settings/AgentsSettings.test.tsx`(기존)

**Interfaces:**
- Consumes: Task 8 의 컨트롤러 표면

- [ ] **Step 1: RED**

상세 화면 **실행 묶음**에 "Account pool" 선택이 있고, 값이 풀 이름 또는 "기본 풀 사용"이며,
**"This machine only" 안내가 붙는다**(spec §8-3 — 다른 기기에서 안 보이는 것을 버그로 읽지
않게). 쓰기가 `AgentConfig` 가 **아니라** 계정 설정 경로로 가는 것도 단언한다.

- [ ] **Step 2~4: 구현 → GREEN**, [ ] **Step 5: 커밋**

---

### Task 10: 문서와 실물 검증

- [ ] **Step 1: `packages/agent/README.md` 의 다중 계정 절을 풀 구조로 갱신한다**

디렉터리 예시를 두 층으로, `MURMUR_CLAUDE_POOL` 을 더하고, **UI 로 관리할 수 있다는 사실과
러너 재시작이 필요하다는 사실**을 적는다. 손으로 등록하는 명령은 남긴다(UI 없이도 되어야 한다).

- [ ] **Step 2: 루트 `README.md` 환경변수 표에 `MURMUR_CLAUDE_POOL` 을 더한다**

`packages/server/test/repoHygiene.test.ts` 가 `packages/*/src` 전체에서 `env.X` 를 훑어 표와
대조한다 — **빠뜨리면 서버 테스트가 빨개진다.**

- [ ] **Step 3: 전체 테스트**

Run: `pnpm test` — 전부 초록.

- [ ] **Step 4: 실물 검증**

앱에서 풀 둘(`work`·`personal`)을 만들고 각각에 계정을 등록한다. 에이전트 하나를 `personal` 에
배정하고 러너를 재시작한 뒤, 러너 로그의 `claude 계정 N개 (풀: personal)` 줄과 실제 턴이 그
계정으로 도는지 확인한다.

- [ ] **Step 5: 결과를 spec 에 "실물 검증" 절로 덧붙여 커밋한다**

무엇이 통했고 무엇이 안 통했는지 그대로 적는다.

---

## 자체 검토

**스펙 커버리지**

| 스펙 절 | 태스크 |
|---|---|
| §4 디스크 모델, §4-1 단일 writer | Task 1(타입·해석), Task 2(러너는 읽기만) |
| §4-2 기기 로컬 배정 | Task 1(`agents` 맵), Task 9(UI) |
| §4-3 하위 호환·이전 | Task 2(`pools.json` 스위치), Task 4(`strays`·`move`) |
| §5 해석 5단계, §5-1 관용성 갈림 | Task 2 |
| §5-2 재시작 필요 안내 | Task 8 |
| §6 데몬 연산 여덟, §6-1 이벤트, §6-2 재검증 | Task 4·5·6 |
| §7 Rust 표면, §7-1 회귀선 확장 | Task 7 |
| §8 UI | Task 8·9 |
| §9 테스트 | 각 태스크 Step 1 |
| §10 범위 밖 | 태스크 없음(의도) |

**타입 일관성**

- `ClaudePoolsConfig { defaultPool, order, agents }` — Task 1 이 정의, Task 2·4·8 이 쓴다.
- `ClaudeAccount { name, configDir }` — 선행 구현의 것을 그대로 쓴다.
- `loadClaudeAccountLane(...) → { pool: string | null; accounts: ClaudeAccount[] }` — Task 2 정의, Task 3 사용.
- `ClaudeAccountsPort` — Task 4 정의, Task 5 확장, Task 6 주입.

**남은 위험**

- **Task 5(로그인 수명)가 가장 위험하다.** 프로세스·타이머·이벤트가 한자리에 모이고, 실측
  바이트에 의존한다. 가짜 프로세스로 재는 테스트를 먼저 세우지 않으면 실물에서만 드러난다.
- **Task 7 의 회귀선.** 단언을 "확장"이 아니라 "완화"로 짜면 이 설계의 요점이 사라진다.
  `shell:allow-execute` 0개와 프로세스 실행 자리 감시는 **그대로여야 한다.**
- **Task 2 의 `pools.json` 스위치.** 깨진 파일을 "없음"으로 읽으면 풀 모드 러너가 조용히
  암묵 풀로 되돌아가 계정을 풀로 읽는다. 그 테스트가 그것을 고정한다.
