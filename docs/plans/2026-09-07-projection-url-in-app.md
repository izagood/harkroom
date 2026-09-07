# 투영 URL 을 앱에서 켠다 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** admin 이 데스크탑 앱 `설정 › Connection` 에서 avcs base URL 을 넣으면 서버 재시작 없이 투영이 켜진다.

**Architecture:** 새 `ProjectionSupervisor` 가 `ProjectionWorker` 를 최대 하나 쥐고 갈아 끼운다. `ProjectionWorker` 는 손대지 않는다. 우선순위 판정(`resolveProjectionUrl`)은 shared 에 한 벌만 둔다. 옛 워커의 정지를 **기다리지 않는다** — 최악 85 초이고, 겹침은 기존 커서 락이 막는다.

**Tech Stack:** TypeScript · Fastify · zod v3 · Postgres(pg) · React 19 · zustand · vitest

**Spec:** `docs/specs/2026-09-07-projection-url-in-app-design.md`

## Global Constraints

- **커밋 메시지:** Conventional Commits + 한국어 제목 — `feat(server): …` / `test(desktop): …`. 본문에 **왜**를 적는다
- **주석은 한국어로 "왜"를 적는다.** 무엇을 하는지는 코드가 말한다
- **UI 라벨은 영어**(`Projection`, `Server` — `ConnectionSettings` 관례). **사용자에게 사정을 설명하는 투영 문구는 한국어**(`PROJECTION_UNCONFIGURED_*` 선례)
- `strict: true`, **`noUncheckedIndexedAccess: true`** — `res.rows[0]` 는 항상 `?.` 로 받는다
- **지우기는 명시적 `null`.** 키 부재(`undefined`)로 지우기를 표현하지 않는다 — `JSON.stringify` 가 버린다
- 판정은 한 벌. `resolveProjectionUrl` 을 서버·화면이 함께 쓰고, 어느 쪽도 자기 판정을 새로 만들지 않는다
- 테스트 실행: 각 패키지 디렉터리에서 `npx vitest run test/<파일>`. 서버 테스트는 `globalSetup` 이 Postgres 컨테이너를 띄운다(별도 준비 없음)
- **`setProjectionConfig` 는 두 층에 같은 이름으로 있다.** 서버 서비스는
  `setProjectionConfig(pool, url): Promise<string | null>`(저장된 값), 데스크탑은
  `ApiClient/Controller.setProjectionConfig(url): Promise<ProjectionConfigView>`(응답 한 벌)다.
  같은 뜻의 조작이라 이름을 갈라 두지 않았다 — 반환형이 다른 것을 각 작업의 `Interfaces`
  블록이 못 박는다

---

### Task 1: shared — 우선순위 판정과 계약

**Files:**
- Modify: `packages/shared/src/index.ts:1226-1258`
- Test: `packages/shared/test/projectionUrl.test.ts` (create)

**Interfaces:**
- Consumes: 없음 (첫 작업)
- Produces:
  - `type ProjectionUrlSource = 'app' | 'env'`
  - `interface ResolvedProjectionUrl { url: string | null; source: ProjectionUrlSource | null }`
  - `function resolveProjectionUrl(envUrl: string | null, appUrl: string | null): ResolvedProjectionUrl`
  - `interface ProjectionConfigView { url: string | null; source: ProjectionUrlSource | null; appUrl: string | null; envUrl: string | null }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/shared/test/projectionUrl.test.ts`:

```ts
// env 와 앱 설정 중 무엇이 이기는가. **판정이 한 벌이어야 한다** — 서버와 화면이 각자
// 판정하면 화면과 API 가 같은 상태를 다른 말로 부른다(projectionState 와 같은 이유).
import { describe, it, expect } from 'vitest';
import { resolveProjectionUrl } from '../src/index.js';

describe('resolveProjectionUrl', () => {
  it('앱 값이 있으면 env 를 무시한다', () => {
    expect(resolveProjectionUrl('http://env', 'http://app'))
      .toEqual({ url: 'http://app', source: 'app' });
  });

  it('앱 값이 없으면 env 를 쓴다', () => {
    expect(resolveProjectionUrl('http://env', null))
      .toEqual({ url: 'http://env', source: 'env' });
  });

  /** 출처 없는 값에 출처를 붙이지 않는다 — 'env' 라고 답하면 화면이 없는 설정을 있다고 말한다. */
  it('둘 다 없으면 url 도 source 도 null 이다', () => {
    expect(resolveProjectionUrl(null, null)).toEqual({ url: null, source: null });
  });

  /** 빈 문자열은 '없음'이다. 이것을 값으로 받으면 지우기와 오타 저장이 같은 값이 된다. */
  it('빈 문자열은 값으로 세지 않는다', () => {
    expect(resolveProjectionUrl('http://env', '')).toEqual({ url: 'http://env', source: 'env' });
    expect(resolveProjectionUrl('', null)).toEqual({ url: null, source: null });
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd packages/shared && npx vitest run test/projectionUrl.test.ts
```

Expected: FAIL — `resolveProjectionUrl is not a function` (또는 임포트 해결 실패)

- [ ] **Step 3: 최소 구현 + 문구·주석 갱신**

`packages/shared/src/index.ts` — `PROJECTION_STALL_MS` 선언 **앞**에 넣는다:

```ts
/** 투영 URL 이 어디서 왔는가. 화면이 이것을 사람 말로 바꿔 적는다. */
export type ProjectionUrlSource = 'app' | 'env';

export interface ResolvedProjectionUrl {
  url: string | null;
  /** url 이 null 이면 source 도 null — 출처 없는 값에 출처를 붙이지 않는다. */
  source: ProjectionUrlSource | null;
}

/**
 * env 와 앱 설정 중 **무엇으로 투영을 돌리는가**.
 *
 * 앱(DB)이 이긴다. env 는 앱 값이 없을 때만 쓰는 기본값이다. 이 판정이 서버(부팅·재설정)와
 * 라우트 응답 양쪽에 살면 화면과 API 가 같은 상태를 다른 말로 부른다 — `projectionState` 를
 * 여기 둔 것과 같은 이유다.
 *
 * 빈 문자열을 값으로 세지 않는다. 세면 지우기와 오타 저장이 같은 값이 된다.
 */
export function resolveProjectionUrl(
  envUrl: string | null, appUrl: string | null,
): ResolvedProjectionUrl {
  if (appUrl) return { url: appUrl, source: 'app' };
  if (envUrl) return { url: envUrl, source: 'env' };
  return { url: null, source: null };
}

/** `GET`·`PUT /settings/projection` 의 응답. admin 전용 표면이다. */
export interface ProjectionConfigView extends ResolvedProjectionUrl {
  /** DB 에 저장된 값. null 이면 앱에서 정한 것이 없다. */
  appUrl: string | null;
  /** `AVCS_BASE_URL`. 지우기가 무엇으로 복귀하는지 화면이 말할 재료다. */
  envUrl: string | null;
}
```

같은 파일에서 문구와 주석을 고친다:

```ts
// 1227행 주석: 'AVCS_BASE_URL 이 있어서' → 지금은 앱 설정도 워커를 만든다
  /** 투영 URL 이 있어서 워커가 아예 만들어졌는가(`resolveProjectionUrl` 의 결과). */
  configured: boolean;

// 1255행: 앱에서 켤 수 있게 됐으므로 이 문장이 유일한 방법을 말하지 않는다
export const PROJECTION_UNCONFIGURED_DETAIL = '앱 설정이나 AVCS_BASE_URL 로 켠다';
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd packages/shared && npx vitest run test/projectionUrl.test.ts && npx tsc -p . --noEmit
```

Expected: 4 passed · 타입 오류 없음

문구를 리터럴로 단언하는 테스트는 없다(확인 완료) — 상수를 심볼로 쓰는 곳만 있다.

- [ ] **Step 5: 커밋**

```bash
git add packages/shared/src/index.ts packages/shared/test/projectionUrl.test.ts
git commit -m "feat(shared): 투영 URL 의 출처 판정을 한 벌로 둔다

env 와 앱 설정 중 무엇으로 투영을 돌리는지 판정하는 자리를 만든다. 앱(DB)이 이기고
env 는 기본값이다. 서버와 화면이 각자 판정하면 같은 상태를 다른 말로 부르므로
projectionState 와 같은 자리에 둔다.

PROJECTION_UNCONFIGURED_DETAIL 도 고친다 — 앱에서 켤 수 있게 되면
'AVCS_BASE_URL 로 켠다' 는 유일한 방법을 말하지 않는다."
```

---

### Task 2: DB 단일 행 테이블과 읽기·쓰기

**Files:**
- Create: `packages/server/src/db/migrations/041_projection_config.sql`
- Create: `packages/server/src/services/projectionConfig.ts`
- Test: `packages/server/test/projectionConfig.test.ts` (create)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `getProjectionConfig(db: Pool | PoolClient): Promise<string | null>`
  - `setProjectionConfig(pool: Pool, url: string | null): Promise<string | null>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/server/test/projectionConfig.test.ts`:

```ts
// 투영 URL 의 저장 자리(설계 §4). 단일 행 테이블이라야 "투영 URL 이 무엇인가" 에
// 답이 하나다 — 행이 둘이면 어느 쪽을 읽느냐가 정렬 순서 같은 우연에 달린다.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { getProjectionConfig, setProjectionConfig } from '../src/services/projectionConfig.js';

let pool: Pool;
let stop: () => Promise<void>;

beforeAll(async () => { const db = await startTestDb(); pool = db.pool; stop = db.stop; });
afterAll(async () => { await stop(); });
beforeEach(async () => {
  await pool.query(`update projection_config set avcs_base_url = null where id = true`);
});

describe('projection_config', () => {
  /** 읽는 쪽이 "행이 없다" 를 따로 다루지 않도록 마이그레이션이 한 행을 넣어 둔다. */
  it('처음부터 행이 하나 있고 값은 null 이다', async () => {
    const rows = await pool.query(`select count(*)::int as n from projection_config`);
    expect(rows.rows[0]?.n).toBe(1);
    expect(await getProjectionConfig(pool)).toBeNull();
  });

  it('쓴 값을 그대로 읽는다', async () => {
    await setProjectionConfig(pool, 'http://avcs.example:4000');
    expect(await getProjectionConfig(pool)).toBe('http://avcs.example:4000');
  });

  /** 지우기는 명시적 null 이다. 빈 문자열로 지우면 오타 저장과 구분되지 않는다. */
  it('null 로 지운다', async () => {
    await setProjectionConfig(pool, 'http://avcs.example:4000');
    await setProjectionConfig(pool, null);
    expect(await getProjectionConfig(pool)).toBeNull();
  });

  it('빈 문자열은 DB 가 거절한다', async () => {
    await expect(setProjectionConfig(pool, '')).rejects.toThrow();
  });

  // 두 제약을 따로 찌른다 — PK 유일성이 true 행 중복을, check (id) 가 false 행을 막는다.
  it('행을 하나 더 넣으려 하면 DB 가 거절한다', async () => {
    await expect(pool.query(`insert into projection_config (id) values (true)`)).rejects.toThrow();
    await expect(pool.query(`insert into projection_config (id) values (false)`)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd packages/server && npx vitest run test/projectionConfig.test.ts
```

Expected: FAIL — `Cannot find module '../src/services/projectionConfig.js'`

- [ ] **Step 3: 마이그레이션과 서비스를 쓴다**

`packages/server/src/db/migrations/041_projection_config.sql`:

```sql
-- 투영이 바라볼 avcs 서버 주소를 **앱에서** 정할 수 있게 한다.
--
-- 지금까지 이 값은 `AVCS_BASE_URL` 환경변수뿐이었고, 바꾸려면 VM 에 붙어 서버를
-- 재시작해야 했다. 그 자리를 DB 로 옮기면 admin 이 설정 화면에서 켤 수 있다.
-- env 를 없애지는 않는다 — 앱 값이 없을 때의 기본값으로 남는다(resolveProjectionUrl).
--
-- 행이 하나뿐인 테이블이다. `id boolean primary key check (id)` 가 그것을 강제하는
-- 관용구다(017_agent_defaults.sql 과 같다): PK 유일성이 두 번째 true 행을 막고 check 가
-- false 행을 막는다. 행이 둘이면 "투영 URL 이 무엇인가" 에 답이 둘이 되고, 어느 쪽을
-- 읽느냐가 정렬 순서 같은 우연에 달린다.
create table projection_config (
  id boolean primary key default true check (id),
  -- null 이면 '앱에서 정한 것이 없다' → env 로 떨어진다.
  -- 빈 문자열을 '없음' 으로 쓰지 않는다: 섞으면 지우기와 오타 저장이 같은 값이 된다.
  -- URL 형식 검증은 애플리케이션이 한다 — 허용 프로토콜은 코드와 함께 바뀌므로
  -- 스키마 제약으로 굳히지 않는다(004_agent_config.sql 의 harness 와 같은 이유).
  avcs_base_url text check (avcs_base_url is null or length(avcs_base_url) > 0)
);

-- 읽는 쪽이 "행이 없다" 를 따로 다루지 않도록 처음부터 한 행을 둔다.
insert into projection_config (id) values (true);
```

`packages/server/src/services/projectionConfig.ts`:

```ts
import type { Pool, PoolClient } from 'pg';

/**
 * 앱에서 정한 투영 URL(마이그레이션 041). **여기서 우선순위를 판정하지 않는다** —
 * env 와 견주는 일은 `resolveProjectionUrl`(shared) 하나가 한다. 이 모듈은 저장 자리를
 * 읽고 쓸 뿐이다.
 *
 * `null` 은 '앱에서 정한 것이 없다' 이고, 그때 부름의 결과는 env 로 떨어진다.
 */
export async function getProjectionConfig(db: Pool | PoolClient): Promise<string | null> {
  const res = await db.query(`select avcs_base_url from projection_config where id = true`);
  // noUncheckedIndexedAccess: rows[0] 는 undefined 일 수 있다(마이그레이션이 행을 넣지만
  // 타입이 그것을 모른다). 없으면 '정한 것이 없다' 와 같은 뜻이므로 null 로 접는다.
  return (res.rows[0]?.avcs_base_url ?? null) as string | null;
}

/** `null` 이 지우기다. 빈 문자열은 DB 의 check 가 거절한다 — 지우기와 섞이지 않게. */
export async function setProjectionConfig(
  pool: Pool, url: string | null,
): Promise<string | null> {
  const res = await pool.query(
    `update projection_config set avcs_base_url = $1 where id = true
     returning avcs_base_url`,
    [url],
  );
  return (res.rows[0]?.avcs_base_url ?? null) as string | null;
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd packages/server && npx vitest run test/projectionConfig.test.ts
```

Expected: 5 passed

- [ ] **Step 5: 커밋**

```bash
git add packages/server/src/db/migrations/041_projection_config.sql \
        packages/server/src/services/projectionConfig.ts \
        packages/server/test/projectionConfig.test.ts
git commit -m "feat(server): 앱에서 정한 투영 URL 의 저장 자리를 만든다

단일 행 테이블(017_agent_defaults.sql 관용구). null 이 '앱에서 정한 것이 없다' 이고
그때 env 로 떨어진다. 빈 문자열은 check 가 거절한다 — 값으로 받으면 지우기와 오타
저장이 같은 값이 된다.

우선순위 판정은 여기 없다. env 와 견주는 일은 resolveProjectionUrl 하나가 한다."
```

---

### Task 3: `ProjectionSupervisor` — 워커를 갈아 끼운다

**Files:**
- Create: `packages/server/src/avcs/supervisor.ts`
- Test: `packages/server/test/projectionSupervisor.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectionWorker`·`ProjectionDeps`·`ProjectionWorkerStatus`·`DISABLED_PROJECTION_STATUS` (`../src/avcs/projection.js`), `httpAvcsClient`·`AvcsServerClient` (`../src/avcs/client.js`)
- Produces:
  - `class ProjectionSupervisor`
  - `constructor(deps: { pool: Pool; makeClient?: (baseUrl: string) => AvcsServerClient; makeWorker?: (deps: ProjectionDeps) => ProjectionWorker })`
  - `status(): ProjectionWorkerStatus`
  - `reconfigure(url: string | null): Promise<void>`
  - `stop(): Promise<void>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/server/test/projectionSupervisor.test.ts`:

```ts
/**
 * 워커를 갈아 끼우는 자리(설계 §1·§2). 이 파일이 가장 신경 쓰는 것은 **정지를 기다리지
 * 않는다** 는 성질이다.
 *
 * `worker.stop()` 은 루프를 await 하고, 루프는 `waitForChange(…, 25_000)` 에 걸려 있으며
 * 실패 사이클이면 백오프가 60_000 까지 간다 — `await stop()` 은 최악 85 초다. 저장 버튼을
 * 누른 사람을 그만큼 기다리게 할 수 없다. 겹침은 `runOnce` 의 커서 락이 막는다.
 *
 * DB 를 쓰지 않는다. supervisor 의 일은 생명주기이고, 가짜 워커로 그것을 전부 잴 수 있다.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { AvcsServerClient } from '../src/avcs/client.js';
import type { ProjectionDeps, ProjectionWorker } from '../src/avcs/projection.js';
import { ProjectionSupervisor } from '../src/avcs/supervisor.js';

const pool = {} as Pool;
const client = {} as AvcsServerClient;

interface Fake {
  started: boolean;
  stopped: boolean;
  connected: boolean;
  stopCalls: number;
}

/** 가짜 워커 + 만들어진 순서 기록. `stop()` 의 완료 시점을 시험이 쥔다. */
function harness(opts: { stopHangs?: boolean } = {}) {
  const made: Fake[] = [];
  const urls: string[] = [];

  const makeClient = (baseUrl: string): AvcsServerClient => { urls.push(baseUrl); return client; };

  const makeWorker = (_deps: ProjectionDeps): ProjectionWorker => {
    const f: Fake = { started: false, stopped: false, connected: false, stopCalls: 0 };
    made.push(f);
    return {
      start: () => { f.started = true; },
      // 정지는 **동기적으로 표시**하고, 완료 프로미스는 따로 준다 — 기다리는지 아닌지를
      // 이 둘로 가른다.
      stop: () => {
        f.stopped = true;
        f.stopCalls += 1;
        return opts.stopHangs ? new Promise<void>(() => { /* 영원히 안 끝난다 */ }) : Promise.resolve();
      },
      status: () => ({
        configured: true, connected: f.connected, repo: null, lastLogIndex: 0,
        lastPolledAt: null, lastAdvancedAt: null, lastError: null,
      }),
    } as unknown as ProjectionWorker;
  };

  const sup = new ProjectionSupervisor({ pool, makeClient, makeWorker });
  return { sup, made, urls, alive: () => made.filter((f) => !f.stopped) };
}

describe('ProjectionSupervisor', () => {
  it('URL 이 있으면 워커를 세운다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    expect(h.made).toHaveLength(1);
    expect(h.made[0]?.started).toBe(true);
    expect(h.urls).toEqual(['http://a']);
    expect(h.sup.status().configured).toBe(true);
  });

  /** 워커가 없다는 것이 곧 '설정되지 않았다' 다 — 그 답을 supervisor 가 대신한다. */
  it('URL 이 없으면 워커가 없고 DISABLED 를 답한다', async () => {
    const h = harness();
    await h.sup.reconfigure(null);
    expect(h.made).toHaveLength(0);
    expect(h.sup.status()).toMatchObject({ configured: false, connected: false });
  });

  it('reconfigure(null) 이면 워커가 내려간다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    await h.sup.reconfigure(null);
    expect(h.made[0]?.stopped).toBe(true);
    expect(h.sup.status().configured).toBe(false);
  });

  /**
   * 같은 URL 로 저장한 것이 폴링을 끊으면, 아무것도 바꾸지 않은 저장이 화면에서
   * "저장했더니 투영이 잠깐 멈췄다" 로 보인다.
   */
  it('같은 URL 이면 워커를 교체하지 않는다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    await h.sup.reconfigure('http://a');
    expect(h.made).toHaveLength(1);
    expect(h.made[0]?.stopped).toBe(false);
  });

  /**
   * **이 파일의 핵심 회귀선.** `stop()` 이 영원히 안 끝나도 `reconfigure` 는 끝나야 한다.
   * 되돌리기 실험: supervisor 에서 `void old.stop()` 을 `await old.stop()` 으로 바꾸면
   * 이 테스트가 타임아웃으로 죽는다 — 그것이 실제로 PUT 핸들러에서 벌어지는 일이다.
   */
  it('옛 워커의 정지를 기다리지 않는다', async () => {
    const h = harness({ stopHangs: true });
    await h.sup.reconfigure('http://a');

    await h.sup.reconfigure('http://b');

    expect(h.made).toHaveLength(2);
    expect(h.made[1]?.started).toBe(true);
    expect(h.made[0]?.stopped).toBe(true);
  });

  /** 직렬화가 없으면 워커가 둘 살아남는다 — 같은 repo 를 둘이 영구히 폴링한다. */
  it('동시에 재설정해도 살아 있는 워커는 하나다', async () => {
    const h = harness();
    const first = h.sup.reconfigure('http://b');
    const second = h.sup.reconfigure('http://c');
    await Promise.all([first, second]);

    expect(h.alive()).toHaveLength(1);
    expect(h.urls).toEqual(['http://b', 'http://c']);
  });

  /** SIGTERM 경로. 여기서는 기다린다 — 프로세스가 워커를 남기고 죽으면 안 된다. */
  it('stop() 은 정지를 기다리고 워커를 남기지 않는다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');

    await h.sup.stop();

    expect(h.made[0]?.stopped).toBe(true);
    expect(h.sup.status().configured).toBe(false);
  });

  /** 교체가 진행 중일 때 종료되면 그 교체가 세운 워커가 남을 수 있다. */
  it('진행 중인 교체를 마친 뒤 종료한다', async () => {
    const h = harness();
    void h.sup.reconfigure('http://a');
    await h.sup.stop();
    expect(h.alive()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd packages/server && npx vitest run test/projectionSupervisor.test.ts
```

Expected: FAIL — `Cannot find module '../src/avcs/supervisor.js'`

- [ ] **Step 3: 최소 구현**

`packages/server/src/avcs/supervisor.ts`:

```ts
import type { Pool } from 'pg';
import { httpAvcsClient, type AvcsServerClient } from './client.js';
import {
  DISABLED_PROJECTION_STATUS, ProjectionWorker,
  type ProjectionDeps, type ProjectionWorkerStatus,
} from './projection.js';

export interface ProjectionSupervisorDeps {
  pool: Pool;
  /** 테스트가 가짜를 주입한다. 기본은 실제 HTTP 클라이언트. */
  makeClient?: (baseUrl: string) => AvcsServerClient;
  /** 테스트가 가짜를 주입한다. 기본은 실제 워커. */
  makeWorker?: (deps: ProjectionDeps) => ProjectionWorker;
}

/**
 * 투영 워커를 **최대 하나** 쥐고 URL 이 바뀌면 갈아 끼운다.
 *
 * ## 왜 `ProjectionWorker` 안이 아니라 여기인가
 *
 * 그 파일은 "워커가 만들어졌다는 것 자체가 URL 이 있었다는 뜻" 이라는 불변식 위에 서 있고
 * `configured: true` 를 그래서 하드코딩한다. 워커를 재설정 가능하게 만들면 그 불변식이
 * 뒤집히고 폴 루프가 '클라이언트 없음 = 유휴' 를 새로 다뤄야 한다. 가변성을 밖으로 빼면
 * 워커는 계속 자기 URL 하나만 아는 물건으로 남는다.
 *
 * ## 왜 `main.ts` 가 아니라 별 모듈인가
 *
 * `main.ts` 는 최상위 await 로 서버를 띄우는 스크립트라 **임포트만으로 포트를 잡는다** —
 * 그 안의 판정은 어떤 테스트도 확인할 수 없다. 같은 이유로 `warnIfProjectionDisabled` 가
 * 이미 `projection.ts` 로 빠져 있다. 생명주기는 그 경고 한 줄보다 훨씬 실수하기 쉽다.
 */
export class ProjectionSupervisor {
  private worker: ProjectionWorker | null = null;
  private url: string | null = null;
  /**
   * 교체를 직렬화한다. 없으면 동시 저장 둘이 각각 워커를 세워 **둘이 살아남고**, 같은 repo 를
   * 영구히 둘이 폴링한다.
   */
  private chain: Promise<void> = Promise.resolve();
  private readonly makeClient: (baseUrl: string) => AvcsServerClient;
  private readonly makeWorker: (deps: ProjectionDeps) => ProjectionWorker;

  constructor(private readonly deps: ProjectionSupervisorDeps) {
    this.makeClient = deps.makeClient ?? httpAvcsClient;
    this.makeWorker = deps.makeWorker ?? ((d) => new ProjectionWorker(d));
  }

  /** 워커가 없으면 '설정되지 않았다' 다 — `main.ts` 의 `?? DISABLED` 가 여기로 들어왔다. */
  status(): ProjectionWorkerStatus {
    return this.worker?.status() ?? DISABLED_PROJECTION_STATUS;
  }

  reconfigure(url: string | null): Promise<void> {
    this.chain = this.chain.then(() => { this.swap(url); });
    return this.chain;
  }

  private swap(url: string | null): void {
    // 같은 URL 로 교체하면 커서와 long-poll 이 다시 걸려, 아무것도 바꾸지 않은 저장이
    // 폴링을 한 번 끊는다. 화면에서는 그것이 "저장했더니 투영이 멈췄다" 로 보인다.
    if (url === this.url) return;

    const old = this.worker;
    this.url = url;
    this.worker = url === null
      ? null
      : this.makeWorker({ pool: this.deps.pool, avcs: this.makeClient(url) });
    this.worker?.start();

    /**
     * **정지를 기다리지 않는다.** `stop()` 은 루프를 await 하고 루프는
     * `waitForChange(…, 25_000)` 에 걸려 있다 — 실패 중이면 백오프까지 더해 최악 85 초다.
     * PUT 핸들러가 그것을 기다리면 저장 버튼이 그만큼 매달린다.
     *
     * 겹쳐도 안전한 근거는 이미 코드에 있다: `runOnce` 가 커서를 `for update` 로 잠그고
     * `currentSince !== since` 면 배치를 폐기한다("다른 실행이 이미 커서를 전진시켰다").
     * 빠지는 워커가 자기 `runtime` 에 쓰는 것도 무해하다 — `status()` 는 새 워커에게 묻는다.
     */
    if (old) void old.stop().catch(() => { /* 빠지는 워커의 실패는 이 자리의 관심이 아니다 */ });
  }

  /**
   * SIGTERM 경로. 여기서는 **기다린다** — 프로세스가 워커를 남기고 죽으면 in-flight
   * long-poll 이 정상 마감되지 않는다.
   *
   * 진행 중인 교체를 먼저 마치게 한다. 안 그러면 그 교체가 세운 워커가 남는다.
   */
  async stop(): Promise<void> {
    await this.chain;
    const w = this.worker;
    this.worker = null;
    this.url = null;
    await w?.stop();
  }
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd packages/server && npx vitest run test/projectionSupervisor.test.ts && npx tsc -p . --noEmit
```

Expected: 8 passed · 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add packages/server/src/avcs/supervisor.ts packages/server/test/projectionSupervisor.test.ts
git commit -m "feat(server): 투영 워커를 갈아 끼우는 자리를 만든다

ProjectionWorker 는 손대지 않는다 — '워커가 있다 = configured' 라는 그 파일의 불변식이
그대로 산다. main.ts 가 아니라 별 모듈인 이유는 그 파일이 임포트만으로 포트를 잡아
안에 든 판정을 시험할 수 없기 때문이다(warnIfProjectionDisabled 를 뺀 것과 같은 이유).

정지를 기다리지 않는다. stop() 은 루프를 await 하고 루프는 waitForChange(…, 25s) 에
걸려 있어 백오프까지 더하면 최악 85 초다. 겹침은 runOnce 의 커서 락이 막는다 —
'다른 실행이 이미 커서를 전진시켰다' 는 이미 다루던 사정이다.

교체는 프로미스 체인으로 직렬화한다. 없으면 동시 저장 둘이 각각 워커를 세워 둘이
살아남고 같은 repo 를 영구히 둘이 폴링한다."
```

---

### Task 4: 라우트와 `buildServer` 접합면

**Files:**
- Modify: `packages/server/src/routes/settingsRoutes.ts`
- Modify: `packages/server/src/buildServer.ts:59-108` (`ServerDeps`), `:325` (등록 호출)
- Test: `packages/server/test/projectionSettings.test.ts` (create)

**Interfaces:**
- Consumes: `getProjectionConfig`·`setProjectionConfig` (Task 2), `resolveProjectionUrl`·`ProjectionConfigView` (Task 1)
- Produces:
  - `ServerDeps.projection?: { envBaseUrl: string | null; reconfigure(url: string | null): Promise<void> }`
  - `registerSettingsRoutes(app, pool, projection?)` — 세 번째 인자가 새로 생긴다
  - `GET`·`PUT /settings/projection`
  - 감사 action 문자열 `'projection.url.updated'`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/server/test/projectionSettings.test.ts`:

```ts
/**
 * 앱에서 투영 URL 을 켜는 표면(설계 §5). `agentDefaults.test.ts` 와 같은 게이트를 쓴다 —
 * 읽기도 admin 이다: URL 은 인프라 설정이고, 상태(`/projection/status`, requireAccount)와
 * 설정은 다른 표면이다.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let plainToken: string;
const reconfigure = vi.fn(async (_url: string | null) => { /* supervisor 대역 */ });

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({
    pool: db.pool,
    projection: { envBaseUrl: 'http://env.example:4000', reconfigure },
  });
  ({ token: adminToken } = await bootstrapAdmin(app));

  const inv = await app.inject({
    method: 'POST', url: '/invites', headers: { authorization: `Bearer ${adminToken}` },
  });
  await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle: 'plainuser', loginId: 'plainuser', displayName: 'Plain User', password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId: 'plainuser', password: 'pw123456' },
  });
  plainToken = login.json().token as string;
});
afterAll(async () => { await app.close(); await stop(); });

const admin = () => ({ authorization: `Bearer ${adminToken}` });
const get = (headers = admin()) =>
  app.inject({ method: 'GET', url: '/settings/projection', headers });
const put = (payload: object, headers = admin()) =>
  app.inject({ method: 'PUT', url: '/settings/projection', headers, payload });

beforeEach(async () => {
  reconfigure.mockClear();
  await pool.query(`update projection_config set avcs_base_url = null where id = true`);
});

describe('GET /settings/projection', () => {
  /** 지우기가 무엇으로 복귀하는지 화면이 말해야 한다 — 그래서 envUrl 도 내보낸다. */
  it('앱 값이 없으면 env 를 쓰고 두 출처를 함께 준다', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      url: 'http://env.example:4000', source: 'env',
      appUrl: null, envUrl: 'http://env.example:4000',
    });
  });

  it('앱 값이 있으면 그것이 이긴다', async () => {
    await put({ url: 'http://app.example:5000' });
    expect((await get()).json()).toEqual({
      url: 'http://app.example:5000', source: 'app',
      appUrl: 'http://app.example:5000', envUrl: 'http://env.example:4000',
    });
  });

  it('admin 이 아니면 403 이다', async () => {
    expect((await get({ authorization: `Bearer ${plainToken}` })).statusCode).toBe(403);
  });
});

describe('PUT /settings/projection', () => {
  it('저장한 URL 로 워커를 갈아 끼운다', async () => {
    const res = await put({ url: 'http://app.example:5000' });

    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe('app');
    expect(reconfigure).toHaveBeenCalledWith('http://app.example:5000');
  });

  /** 지우기는 명시적 null 이다. 지운 뒤 돌아갈 곳이 env 이므로 그 값으로 재설정된다. */
  it('null 로 지우면 env 로 복귀하고 그 값으로 재설정한다', async () => {
    await put({ url: 'http://app.example:5000' });
    reconfigure.mockClear();

    const res = await put({ url: null });

    expect(res.json()).toMatchObject({ appUrl: null, source: 'env', url: 'http://env.example:4000' });
    expect(reconfigure).toHaveBeenCalledWith('http://env.example:4000');
  });

  /** `z.string().url()` 만으로는 file:·ftp: 가 통과한다. 그것을 서버의 아웃바운드 대상으로
   *  두면 avcs 가 아닌 것을 투영하려 든다. */
  it('http(s) 가 아니면 400 이고 저장도 재설정도 하지 않는다', async () => {
    const res = await put({ url: 'ftp://avcs.example' });

    expect(res.statusCode).toBe(400);
    expect((await get()).json().appUrl).toBeNull();
    expect(reconfigure).not.toHaveBeenCalled();
  });

  it('URL 형태가 아니면 400 이다', async () => {
    expect((await put({ url: 'not a url' })).statusCode).toBe(400);
  });

  it('빈 문자열은 400 이다 — 지우기는 null 이다', async () => {
    expect((await put({ url: '' })).statusCode).toBe(400);
  });

  it('admin 이 아니면 403 이고 값도 바뀌지 않는다', async () => {
    const res = await put({ url: 'http://intruder.example' }, { authorization: `Bearer ${plainToken}` });

    expect(res.statusCode).toBe(403);
    expect((await get()).json().appUrl).toBeNull();
  });

  /** "누가 서버의 아웃바운드 대상을 바꿨나" 가 이 기록의 존재 이유다. */
  it('변경을 감사에 남긴다', async () => {
    await put({ url: 'http://app.example:5000' });

    const rows = await pool.query(
      `select detail from audit_log where action = 'projection.url.updated' order by id desc limit 1`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]?.detail).toMatchObject({
      before: { appUrl: null, source: 'env' },
      after: { appUrl: 'http://app.example:5000', source: 'app' },
    });
  });
});

/**
 * 이 표면 없이 서버를 띄우는 테스트가 많다. 등록해 두고 500 을 내는 것보다 404 가 정직하다 —
 * 500 은 "고장났다" 는 뜻이고, 여기서 참인 것은 "그 표면이 없다" 다.
 */
describe('deps.projection 이 없으면', () => {
  it('두 라우트가 404 다', async () => {
    const db = await startTestDb();
    const bare = await buildServer({ pool: db.pool });
    const { token } = await bootstrapAdmin(bare);
    const headers = { authorization: `Bearer ${token}` };

    expect((await bare.inject({ method: 'GET', url: '/settings/projection', headers })).statusCode).toBe(404);
    expect((await bare.inject({
      method: 'PUT', url: '/settings/projection', headers, payload: { url: null },
    })).statusCode).toBe(404);

    await bare.close();
    await db.stop();
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd packages/server && npx vitest run test/projectionSettings.test.ts
```

Expected: FAIL — `projection` 이 `ServerDeps` 에 없어 타입 오류, 그리고 두 라우트가 404

- [ ] **Step 3: 구현**

`packages/server/src/buildServer.ts` — `ServerDeps` 의 `getProjectionStatus` 바로 아래에 넣는다:

```ts
  /**
   * 투영 **설정** 표면(`/settings/projection`). 상태(`getProjectionStatus`)와 다른 질문에
   * 답한다: 무엇을 바라볼 것인가.
   *
   * supervisor 인스턴스를 통째로 받지 않는 이유: 라우트가 필요한 것은 env 값과 갈아 끼우는
   * 동작 둘뿐이다. 클래스를 받으면 이 파일과 라우트 테스트가 그것에 매이고, 가짜를 만들려면
   * 쓰지도 않는 `stop()`·`status()` 까지 함께 구현해야 한다.
   *
   * 미지정이면 두 라우트를 **등록하지 않는다**. 등록해 두고 500 을 내는 것보다 404 가
   * 정직하다 — 500 은 "고장났다" 는 뜻이고, 여기서 참인 것은 "그 표면이 없다" 다.
   */
  projection?: {
    /** `AVCS_BASE_URL`. 응답의 `envUrl` 이자 `resolveProjectionUrl` 의 첫 인자다. */
    envBaseUrl: string | null;
    reconfigure(url: string | null): Promise<void>;
  };
```

같은 파일 `:325` 의 등록 호출:

```ts
  await registerSettingsRoutes(app, deps.pool, deps.projection);
```

`packages/server/src/routes/settingsRoutes.ts` — 임포트를 늘리고:

```ts
import { RUNNABLE_HARNESSES, resolveProjectionUrl, type ProjectionConfigView } from '@murmur/shared';
import { getAgentDefaults, updateAgentDefaults } from '../services/agentDefaults.js';
import { getProjectionConfig, setProjectionConfig } from '../services/projectionConfig.js';
```

시그니처와 새 라우트:

```ts
/**
 * `z.string().url()` 만으로는 `file:`·`ftp:` 가 통과한다. 그것을 서버의 아웃바운드 대상으로
 * 두면 avcs 가 아닌 것을 투영하려 든다. 그래서 프로토콜까지 본다.
 *
 * 후행 슬래시는 정규화하지 않는다 — `httpAvcsClient` 가 이미 자른다(`client.ts:162`).
 * 두 곳에서 자르면 어느 쪽이 진실인지가 흐려진다.
 */
const PROJECTION_URL = z.string().min(1).max(512).refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'http(s) URL 이어야 한다');

export async function registerSettingsRoutes(
  app: FastifyInstance,
  pool: Pool,
  projection?: {
    envBaseUrl: string | null;
    reconfigure(url: string | null): Promise<void>;
  },
): Promise<void> {
  // … 기존 agent-defaults 라우트 두 개는 그대로 …

  // 이 표면 없이 뜨는 서버가 많다(테스트 대부분). 없으면 등록하지 않는다.
  if (!projection) return;

  /** 응답 한 벌. 판정은 `resolveProjectionUrl` 이 하고 이 함수는 재료를 모을 뿐이다. */
  const view = async (): Promise<ProjectionConfigView> => {
    const appUrl = await getProjectionConfig(pool);
    const { url, source } = resolveProjectionUrl(projection.envBaseUrl, appUrl);
    return { url, source, appUrl, envUrl: projection.envBaseUrl };
  };

  app.get('/settings/projection', { preHandler: app.requireAdmin }, view);

  app.put('/settings/projection', { preHandler: app.requireAdmin }, async (req) => {
    // 지우기는 **명시적 null** 이다. 키를 빼는 것으로 표현하면 `JSON.stringify` 가
    // `undefined` 를 버리는 것과 구분되지 않아 지우려는 조작이 '손대지 않음'이 된다.
    const body = z.object({ url: PROJECTION_URL.nullable() }).parse(req.body);

    const before = await view();
    await setProjectionConfig(pool, body.url);
    const after = await view();
    // **부름의 결과가 아니라 판정의 결과로 재설정한다.** body.url 로 부르면 지우기
    // (null)가 '투영을 끈다' 가 되어 env 로 복귀하지 않는다.
    await projection.reconfigure(after.url);
    await recordAudit(pool, {
      action: 'projection.url.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      detail: {
        before: { appUrl: before.appUrl, source: before.source },
        after: { appUrl: after.appUrl, source: after.source },
      },
    }, req);
    return after;
  });
}
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd packages/server && npx vitest run test/projectionSettings.test.ts test/agentDefaults.test.ts && npx tsc -p . --noEmit
```

Expected: 두 파일 모두 통과 (`agentDefaults` 는 세 번째 인자가 옵셔널이라 그대로 초록) · 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add packages/server/src/routes/settingsRoutes.ts packages/server/src/buildServer.ts \
        packages/server/test/projectionSettings.test.ts
git commit -m "feat(server): 투영 URL 을 읽고 쓰는 admin 표면을 낸다

읽기도 requireAdmin 이다 — URL 은 인프라 설정이고, 상태(/projection/status,
requireAccount)와 설정은 다른 표면이다. /projection/status 는 건드리지 않는다:
거기에 URL 을 실으면 인프라 설정이 전원에게 나간다.

buildServer 는 supervisor 클래스를 알지 않는다. 라우트가 필요한 것은 env 값과 갈아
끼우는 동작 둘뿐이라 그 둘만 받는다 — 클래스를 받으면 가짜를 만들 때 쓰지도 않는
stop()·status() 를 함께 구현해야 한다. 미지정이면 등록하지 않는다: 등록해 두고 500 을
내는 것보다 404 가 정직하다.

재설정은 body.url 이 아니라 판정 결과로 부른다. body.url 로 부르면 지우기(null)가
'투영을 끈다' 가 되어 env 로 복귀하지 않는다."
```

---

### Task 5: `main.ts` 배선 — 부팅과 종료

**Files:**
- Modify: `packages/server/src/main.ts` (전체)

**Interfaces:**
- Consumes: `ProjectionSupervisor` (Task 3), `getProjectionConfig` (Task 2), `resolveProjectionUrl` (Task 1), `ServerDeps.projection` (Task 4)
- Produces: 없음 (배선만 — 다음 작업이 의존하는 심볼이 없다)

**이 작업의 검증은 회귀선이 아니다.** `main.ts` 는 임포트만으로 포트를 잡는 스크립트라
단위 테스트를 붙일 수 없다. 그래서 판정을 이 파일에 두지 않았다 — 판정은 Task 1·3 이
이미 회귀선으로 덮었고, 여기 남는 것은 배선뿐이다. 검증은 타입 검사 + 스위트 전체 +
실제 기동 스모크다.

- [ ] **Step 1: 배선을 고친다**

`packages/server/src/main.ts` — 임포트와 워커 생성부:

```ts
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { buildServer } from './buildServer.js';
import { warnIfProjectionDisabled } from './avcs/projection.js';
import { ProjectionSupervisor } from './avcs/supervisor.js';
import { getProjectionConfig } from './services/projectionConfig.js';
import { resolveProjectionUrl } from '@murmur/shared';
import { Lifecycle } from './lifecycle.js';
```

`runMigrations` 다음, `let worker … warnIfProjectionDisabled(...)` 블록을 이것으로 바꾼다:

```ts
// 워커를 쥐는 자리가 supervisor 로 옮겨갔다(#537 후속). 이 파일에 `let worker` 를 두면
// 그것을 갈아 끼우는 판정도 여기 남고, 이 파일은 임포트만으로 포트를 잡아 시험할 수 없다.
const supervisor = new ProjectionSupervisor({ pool });
// 마이그레이션 뒤에 읽는다 — projection_config 테이블이 그때 생긴다.
const boot = resolveProjectionUrl(config.avcsBaseUrl, await getProjectionConfig(pool));
await supervisor.reconfigure(boot.url);
// 꺼져 있으면 기동 시 경고 한 줄(#267). **판정 결과로 묻는다** — env 가 없어도 앱에서
// 켜 뒀으면 투영은 돌고 있고, 그때 경고를 내면 화면과 로그가 서로 다른 말을 한다.
warnIfProjectionDisabled(boot.url);
```

`buildServer` 호출의 deps:

```ts
  getAvcsStatus: () => ({ connected: supervisor.status().connected }),
  getProjectionStatus: () => supervisor.status(),
  // 앱에서 투영을 켜는 표면. env 값은 여기서만 흘러 들어간다 — 라우트는 config 를 모른다.
  projection: {
    envBaseUrl: config.avcsBaseUrl,
    reconfigure: (url) => supervisor.reconfigure(url),
  },
```

기동 로그 — **출처를 함께 적는다.** 어느 쪽이 이겼는지 로그에서 알 수 없으면
"env 를 넣었는데 왜 안 먹나" 를 서버에서 확인할 방법이 없다:

```ts
console.log(
  `murmur server on :${config.port} `
  + `(avcs: ${boot.url ?? 'disabled'}${boot.source ? ` via ${boot.source}` : ''})`,
);
```

SIGINT·SIGTERM 핸들러:

```ts
    await lifecycle.beginDrain();
    await supervisor.stop();
    await app.close();
    await pool.end();
```

- [ ] **Step 2: 타입 검사와 서버 스위트 전체를 돌린다**

```bash
cd packages/server && npx tsc -p . --noEmit && npx vitest run
```

Expected: 타입 오류 없음 · 전부 통과. 특히 `projectionStatus.test.ts` 가 초록이어야 한다 —
`DISABLED_PROJECTION_STATUS` 를 답하는 경로가 `main.ts` 에서 supervisor 로 옮겨갔지만
그 파일은 `warnIfProjectionDisabled`·`buildServer` 를 직접 부르므로 영향받지 않는다.

- [ ] **Step 3: 실제 기동 스모크**

`AVCS_BASE_URL` 없이 띄워 로그와 상태를 눈으로 확인한다.

```bash
cd packages/server
DATABASE_URL=postgres://murmur:murmur@localhost:5433/murmur npx tsx src/main.ts
```

Expected 로그: `murmur server on :3400 (avcs: disabled)` + `avcs projection is disabled — set AVCS_BASE_URL to enable it`

`AVCS_BASE_URL` 을 주고 다시 띄운다:

```bash
DATABASE_URL=postgres://murmur:murmur@localhost:5433/murmur \
AVCS_BASE_URL=http://localhost:4000 npx tsx src/main.ts
```

Expected 로그: `murmur server on :3400 (avcs: http://localhost:4000 via env)` · 경고 없음

- [ ] **Step 4: 커밋**

```bash
git add packages/server/src/main.ts
git commit -m "feat(server): 부팅 시 투영 URL 을 판정으로 정하고 supervisor 에 맡긴다

let worker 가 supervisor 로 옮겨갔다. 이 파일에 두면 갈아 끼우는 판정도 여기 남고,
이 파일은 임포트만으로 포트를 잡아 그 판정을 시험할 수 없다.

기동 경고는 env 가 아니라 판정 결과로 묻는다 — env 가 없어도 앱에서 켜 뒀으면 투영은
돌고 있고, 그때 경고를 내면 화면과 로그가 서로 다른 말을 한다. 기동 로그에 출처도
적는다: 어느 쪽이 이겼는지 모르면 'env 를 넣었는데 왜 안 먹나' 를 서버에서 확인할
방법이 없다."
```

---

### Task 6: 데스크탑 — api 와 controller

**Files:**
- Modify: `packages/desktop/src/lib/api.ts:433-442` (`agentDefaults` 바로 아래)
- Modify: `packages/desktop/src/state/controller.ts:1024-1033` (`agentDefaults` 위임 바로 아래)
- Test: `packages/desktop/test/projectionConfigApi.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectionConfigView` (Task 1)
- Produces:
  - `ApiClient.projectionConfig(): Promise<ProjectionConfigView>`
  - `ApiClient.setProjectionConfig(url: string | null): Promise<ProjectionConfigView>`
  - `Controller.projectionConfig()`·`Controller.setProjectionConfig(url)`
  - `Controller.refreshProjection(): Promise<void>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/desktop/test/projectionConfigApi.test.ts`:

```ts
/**
 * 투영 설정을 부르는 두 창구와, **저장 직후 상태를 다시 읽는 창구**(설계 §6).
 *
 * 세 번째가 중요하다: 앱은 투영 상태를 60 초 주기로 갱신한다(`controller.ts` 의
 * `projectionRefreshInterval`). 그 주기에 맡기면 방금 켠 투영이 최대 1 분 동안 꺼진
 * 것처럼 보이고, 사용자는 저장이 실패했다고 읽는다.
 *
 * `ApiClient` 는 fetch 를 주입받지 않고 전역을 쓴다 — `api.test.ts` 의 `stubFetch`
 * 관용구를 그대로 베낀다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ProjectionConfigView } from '@murmur/shared';
import { ApiClient } from '../src/lib/api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const view: ProjectionConfigView = {
  url: 'http://app.example:5000', source: 'app',
  appUrl: 'http://app.example:5000', envUrl: 'http://env.example:4000',
};

describe('ApiClient — 투영 설정', () => {
  it('GET /settings/projection 을 부른다', async () => {
    const fn = stubFetch(200, view);
    const api = new ApiClient('http://x:3400', 'tok');

    expect(await api.projectionConfig()).toEqual(view);

    const [url] = fn.mock.calls[0]! as unknown as [string];
    expect(url).toBe('http://x:3400/settings/projection');
  });

  /**
   * 지우기는 **명시적 null** 이다. 빈 문자열로 보내면 서버가 400 을 내고, 키를 빼면
   * `JSON.stringify` 가 통째로 버려 '손대지 않음' 이 된다.
   */
  it('지우기를 null 로 보낸다', async () => {
    const fn = stubFetch(200, { url: null, source: null, appUrl: null, envUrl: null });
    const api = new ApiClient('http://x:3400', 'tok');

    await api.setProjectionConfig(null);

    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://x:3400/settings/projection');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ url: null });
  });

  /** admin 이 아니면 403 이다. 삼키지 않고 던져야 호출부가 그것을 가릴 수 있다. */
  it('403 을 삼키지 않는다', async () => {
    stubFetch(403, { error: { code: 'forbidden', message: 'nope' } });
    const api = new ApiClient('http://x:3400', 'tok');

    await expect(api.projectionConfig()).rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd packages/desktop && npx vitest run test/projectionConfigApi.test.ts
```

Expected: FAIL — `api.projectionConfig is not a function`

- [ ] **Step 3: 구현**

`packages/desktop/src/lib/api.ts` — `updateAgentDefaults` 바로 아래:

```ts
  /**
   * 투영 설정. **admin 전용 라우트다** — admin 이 아니면 403 이고, 호출부는 그것을 오류로
   * 그리지 않는다(권한이 없는 것은 고장이 아니다).
   *
   * 실패를 여기서 삼키지 않는다 — 호출부가 "못 읽었다" 를 사람에게 보여야 한다.
   */
  projectionConfig(): Promise<ProjectionConfigView> {
    return this.req('GET', '/settings/projection');
  }

  /** 지우기는 **명시적 null** 이다 — 키를 빼면 `JSON.stringify` 가 버려 '손대지 않음'이 된다. */
  setProjectionConfig(url: string | null): Promise<ProjectionConfigView> {
    return this.req('PUT', '/settings/projection', { url });
  }
```

임포트에 `ProjectionConfigView` 를 더한다(파일 상단의 `@murmur/shared` 타입 임포트 블록).

`packages/desktop/src/state/controller.ts` — `updateAgentDefaults` 위임 바로 아래:

```ts
  /** 투영 설정. admin 전용이라 실패를 삼키지 않는다 — 화면이 실패를 그려야 한다. */
  projectionConfig(): Promise<import('@murmur/shared').ProjectionConfigView> {
    return this.api.projectionConfig();
  }

  setProjectionConfig(
    url: string | null,
  ): Promise<import('@murmur/shared').ProjectionConfigView> {
    return this.api.setProjectionConfig(url);
  }

  /**
   * 투영 상태를 **지금** 다시 읽는다. 저장 직후에 쓴다.
   *
   * 정기 갱신은 60 초 주기다(`projectionRefreshInterval`). 그 주기에 맡기면 방금 켠 투영이
   * 최대 1 분 동안 꺼진 것처럼 보이고 사용자는 저장이 실패했다고 읽는다.
   *
   * 화면이 `api.projectionStatus()` 를 직접 부르지 않는 이유: `refreshProjectionStatus` 가
   * 지키는 규칙(**실패를 삼키지 않고 `projectionStatusError` 로 올린다**)을 한 벌 더
   * 적게 된다.
   */
  refreshProjection(): Promise<void> {
    return this.refreshProjectionStatus();
  }
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd packages/desktop && npx vitest run test/projectionConfigApi.test.ts && npx tsc -p . --noEmit
```

Expected: 3 passed · 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add packages/desktop/src/lib/api.ts packages/desktop/src/state/controller.ts \
        packages/desktop/test/projectionConfigApi.test.ts
git commit -m "feat(desktop): 투영 설정을 부르는 창구를 낸다

지우기는 명시적 null 로 보낸다 — 키를 빼면 JSON.stringify 가 버려 '손대지 않음'이 된다.

refreshProjection 을 함께 낸다. 앱은 투영 상태를 60 초 주기로 갱신하는데, 저장 직후
그 주기에 맡기면 방금 켠 투영이 최대 1 분 동안 꺼진 것처럼 보이고 사용자는 저장이
실패했다고 읽는다. 화면이 api.projectionStatus() 를 직접 부르지 않는 이유는
refreshProjectionStatus 가 지키는 규칙(실패를 삼키지 않는다)을 한 벌 더 적지 않기
위해서다."
```

---

### Task 7: 데스크탑 — 출처·편집 줄

**Files:**
- Create: `packages/desktop/src/components/settings/ProjectionUrl.tsx`
- Modify: `packages/desktop/src/components/settings/ConnectionSettings.tsx` (`<ProjectionRow />` 바로 아래에 조립)
- Test: `packages/desktop/test/projectionUrlRow.test.tsx` (create)

**Interfaces:**
- Consumes: `Controller.projectionConfig`·`setProjectionConfig`·`refreshProjection` (Task 6), `ProjectionConfigView`·`ProjectionUrlSource` (Task 1), `Button`·`Field`·`TextInput` (`./primitives`)
- Produces: `ProjectionUrl` 컴포넌트 (기본 export 아님 — 이름 있는 export)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/desktop/test/projectionUrlRow.test.tsx`:

```tsx
/**
 * 투영 URL 을 앱에서 켜는 자리(설계 §6). `#537` 이 만든 상태 줄 바로 아래에 선다.
 *
 * 두 사실의 **출처가 다르다**: 상태 줄은 `/projection/status`(모든 로그인 사용자),
 * 이 줄은 `/settings/projection`(admin). 그래서 한 줄에 합치지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ProjectionConfigView } from '@murmur/shared';
import { useActiveStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ProjectionUrl } from '../src/components/settings/ProjectionUrl';
import { acc } from './helpers/fakeApi';

const view = (over: Partial<ProjectionConfigView> = {}): ProjectionConfigView => ({
  url: 'http://env.example:4000', source: 'env',
  appUrl: null, envUrl: 'http://env.example:4000', ...over,
});

let projectionConfig: ReturnType<typeof vi.fn>;
let setProjectionConfig: ReturnType<typeof vi.fn>;
let refreshProjection: ReturnType<typeof vi.fn>;

const mount = (opts: { isAdmin?: boolean; config?: ProjectionConfigView | Error } = {}) => {
  useActiveStore.getState().set({ me: acc('u1', 'admin', 'human', opts.isAdmin ?? true) });
  const c = opts.config ?? view();
  projectionConfig = vi.fn(c instanceof Error ? async () => { throw c; } : async () => c);
  setProjectionConfig = vi.fn(async (url: string | null) => view({
    url: url ?? 'http://env.example:4000', source: url ? 'app' : 'env', appUrl: url,
  }));
  refreshProjection = vi.fn(async () => { /* 저장 직후 상태 줄을 따라오게 한다 */ });
  setController({
    projectionConfig, setProjectionConfig, refreshProjection,
  } as unknown as Controller);
  return render(<ProjectionUrl />);
};

beforeEach(() => { localStorage.clear(); useActiveStore.getState().reset(); });
afterEach(() => cleanup());

describe('투영 URL 편집 줄', () => {
  /** 권한이 없는 것은 오류가 아니다. 403 을 붉게 그리면 잘못 없는 화면에 경고가 뜬다. */
  it('admin 이 아니면 아무것도 그리지 않고 조회도 하지 않는다', () => {
    const { container } = mount({ isAdmin: false });
    expect(container.firstChild).toBeNull();
    expect(projectionConfig).not.toHaveBeenCalled();
  });

  /** 정상과 고장이 같은 말이면 이 줄은 아무것도 알려 주지 않는다. */
  it('출처를 사정마다 다른 말로 적는다', async () => {
    mount({ config: view({ source: 'env' }) });
    expect((await screen.findByTestId('projection-source')).textContent).toContain('환경변수');

    cleanup();
    mount({ config: view({ source: 'app', appUrl: 'http://app.example:5000', url: 'http://app.example:5000' }) });
    expect((await screen.findByTestId('projection-source')).textContent).toContain('앱에서 설정');
  });

  it('못 읽으면 그렇게 말한다 — 빈 자리로 두지 않는다', async () => {
    mount({ config: new Error('boom') });
    expect((await screen.findByRole('alert')).textContent).toContain('불러오지 못했다');
  });

  it('저장하면 입력한 URL 로 부른다', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));
    fireEvent.change(screen.getByLabelText('avcs 주소'), {
      target: { value: 'http://app.example:5000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(setProjectionConfig).toHaveBeenCalledWith('http://app.example:5000'));
  });

  /**
   * **저장 직후 상태를 다시 읽는다.** 60 초 주기에 맡기면 방금 켠 투영이 최대 1 분 동안
   * 꺼진 것처럼 보이고 사용자는 저장이 실패했다고 읽는다.
   */
  it('저장 후 투영 상태를 다시 읽는다', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));
    fireEvent.change(screen.getByLabelText('avcs 주소'), { target: { value: 'http://app.example:5000' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(refreshProjection).toHaveBeenCalled());
  });

  /** 지우기는 빈 문자열이 아니라 null 이다 — 서버가 빈 문자열을 400 으로 거절한다. */
  it('지우기는 null 로 부른다', async () => {
    mount({ config: view({ source: 'app', appUrl: 'http://app.example:5000', url: 'http://app.example:5000' }) });

    fireEvent.click(await screen.findByRole('button', { name: '지우기' }));

    await waitFor(() => expect(setProjectionConfig).toHaveBeenCalledWith(null));
  });

  /** 앱 값이 없으면 지울 것이 없다. 누를 수 있게 두면 아무 일도 없는 버튼이 된다. */
  it('앱 값이 없으면 지우기를 그리지 않는다', async () => {
    mount({ config: view({ source: 'env', appUrl: null }) });
    await screen.findByTestId('projection-source');
    expect(screen.queryByRole('button', { name: '지우기' })).toBeNull();
  });

  it('저장이 실패하면 그렇게 말한다', async () => {
    mount();
    setProjectionConfig.mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(await screen.findByRole('button', { name: '편집' }));
    fireEvent.change(screen.getByLabelText('avcs 주소'), { target: { value: 'http://x.example' } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));

    expect((await screen.findByRole('alert')).textContent).toContain('저장하지 못했다');
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

```bash
cd packages/desktop && npx vitest run test/projectionUrlRow.test.tsx
```

Expected: FAIL — `Cannot find module '../src/components/settings/ProjectionUrl'`

- [ ] **Step 3: 구현**

`packages/desktop/src/components/settings/ProjectionUrl.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { ProjectionConfigView, ProjectionUrlSource } from '@murmur/shared';
import { getController } from '../../state/controller';
import { useActiveStore } from '../../state/communities';
import { Button, Field, TextInput } from './primitives';

/**
 * 출처를 **사정마다 다른 말**로 적는다. 같은 말이면 화면이 env 와 앱 설정을 구별하지
 * 못하고, "env 를 넣었는데 왜 안 먹나" 를 화면에서 알 수 없다.
 */
const SOURCE_LABEL: Record<ProjectionUrlSource, string> = {
  app: '앱에서 설정',
  env: '환경변수(AVCS_BASE_URL)',
};

/**
 * 투영이 바라볼 avcs 주소를 **앱에서** 정한다(`#537` 후속).
 *
 * ## 왜 상태 줄과 별 조각인가
 *
 * 위의 `ProjectionRow` 는 `/projection/status`(모든 로그인 사용자)를 읽어 "투영이 돌고
 * 있는가" 를 말한다. 이 줄은 `/settings/projection`(admin)을 읽어 "무엇을 바라볼 것인가" 를
 * 말한다. **두 사실의 출처가 다르므로** 한 줄에 합치지 않는다 — 합치면 한쪽 조회가
 * 실패했을 때 어느 사실을 못 읽은 것인지 화면이 말할 수 없다.
 *
 * ## 권한이 없는 것은 오류가 아니다
 *
 * admin 이 아니면 **아무것도 그리지 않고 조회도 하지 않는다.** 403 을 오류로 그리면 잘못
 * 없는 화면에 붉은 글이 뜬다(`AgentDefaultsSettings` 와 같은 규칙).
 */
export function ProjectionUrl() {
  const isAdmin = useActiveStore((s) => s.me?.isAdmin === true);
  // **세 상태다**: null(아직 안 읽음) / 'error'(못 읽음) / 값. 셋을 뭉개면 "불러오는 중" 과
  // "못 불러왔다" 가 같은 빈 자리가 된다.
  const [config, setConfig] = useState<ProjectionConfigView | 'error' | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    void getController().projectionConfig()
      .then((c) => { setConfig(c); setDraft(c.appUrl ?? c.envUrl ?? ''); })
      .catch(() => setConfig('error'));
  }, [isAdmin]);

  if (!isAdmin) return null;

  const commit = async (url: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await getController().setProjectionConfig(url);
      setConfig(next);
      setDraft(next.appUrl ?? next.envUrl ?? '');
      setEditing(false);
      // 상태 줄이 따라오게 한다. 정기 갱신은 60 초 주기라, 그것에 맡기면 방금 켠 투영이
      // 최대 1 분 동안 꺼진 것처럼 보이고 사용자는 저장이 실패했다고 읽는다.
      await getController().refreshProjection();
    } catch {
      setError('투영 URL 을 저장하지 못했다');
    } finally { setBusy(false); }
  };

  return (
    <div className="px-4 py-3">
      {config === null && <p className="text-xs text-fg-muted">투영 설정을 불러오는 중…</p>}
      {config === 'error' && (
        <p role="alert" className="text-xs text-danger">투영 설정을 불러오지 못했다</p>
      )}
      {config !== null && config !== 'error' && !editing && (
        <div className="flex items-center gap-3">
          <span data-testid="projection-source" className="min-w-0 flex-1 truncate text-xs text-fg-muted">
            {/* 출처가 없다는 것도 사정이다 — '아직 아무도 정하지 않았다'. */}
            {config.source === null
              ? '아직 정해지지 않았다'
              : `출처: ${SOURCE_LABEL[config.source]}`}
          </span>
          <Button disabled={busy} onClick={() => { setEditing(true); setError(null); }}>편집</Button>
          {/* 앱 값이 없으면 지울 것이 없다. 누를 수 있게 두면 아무 일도 없는 버튼이 된다. */}
          {config.appUrl !== null && (
            <Button variant="danger" disabled={busy} onClick={() => void commit(null)}>지우기</Button>
          )}
        </div>
      )}
      {config !== null && config !== 'error' && editing && (
        <div className="max-w-md space-y-2">
          <Field label="avcs 주소" hint={config.envUrl ? `지우면 ${config.envUrl} 로 돌아간다` : '지우면 투영이 꺼진다'}>
            <TextInput
              ariaLabel="avcs 주소"
              placeholder="http://avcs.example:4000"
              value={draft}
              disabled={busy}
              onChange={setDraft}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={busy} onClick={() => void commit(draft)}>저장</Button>
            <Button disabled={busy} onClick={() => { setEditing(false); setError(null); }}>취소</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[11px] text-danger">{error}</p>}
    </div>
  );
}
```

`packages/desktop/src/components/settings/ConnectionSettings.tsx` — 임포트를 더하고
`<ProjectionRow />` 바로 아래에 조립한다:

```tsx
import { ProjectionUrl } from './ProjectionUrl';
```

```tsx
        <ProjectionRow />
        {/* 무엇을 바라볼 것인가. admin 이 아니면 이 조각이 스스로 null 을 그린다. */}
        <ProjectionUrl />
```

- [ ] **Step 4: 통과를 확인한다**

```bash
cd packages/desktop && npx vitest run test/projectionUrlRow.test.tsx test/connectionSettings.test.tsx
```

Expected: 9 + 4 passed. `connectionSettings.test.tsx` 가 초록이어야 한다 —
`ProjectionUrl` 은 컨트롤러에 새 메서드를 요구하지만 admin 이 아니면 조회하지 않고,
그 파일의 `me` 는 설정되지 않으므로(`isAdmin` false) null 을 그린다.

- [ ] **Step 5: 스위트 전체와 타입 검사**

```bash
cd packages/desktop && npx vitest run && npx tsc -p . --noEmit
cd ../server && npx vitest run && npx tsc -p . --noEmit
cd ../shared && npx vitest run && npx tsc -p . --noEmit
```

Expected: 세 패키지 모두 전부 통과 · 타입 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add packages/desktop/src/components/settings/ProjectionUrl.tsx \
        packages/desktop/src/components/settings/ConnectionSettings.tsx \
        packages/desktop/test/projectionUrlRow.test.tsx
git commit -m "feat(desktop): 투영 URL 을 Connection 에서 정한다

상태 줄과 별 조각이다. 위의 ProjectionRow 는 /projection/status(모든 로그인 사용자)를
읽어 '투영이 돌고 있는가' 를, 이 줄은 /settings/projection(admin)을 읽어 '무엇을
바라볼 것인가' 를 말한다. 두 사실의 출처가 다르므로 합치지 않는다 — 합치면 한쪽 조회가
실패했을 때 어느 사실을 못 읽은 것인지 화면이 말할 수 없다.

admin 이 아니면 아무것도 그리지 않고 조회도 하지 않는다. 권한이 없는 것은 오류가
아니다(AgentDefaultsSettings 와 같은 규칙).

출처를 사정마다 다른 말로 적는다. 같은 말이면 env 와 앱 설정을 구별하지 못하고
'env 를 넣었는데 왜 안 먹나' 를 화면에서 알 수 없다.

앱 값이 없으면 지우기를 그리지 않는다 — 지울 것이 없는데 누를 수 있게 두면 아무 일도
없는 버튼이 된다."
```

---

## 마지막 확인 — 성공 기준 (설계 §9)

계획의 일곱 작업이 끝나면 **설치본으로** 확인한다. 이것이 이 작업이 진짜 끝났는지를
가르는 자리다 — 스위트가 초록인 것과 배포된 서버에서 켜지는 것은 다른 명제다.

- [ ] 서버를 새 판으로 배포한다 (`~/murmur-server`, `AVCS_BASE_URL` 없이)
- [ ] 설치본 앱 `설정 › Connection` 에서 `Projection` 행 아래 `편집` 을 눌러 avcs 주소를 넣고 저장
- [ ] 상태 줄이 `<repo> · 투영이 돌고 있다` 로 바뀐다 — **서버 재시작 없이**
- [ ] `지우기` 를 눌러 `투영이 설정되지 않았다` 로 돌아온다 (env 가 없으므로 꺼짐)
- [ ] 감사 로그에 `projection.url.updated` 두 건이 남았다
