# 러너 세션 코어 (Phase 1) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 러너를 "멘션마다 새 프로세스"에서 "스레드당 디스크 세션 + PTY 턴"으로 재구축한다 — 에이전트가 스레드를 기억하고, avcs workspace 로 격리되고, PAT 가 디스크에 남지 않는다.

**Architecture:** 세션 = `{avcs workspace dir, harness session-id, lastFedSeq}` 를 러너 로컬 파일에 두고, 멘션이 오면 node-pty 로 `resume` 턴을 띄운다. 에이전트가 murmur MCP 로 스스로 발화하고, 러너는 exit 후 "발화했나"만 검사한다. 서버 변경은 마이그레이션 1개와 라우트 필드다.

**Tech Stack:** Node 22 / TypeScript ESM / vitest / node-pty / Fastify + Postgres (서버) / zod

**Spec:** `docs/specs/2026-09-01-runner-sessions-pty-design.md` (§ 번호는 전부 이 문서)

## Global Constraints

- ESM — 상대 import 는 `.js` 확장자 필수 (`import { x } from './y.js'`)
- 주석·에러 메시지는 한국어, 이 레포의 기존 문체(왜를 적는다)
- 커밋 메시지: `type(scope): 요지` — 기존 로그 참조
- `pnpm --filter @murmur/agent test` / `--filter @murmur/server test` (서버는 Docker 필요)
- 커밋 시 avcs 훅의 "no AVCS repo … skipping" 로그는 무해 — 무시한다
- **구현 전 게이트는 이미 통과** (spec 승인). Phase 2(관찰·개입)는 이 계획에 없다 — Phase 1 착지 후 별도 계획
- 하네스 영구 설정을 바꾸는 플래그·명령 금지 (spec §6)

---

### Task 1: 검증 스파이크 (spec §13.1–3) — 코드보다 먼저

**Files:**
- Modify: `docs/plans/2026-09-01-runner-sessions-phase1.md` (이 파일 하단 "스파이크 결과" 절에 기록)

**Interfaces:**
- Produces: Task 6 의 플래그 표 상수를 확정하는 실측값

- [ ] **Step 1: claude 비대화형 resume 조합 확인**

```bash
cd $(mktemp -d)
SID=$(uuidgen | tr A-Z a-z)
claude -p --session-id $SID --model haiku "hello 라고만 답해"
claude -p -r $SID --model haiku "방금 내가 뭐라고 했지?"   # 첫 턴을 기억해야 성공
```

Expected: 두 번째 응답이 "hello" 요청을 안다. 실패 시 `-r` 대신 `--resume` 표기, 또는 cwd 의존성(세션이 프로젝트 디렉터리에 귀속)을 기록 — **cwd 를 바꾸면 resume 이 되는지도 반드시 확인** (세션이 cwd 별 저장이면 workspace 디렉터리 고정이 전제가 된다).

- [ ] **Step 2: 인터랙티브 PTY + MCP env 확장 확인**

```bash
# murmur 로컬 스택 기동 후 (docker compose up -d + 서버), PAT 발급해 두고:
cat > /tmp/murmur-mcp.json <<'EOF'
{"mcpServers":{"murmur":{"type":"http","url":"http://localhost:3400/mcp","headers":{"Authorization":"Bearer ${MURMUR_PAT}"}}}}
EOF
MURMUR_PAT=murp_... claude --mcp-config /tmp/murmur-mcp.json
# 세션 안에서: /mcp 로 murmur 서버가 connected 인지 확인
```

Expected: murmur MCP connected. (print 모드는 이미 실측 완료 — 인터랙티브가 남았다)

- [ ] **Step 3: codex 표면 확인**

```bash
codex exec --help | head -30          # exec 에 resume 이 있는가, 없으면 대안 기록
codex mcp --help                       # murmur MCP 등록 형식
tail -1 ~/.codex/session_index.jsonl | python3 -m json.tool   # 스키마: id·cwd·시각 필드명
codex --help | grep -i "instructions\|system"   # 지시문 주입구
```

Expected: 각 항목의 실값을 기록. codex 에 지시문 주입구가 없으면 → 지시문을 프롬프트 앞에 접두(구분 태그 포함)하는 대안을 기록.

- [ ] **Step 4: gemini 표면 확인**

```bash
gemini --help | grep -iA2 "approval\|yolo\|prompt\b"   # 비대화형 플래그·권한 플래그
SID=$(uuidgen); gemini --session-id $SID -p "hello 라고만 답해" 2>&1 | tail -3
gemini -r "$SID" -p "방금 내가 뭐라고 했지?" 2>&1 | tail -3   # -r 이 uuid 를 받는지 (help 는 index 예시)
```

Expected: gemini 의 resume 인자 형식(uuid 직접 수용 여부)과 권한 플래그를 기록.

- [ ] **Step 5: `avcs workspace land` 의 미추적 파일 처리 확인 (§13.4)**

```bash
cd ~/dev/my-workspace/avcs && avcs workspace project spike-test --out /tmp/ws-spike
touch /tmp/ws-spike/untracked-note.md
avcs workspace land spike-test 2>&1 | tail -5   # 미추적 파일이 오브젝트로 들어가는지 관찰
```

Expected: land 가 미추적 파일을 무시하면 S3 물질화 위치 제약이 풀린다 — 결과만 기록(이번 Phase 는 영향 없음).

- [ ] **Step 6: 결과를 이 파일 하단 "스파이크 결과" 절에 기록하고 커밋**

```bash
git add docs/plans/2026-09-01-runner-sessions-phase1.md
git commit -m "docs(plan): 러너 세션 스파이크 실측 결과"
```

**중요:** Step 1~4 의 실측이 Task 6 의 표와 다르면 **표를 실측에 맞춘다** (표가 진실이 아니라 실측이 진실이다).

---

### Task 2: 서버 — 마이그레이션 008 + 타입 + 서비스 + 라우트

**Files:**
- Create: `packages/server/src/db/migrations/008_agent_runner.sql`
- Modify: `packages/shared/src/index.ts` (AGENT_HARNESSES, AgentConfig, AgentView)
- Modify: `packages/server/src/services/agents.ts` (COLS, upsertConfig, createAgentAccount)
- Modify: `packages/server/src/routes/accountRoutes.ts:20-26` (configFields), `:32-44` (POST), `:46-57` (PATCH)
- Test: `packages/server/test/agentConfig.test.ts` (기존 파일에 추가)

**Interfaces:**
- Produces: `AgentConfig.mentionPermission: MentionPermission` · `AgentView.ownerAccountId: string | null` · `MENTION_PERMISSIONS` — Task 6·9·10 이 소비
- Produces: `createAgentAccount(pool, input, ownerId: string)` — 세 번째 인자 신설

- [ ] **Step 1: 실패하는 테스트 추가**

`packages/server/test/agentConfig.test.ts` 에 (기존 픽스처의 admin 토큰·에이전트 생성 헬퍼 패턴을 그대로 따른다):

```ts
it('에이전트 생성 시 mentionPermission 기본 auto, 생성자가 owner 가 된다', async () => {
  const res = await app.inject({
    method: 'POST', url: '/accounts/agents',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { handle: 'permtest', displayName: 'P' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.mentionPermission).toBe('auto');
  expect(body.ownerAccountId).toBe(adminId);   // 픽스처의 admin 계정 id
});

it('mentionPermission 은 auto|readonly 만 받는다', async () => {
  const agent = await createTestAgent();        // 기존 헬퍼
  const bad = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${agent.id}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { mentionPermission: 'bypassAll' },
  });
  expect(bad.statusCode).toBe(400);
  const ok = await app.inject({
    method: 'PATCH', url: `/accounts/agents/${agent.id}`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { mentionPermission: 'readonly' },
  });
  expect(ok.json().mentionPermission).toBe('readonly');
});

it('GET /agent/config 가 mentionPermission 을 싣는다', async () => {
  const agent = await createTestAgent();
  const pat = await issuePat(agent.id);          // 기존 헬퍼 (agentConfig.test.ts 상단 참조)
  const res = await app.inject({
    method: 'GET', url: '/agent/config',
    headers: { authorization: `Bearer ${pat}` },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().mentionPermission).toBe('auto');
});
```

- [ ] **Step 2: 실패 확인** — `pnpm --filter @murmur/server test -- agentConfig` → FAIL (컬럼·필드 없음)

- [ ] **Step 3: 구현**

`008_agent_runner.sql`:

```sql
-- 러너 재구축(Phase 1). 두 컬럼 다 '멘션 턴'의 사실이다:
-- mention_permission 은 화면 앞에 사람이 없는 턴의 권한 정책(사람 턴은 하네스가 묻는다),
-- owner_account_id 는 러너를 소유한 사람 — Phase 2 의 attach 권한 판정이 이 컬럼을 본다.
-- 값 검증은 애플리케이션(004 의 harness 판례). 기존 행 backfill 없음 — 추측 소유자는 소유자가 아니다.
alter table agent_config
  add column mention_permission text not null default 'auto',
  add column owner_account_id uuid references account(id) on delete set null;
```

`packages/shared/src/index.ts`:

```ts
export const AGENT_HARNESSES = ['claude-code', 'codex', 'gemini'] as const;

/** 멘션 턴(화면 앞에 사람이 없다)의 권한. 사람 인터랙티브 턴은 하네스가 직접 묻는다. */
export const MENTION_PERMISSIONS = ['auto', 'readonly'] as const;
export type MentionPermission = (typeof MENTION_PERMISSIONS)[number];

export interface AgentConfig {
  instructions: string;
  harness: AgentHarness;
  model: string | null;
  effort: string | null;
  workingDir: string | null;
  mentionPermission: MentionPermission;
}

export interface AgentView extends AccountView, AgentConfig {
  /** 러너 소유자. null 이면 attach 표면이 아무에게도 안 뜬다. */
  ownerAccountId: string | null;
}
```

`services/agents.ts` — `COLS` 에 두 줄 추가:

```ts
  coalesce(c.mention_permission, 'auto') as "mentionPermission",
  c.owner_account_id as "ownerAccountId"
```

`upsertConfig` 의 insert/update 에 같은 패턴으로 `mention_permission`($12,$13)·`owner_account_id`($14,$15) 쌍을 추가한다(기존 "키 부재 = 손대지 않음" 규약 유지). `createAgentAccount(pool, input, ownerId: string)` 은 `upsertConfig(client, id, {...input, ownerAccountId: ownerId})` 로 소유자를 심는다.

`accountRoutes.ts` — `configFields` 에:

```ts
    mentionPermission: z.enum(MENTION_PERMISSIONS).optional(),
    ownerAccountId: z.string().uuid().nullable().optional(),
```

POST 핸들러는 `createAgentAccount(pool, body, req.account!.id)` 로 변경.

- [ ] **Step 4: 통과 확인** — `pnpm --filter @murmur/server test -- agentConfig` → PASS, 이어서 서버 스위트 전체
- [ ] **Step 5: 커밋** — `feat(server): 멘션 턴 권한 정책과 러너 소유자 — agent_config 확장`

---

### Task 3: 러너 — SessionStore (디스크 세션 상태)

**Files:**
- Create: `packages/agent/src/sessions.ts`
- Test: `packages/agent/test/sessions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface SessionRecord {
    workspaceDir: string;
    sessionId: string | null;   // codex 는 첫 턴 후 발견될 때까지 null
    harness: AgentHarness;
    lastFedSeq: number;         // 이 세션에 마지막으로 넘긴 스레드 seq (spec §4)
  }
  class SessionStore {
    constructor(filePath: string);
    static threadKey(channelId: string, threadRootId: string | null): string; // `${channelId}/${threadRootId ?? '_root'}`
    load(): Promise<void>;                       // 파일 없으면 빈 맵 (오류 아님)
    get(key: string): SessionRecord | undefined;
    put(key: string, rec: SessionRecord): Promise<void>;  // 원자적 쓰기 (tmp + rename)
  }
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';

describe('SessionStore', () => {
  const rec = { workspaceDir: '/w', sessionId: 'abc', harness: 'claude-code' as const, lastFedSeq: 7 };

  it('threadKey 는 채널 최상위를 _root 로 구분한다', () => {
    expect(SessionStore.threadKey('ch1', null)).toBe('ch1/_root');
    expect(SessionStore.threadKey('ch1', 'm9')).toBe('ch1/m9');
  });

  it('put 한 것을 새 인스턴스의 load 가 읽는다 — 러너 재시작 무손실 (spec §1)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    const a = new SessionStore(file);
    await a.load();
    await a.put('ch1/m9', rec);
    const b = new SessionStore(file);
    await b.load();
    expect(b.get('ch1/m9')).toEqual(rec);
  });

  it('파일이 없으면 빈 상태로 시작한다', async () => {
    const s = new SessionStore(join(await mkdtemp(join(tmpdir(), 'sess-')), 'none.json'));
    await s.load();
    expect(s.get('x/_root')).toBeUndefined();
  });

  it('깨진 파일은 빈 상태 + 백업으로 시작한다 — 세션을 잃어도 죽지는 않는다', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    await (await import('node:fs/promises')).writeFile(file, '{broken');
    const s = new SessionStore(file);
    await s.load();                        // throw 하지 않는다
    expect(s.get('x/_root')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 실패 확인** — `pnpm --filter @murmur/agent test -- sessions` → FAIL
- [ ] **Step 3: 구현** — `writeFile(tmp) → rename` 원자 쓰기, load 는 파싱 실패 시 `<file>.broken-<ts>` 로 옮기고 빈 맵(경고 로그). 파일 mode 0o600(세션 id 는 비밀은 아니나 좁게).
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(agent): 스레드당 세션을 디스크에 — 러너 재시작이 기억을 잃지 않는다`

---

### Task 4: 러너 — avcs workspace 확보

**Files:**
- Create: `packages/agent/src/workspace.ts`
- Test: `packages/agent/test/workspace.test.ts`

**Interfaces:**
- Consumes: 없음 (exec 주입)
- Produces:
  ```ts
  function workspaceName(handle: string, threadKey: string): string;
  // murmur-<handle>-<threadKey 의 sha256 앞 8자> — 에이전트당 격리 (spec §3 ①)
  type Exec = (cmd: string, args: string[], opts: { cwd: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
  function ensureWorkspace(exec: Exec, opts: {
    handle: string; threadKey: string; baseDir: string; repoDir: string;
  }): Promise<string>;  // 반환: workspace 디렉터리 절대경로. 이미 있으면 project 를 다시 부르지 않는다
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it } from 'vitest';
import { workspaceName, ensureWorkspace } from '../src/workspace.js';

describe('workspaceName', () => {
  it('같은 스레드라도 에이전트가 다르면 이름이 다르다 (spec §3 다중 에이전트)', () => {
    const a = workspaceName('forge', 'ch1/m9');
    const b = workspaceName('scout', 'ch1/m9');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^murmur-forge-[0-9a-f]{8}$/);
  });
});

describe('ensureWorkspace', () => {
  it('디렉터리가 없으면 avcs workspace project 를 부른다', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; };
    const dir = await ensureWorkspace(exec, { handle: 'forge', threadKey: 'ch1/m9', baseDir: '/tmp/nonexistent-base', repoDir: '/repo' });
    expect(calls[0]![0]).toBe('avcs');
    expect(calls[0]).toContain('project');
    expect(dir).toContain('murmur-forge-');
  });

  it('avcs repo 가 아니면 격리 없이 repoDir 로 폴백한다 — 채팅 전용 에이전트가 죽으면 안 된다', async () => {
    const exec = async () => ({ code: 1, stdout: '', stderr: 'error: not an AVCS repo: /repo (run `avcs init`)' });
    const dir = await ensureWorkspace(exec, { handle: 'forge', threadKey: 'k', baseDir: '/tmp/x', repoDir: '/repo' });
    expect(dir).toBe('/repo');   // 기능 후퇴(격리 없음)이지 정지가 아니다 — spec §8 의 판단과 같다
  });

  it('그 외 project 실패는 stderr 를 담아 던진다 — 조용한 실패 금지', async () => {
    const exec = async () => ({ code: 1, stdout: '', stderr: 'lease conflict' });
    await expect(ensureWorkspace(exec, { handle: 'forge', threadKey: 'k', baseDir: '/tmp/x', repoDir: '/repo' }))
      .rejects.toThrow(/lease conflict/);
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — `avcs workspace project <name> --out <baseDir>/<name>` 를 `repoDir` cwd 로 실행. 디렉터리가 이미 존재하면(= 이전 턴이 만들었다) exec 없이 그 경로 반환. stderr 가 `not an AVCS repo` 패턴이면 **repoDir 자체를 반환**(격리 없는 폴백 — 경고 로그 1회). `baseDir` 기본은 `~/.murmur-agent/<handle>/workspaces` (호출부가 준다).
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(agent): 스레드 격리를 avcs workspace 로 — git worktree 가 아니다`

---

### Task 5: 러너 — 프롬프트 조립과 발화 판정 (reply.ts 대체)

**Files:**
- Create: `packages/agent/src/prompt.ts`
- Test: `packages/agent/test/prompt.test.ts`
- 참고: `packages/agent/src/reply.ts` 는 Task 9 에서 삭제 (테스트도 이 파일이 대체)

**Interfaces:**
- Consumes: `MessageRow`(shared), `BODY_LIMIT = 8000` (reply.ts 에서 이사)
- Produces:
  ```ts
  const BODY_LIMIT = 8000;
  function buildSystemPrompt(opts: { handle: string; channelName: string; instructions: string; guide: string }): string;
  // 정체 + UI 지시문 + workspace.guide + "BODY_LIMIT·모르면 모른다" 규칙. 매 턴 --append-system-prompt 로 간다.
  function buildTurnPrompt(opts: {
    messages: MessageRow[];   // 스레드 seq 오름차순 전체
    lastFedSeq: number;       // 0 이면 첫 턴 = 전체를 넘긴다
    meId: string;
    handles: Record<string, string>;
  }): { prompt: string; fedSeq: number };
  // seq > lastFedSeq 인 것만. 자기 발화는 건너뛴다(세션이 이미 안다) — 단 첫 턴(lastFedSeq 0)은 포함(세션 이전 역사).
  // fedSeq = 이번에 본 최대 seq. 넘길 게 없으면 prompt '' (호출부가 스킵 판단).
  function hasOwnPostSince(messages: MessageRow[], meId: string, sinceSeq: number): boolean;
  // exit 후 "답을 올렸나" 판정 (spec §4 발화 경로)
  const NO_REPLY_NOTICE: string; // '(답 없이 턴을 끝냈습니다 — 프로세스는 정상 종료, 발화 없음)'
  ```

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildTurnPrompt, hasOwnPostSince } from '../src/prompt.js';

const msg = (seq: number, authorId: string, body: string) =>
  ({ seq, authorId, body, id: `m${seq}`, channelId: 'c', threadRootId: null, kind: 'user',
     meta: {}, createdAt: '', editedAt: null, reactions: [], attachments: [] }) as never;

describe('buildTurnPrompt', () => {
  const handles = { u1: 'jaebin', a1: 'forge', a2: 'scout' };

  it('첫 턴(lastFedSeq 0)은 자기 발화 포함 전체를 넘긴다', () => {
    const r = buildTurnPrompt({ messages: [msg(1, 'u1', '안녕'), msg(2, 'a1', '넵')], lastFedSeq: 0, meId: 'a1', handles });
    expect(r.prompt).toContain('jaebin: 안녕');
    expect(r.prompt).toContain('forge: 넵');   // 세션 이전 역사는 자기 것도 알려준다
    expect(r.fedSeq).toBe(2);
  });

  it('resume 턴은 경계 이후만, 자기 발화는 뺀다 — 세션이 이미 아는 말', () => {
    const r = buildTurnPrompt({
      messages: [msg(1, 'u1', '옛말'), msg(2, 'a1', '내 답'), msg(3, 'a2', '동료가 한 일'), msg(4, 'u1', '@forge 이어서')],
      lastFedSeq: 1, meId: 'a1', handles,
    });
    expect(r.prompt).not.toContain('옛말');
    expect(r.prompt).not.toContain('내 답');
    expect(r.prompt).toContain('scout: 동료가 한 일');  // 다중 에이전트 협업의 핵심 (spec §4)
    expect(r.fedSeq).toBe(4);
  });

  it('넘길 게 없으면 빈 prompt', () => {
    const r = buildTurnPrompt({ messages: [msg(2, 'a1', '내 답')], lastFedSeq: 1, meId: 'a1', handles });
    expect(r.prompt).toBe('');
    expect(r.fedSeq).toBe(2);
  });
});

describe('hasOwnPostSince', () => {
  it('턴 시작 이후의 자기 발화만 인정한다', () => {
    const ms = [msg(5, 'a1', '옛 답'), msg(9, 'u1', '질문'), msg(10, 'a1', '새 답')];
    expect(hasOwnPostSince(ms, 'a1', 9)).toBe(true);
    expect(hasOwnPostSince(ms, 'a1', 10)).toBe(false);
  });
});

describe('buildSystemPrompt', () => {
  it('지시문과 guide 를 싣고 8000자 규칙을 명시한다', () => {
    const s = buildSystemPrompt({ handle: 'forge', channelName: 'dev', instructions: '친절하게', guide: 'G규칙' });
    expect(s).toContain('@forge');
    expect(s).toContain('친절하게');
    expect(s).toContain('G규칙');
    expect(s).toMatch(/8000/);
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — 기존 `reply.ts` 의 문구(정체·"모르는 것은 모른다"·BODY_LIMIT)를 계승하되, 시스템 프롬프트에 "답변은 murmur MCP `message.post` 로 이 스레드에 남겨라(channelId·threadRootId 는 프롬프트 머리에 준다)" 지시를 추가한다 — 발화가 자율이 됐으므로 **어디에 쓸지**를 알려줘야 한다.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(agent): 델타 프롬프트와 발화 판정 — 동료 에이전트의 발화가 다음 턴에 들어간다`

---

### Task 6: 러너 — 턴 커맨드 표와 MCP 설정 파일

**Files:**
- Create: `packages/agent/src/turn.ts`
- Modify: `packages/agent/src/harness/claudeCode.ts` → 삭제는 Task 9 에서 (mcpConfigFor 대체를 여기서 만든다)
- Test: `packages/agent/test/turn.test.ts`

**Interfaces:**
- Consumes: `AgentHarness`·`MentionPermission`(shared), Task 1 스파이크 실측값
- Produces:
  ```ts
  type TurnMode = 'mention' | 'interactive';
  interface TurnPlan { command: string; args: string[]; env: Record<string, string>; }
  function buildTurnCommand(opts: {
    harness: AgentHarness; mode: TurnMode;
    sessionId: string | null;          // null = 첫 턴인데 id 사전할당 불가(codex)
    isFirstTurn: boolean;
    systemPrompt: string; promptCtx: string;   // mention 모드 전용
    model: string | null; effort: string | null;
    mentionPermission: MentionPermission;
    mcpConfigPath: string; pat: string;
  }): TurnPlan;
  function writeMcpConfigOnce(dir: string, murmurUrl: string): Promise<string>;
  // murmur(http, Authorization: Bearer ${MURMUR_PAT}) + avcs(stdio, command 'avcs', args ['mcp'])
  // 둘만 담은 설정 파일. ${MURMUR_PAT} 는 플레이스홀더이므로 파일 자체는 비밀이 아니고
  // 지우지 않아도 된다 (spec §7).
  ```

`buildTurnCommand` 는 claude 에 **항상 `--strict-mcp-config` 를 함께 넘긴다**. 없으면
하네스가 운영자의 전역 MCP 목록(실측: Slack·Gmail·Drive·avcshub·buddy)을 상속해,
채널에서 에이전트를 부를 수 있는 사람이 운영자 개인 계정에 도달한다 (spec §7).

- [ ] **Step 1: 실패하는 테스트**

```ts
import { describe, expect, it } from 'vitest';
import { buildTurnCommand } from '../src/turn.js';

const base = {
  systemPrompt: 'SYS', promptCtx: 'CTX', model: null, effort: null,
  mentionPermission: 'auto' as const, mcpConfigPath: '/mcp.json', pat: 'murp_x',
};

describe('buildTurnCommand — claude', () => {
  it('첫 멘션 턴: session-id 할당 + bypassPermissions + PAT 는 env 로만', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: true });
    expect(p.command).toBe('claude');
    expect(p.args).toEqual(expect.arrayContaining(['-p', '--session-id', 'uuid-1', '--permission-mode', 'bypassPermissions', '--mcp-config', '/mcp.json', '--append-system-prompt', 'SYS', 'CTX']));
    expect(p.args).not.toContain('-r');
    expect(p.env.MURMUR_PAT).toBe('murp_x');
    expect(p.args.join(' ')).not.toContain('murp_x');   // argv 에 PAT 금지 (spec §7)
  });

  it('resume 멘션 턴: -r <id>, readonly 는 plan 모드', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 'uuid-1', isFirstTurn: false, mentionPermission: 'readonly' });
    expect(p.args).toEqual(expect.arrayContaining(['-r', 'uuid-1', '--permission-mode', 'plan']));
    expect(p.args).not.toContain('--session-id');
  });

  it('인터랙티브 턴: -p 없음, 권한 플래그 없음 — 사람이 답한다 (spec §6)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'interactive', sessionId: 'uuid-1', isFirstTurn: false });
    expect(p.args).not.toContain('-p');
    expect(p.args).not.toContain('--permission-mode');
    expect(p.args).toEqual(expect.arrayContaining(['-r', 'uuid-1']));
  });

  it('영구 설정을 바꾸는 플래그가 절대 없다 (spec §6)', () => {
    const p = buildTurnCommand({ ...base, harness: 'claude-code', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args).not.toContain('--dangerously-skip-permissions');
  });
});

describe('buildTurnCommand — codex', () => {
  it('첫 턴은 sessionId 없이도 조립된다 — codex 는 id 를 사전 할당할 수 없다', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: null, isFirstTurn: true });
    expect(p.command).toBe('codex');
    expect(p.args[0]).toBe('exec');
    expect(p.args).not.toContain('resume');
  });

  it('resume 턴은 exec resume <id>', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 'sid-9', isFirstTurn: false });
    expect(p.args.slice(0, 3)).toEqual(['exec', 'resume', 'sid-9']);
  });

  it('권한은 sandbox 단독이다 — codex exec 에 -a 는 없다 (실측)', () => {
    const auto = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(auto.args).toEqual(expect.arrayContaining(['-s', 'workspace-write']));
    expect(auto.args).not.toContain('-a');
    expect(auto.args).not.toContain('danger-full-access');
    const ro = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false, mentionPermission: 'readonly' });
    expect(ro.args).toEqual(expect.arrayContaining(['-s', 'read-only']));
  });

  it('MCP 는 턴별 -c 오버라이드다 — codex mcp add 는 config.toml 을 영구 변경한다 (spec §6)', () => {
    const p = buildTurnCommand({ ...base, harness: 'codex', mode: 'mention', sessionId: 's', isFirstTurn: false });
    expect(p.args.join(' ')).toContain('-c mcp_servers.');
    expect(p.args).not.toContain('mcp');           // `codex mcp add` 경로로 새지 않는다
    expect(p.args.join(' ')).not.toContain('murp_'); // PAT 는 env 로만
  });
});

describe('buildTurnCommand — gemini', () => {
  it('미지원을 명확한 에러로 거절한다 — -r 이 uuid 를 받지 않는다 (실측)', () => {
    expect(() => buildTurnCommand({ ...base, harness: 'gemini', mode: 'mention', sessionId: 's', isFirstTurn: false }))
      .toThrow(/gemini/);
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — harness 별 분기가 아니라 **표 상수** (`PRESETS: Record<AgentHarness, …>`) 로 두고
  buildTurnCommand 는 표를 조립만 한다. 값은 spec §4 의 확정 표를 그대로 옮긴다(그 표는 실측으로
  확정됐다). gemini 는 표에 `unsupported` 로 두고 조립 시 거절한다 — `RUNNABLE_HARNESSES`(Task 2 에서
  생김)에 없는 harness 가 여기 도달하면 그것이 곧 결함이므로, 던지는 에러 메시지에 harness 이름과
  "러너가 아직 지원하지 않는다"를 함께 담는다.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(agent): 하네스 플래그 표 — 어댑터가 아니라 표다`

---

### Task 7: 러너 — PTY 실행기

**Files:**
- Create: `packages/agent/src/pty.ts`
- Create: `packages/agent/test/helpers/fake-harness.mjs`
- Test: `packages/agent/test/pty.test.ts`
- Modify: `packages/agent/package.json` (dependencies + `node-pty`)

**Interfaces:**
- Consumes: `TurnPlan`(Task 6)
- Produces:
  ```ts
  class RingBuffer { constructor(capBytes: number); push(data: Buffer): void; snapshot(): Buffer; }
  interface TurnResult { exitCode: number; timedOut: boolean; tail: string; }  // tail = ring buffer 끝 2KB (로그용)
  function runPtyTurn(plan: TurnPlan, opts: {
    cwd: string; timeoutMs: number; ring?: RingBuffer;   // Phase 2 가 onData 로 확장한다
  }): Promise<TurnResult>;
  ```

- [ ] **Step 1: node-pty 설치** — `pnpm --filter @murmur/agent add node-pty`

`node-pty@1.1.0` 의 install 스크립트는 `node scripts/prebuild.js || node-gyp rebuild` 다. 이
머신(macOS arm64, Node 22, Python 3.12, Xcode)에는 폴백 툴체인이 다 있어 로컬 설치는 통과할
것으로 본다. **위험은 로컬이 아니라 CI 다** — `.github/workflows` 는 `ubuntu-latest` + Node 22 라
로컬(darwin-arm64)과 **다른 바이너리**가 필요하고, 프리빌드가 그 조합에 없으면 CI 의
`pnpm install` 이 통째로 깨진다. 이 레포는 PR·main 푸시에 CI 게이트가 있으므로 로컬 초록이
증거가 되지 않는다.

그래서 이 단계는 설치로 끝내지 말고 **linux/x64 프리빌드 존재를 확인**해라
(`npm view node-pty dist.tarball` 로 받아 열어 보거나, 설치 로그에서 prebuild 다운로드가
성공했는지 vs `node-gyp rebuild` 로 떨어졌는지를 본다). 어느 쪽이든 리포트에 적어라.
프리빌드가 없어 CI 가 `node-gyp` 를 타야 한다면 `ubuntu-latest` 에 build-essential/python 이
있는지가 다음 질문이고, 없으면 워크플로에 설치 단계가 필요하다 — 그 판단은 Task 11 이
전체 CI 를 돌릴 때가 아니라 **여기서** 내려야 한다. 여기서 놓치면 Phase 1 전체가 머지 직전에
막힌다.

- [ ] **Step 2: 가짜 하네스 작성** — `test/helpers/fake-harness.mjs`:

```js
// PTY 계약 테스트용 가짜 하네스. 시나리오는 env FAKE_MODE 로 고른다 —
// 인자 파싱을 흉내내지 않는다(그건 turn.ts 의 몫이고 여기선 프로세스 행동만 필요하다).
const mode = process.env.FAKE_MODE ?? 'ok';
if (mode === 'ok')      { console.log('done'); process.exit(0); }
if (mode === 'fail')    { console.error('boom'); process.exit(3); }
if (mode === 'hang')    { setInterval(() => {}, 1_000); }            // 타임아웃 검증용
if (mode === 'chatty')  { for (let i = 0; i < 10_000; i++) console.log(`line ${i}`); process.exit(0); }
```

- [ ] **Step 3: 실패하는 테스트**

```ts
import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RingBuffer, runPtyTurn } from '../src/pty.js';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'helpers/fake-harness.mjs');
const plan = (mode: string) => ({ command: process.execPath, args: [fake], env: { ...process.env, FAKE_MODE: mode } as Record<string, string> });

describe('runPtyTurn', () => {
  it('정상 종료: exitCode 0, 출력이 ring 에 남는다', async () => {
    const ring = new RingBuffer(256 * 1024);
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    expect(r.exitCode).toBe(0);
    expect(ring.snapshot().toString()).toContain('done');
  });

  it('비정상 종료: exitCode 전달', async () => {
    const r = await runPtyTurn(plan('fail'), { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.exitCode).toBe(3);
  });

  it('타임아웃: SIGTERM → 안 죽으면 SIGKILL, timedOut 표시 (spec §4)', async () => {
    const r = await runPtyTurn(plan('hang'), { cwd: process.cwd(), timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
  }, 15_000);
});

describe('RingBuffer', () => {
  it('용량을 넘으면 앞이 잘린다', () => {
    const ring = new RingBuffer(8);
    ring.push(Buffer.from('12345'));
    ring.push(Buffer.from('67890'));
    expect(ring.snapshot().toString()).toBe('34567890');
  });
});
```

- [ ] **Step 4: 실패 확인** → FAIL
- [ ] **Step 5: 구현** — `node-pty.spawn(plan.command, plan.args, {cwd, env: plan.env, cols: 120, rows: 40})`. 타임아웃: SIGTERM 후 5초 내 exit 없으면 kill. exit 리스너에서 반드시 dispose(좀비 방지, spec §10 축소판).
- [ ] **Step 6: 통과 확인**
- [ ] **Step 7: 커밋** — `feat(agent): PTY 턴 실행기 — 프로세스 종료가 곧 턴 종료다`

---

### Task 8: 러너 — codex 세션 id 발견

**Files:**
- Create: `packages/agent/src/codexSessions.ts`
- Test: `packages/agent/test/codexSessions.test.ts` (rollout 파일 트리를 tmpdir 에 만들어 픽스처로)

**Interfaces:**
- Produces: `findCodexSessionId(sessionsDir: string, opts: { cwd: string; sinceMs: number }): Promise<string | null>`
  — `<sessionsDir>/**/rollout-*.jsonl` 을 mtime 역순으로 훑어, 첫 줄의 `session_meta.cwd` 가
  `cwd` 와 일치하고 mtime 이 `sinceMs` 이후인 파일의 세션 id 를 돌려준다. 없으면 null
  (기능 후퇴이지 정지가 아니다, spec §8). 기본 `sessionsDir` 은 `~/.codex/sessions`.

**이 인터페이스는 스파이크가 초판을 무너뜨려 다시 쓴 것이다.** 초판은
`findCodexSessionId(indexJsonl, …)` 로 `~/.codex/session_index.jsonl` 을 cwd 매칭하려 했는데,
실측 결과 그 파일에는 **cwd 필드가 없고** `codex exec` 세션은 **거기 기록되지도 않는다**.
대안이 둘이었다 — rollout 파일 glob 과 `codex exec --json` 의 stdout 파싱. 후자가 id 를
공짜로 주지만 그 턴의 화면이 JSON 스트림이 되어 **codex 턴만 사람이 attach 할 수 없게**
된다(spec 부록 A 가 ACP 를 기각한 이유가 한 harness 에서만 재현). rollout 파일에
`session_meta.cwd` 가 있다는 것을 실측으로 확인해 glob 으로 확정했다. 스레드마다 avcs
workspace 가 고유 디렉터리이므로 cwd 가 정확한 키다.

- [ ] **Step 1: 실패하는 테스트** — tmpdir 에 `a/rollout-1.jsonl`(다른 cwd)과
  `b/rollout-2.jsonl`(대상 cwd) 두 개를 만들고 각 첫 줄에
  `{"type":"session_meta","payload":{"id":"<uuid>","cwd":"<dir>"}}` 형태를 쓴다(정확한 키
  경로는 계획 하단 "스파이크 결과" 절의 실측 기록을 따른다). 검증: 대상 cwd 의 id 만 잡힌다 /
  `sinceMs` 보다 오래된 파일은 무시된다 / 빈 디렉터리면 null / 깨진 첫 줄은 건너뛰고 다음
  파일로 간다(하나의 손상 파일이 발견 전체를 죽이지 않는다).
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과** → **Step 5: 커밋** — `feat(agent): codex 세션 발견 — 사전 할당이 없는 하네스의 사후 추적`

---

### Task 9: 러너 — main.ts 재배선 (조립)

**Files:**
- Modify: `packages/agent/src/main.ts` (전면), `packages/agent/src/config.ts` (+`turnTimeoutMs` 기본 30분, `stateDir` 기본 `~/.murmur-agent`)
- Delete: `packages/agent/src/reply.ts`, `packages/agent/src/harness/claudeCode.ts`, `packages/agent/test/reply.test.ts`, `packages/agent/test/claudeCode.test.ts`
- Test: `packages/agent/test/mentionTurn.test.ts` (통합 — 가짜 하네스 + 인메모리 murmur 클라이언트)

**Interfaces:**
- Consumes: Task 3~8 전부 + 기존 `murmur.ts`(변경 없음) + `policy.ts`(변경 없음)
- Produces: `runMentionTurn(deps, entry)` — 테스트 가능하도록 main 루프에서 분리된 함수

- [ ] **Step 1: 실패하는 통합 테스트** — `MurmurAgentClient` 와 같은 표면의 인메모리 fake 를 만들어:

```ts
// 시나리오 1: 첫 멘션 → ensureWorkspace 1회 + 세션 생성 + 가짜 하네스(FAKE_MODE=post,
//   fake 가 MURMUR_FAKE_POST=1 이면 fakeClient.post 를 직접 호출하는 대신 — 프로세스 경계라 불가 —
//   테스트가 턴 후 fakeClient 에 메시지를 심는 방식으로 '에이전트가 발화했다'를 재현) → NO_REPLY 없음
// 시나리오 2: 발화 없는 턴 → NO_REPLY_NOTICE 가 fakeClient.post 로 남는다
// 시나리오 3: 같은 threadKey 두 번째 멘션 → ensureWorkspace 재호출 없음 + isFirstTurn=false 로 -r 조립
//   (buildTurnCommand 호출 캡처는 runMentionTurn 에 spawn 함수를 주입해 확인)
// 시나리오 4: lastFedSeq 전진 — 두 번째 턴의 promptCtx 에 첫 턴 메시지가 없다
```

- [ ] **Step 2: 실패 확인** → FAIL
- [ ] **Step 3: 구현** — `runMentionTurn` 흐름:

```
def = murmur.definition()                     // 매 턴 — UI 수정 즉시 반영 (기존 성질 유지)
thread = murmur.readThread(...)
key = SessionStore.threadKey(channelId, anchor)
rec = store.get(key)
if (rec && rec.harness !== def.harness) rec = null   // harness 를 바꿨으면 세션을 버린다 (아래)
rec ??= { workspaceDir: await ensureWorkspace(...), sessionId: harness가 id 할당형이면 randomUUID(), harness: def.harness, lastFedSeq: 0 }
{prompt, fedSeq} = buildTurnPrompt(...)       // '' 이면 markRead 만 하고 끝
turnStartSeq = max(thread seq)
plan = buildTurnCommand({... def.mentionPermission ...})
result = await runPtyTurn(plan, { cwd: rec.workspaceDir, timeoutMs })
if codex && !rec.sessionId: rec.sessionId = findCodexSessionId(...)
after = murmur.readThread(...)
if (result.exitCode === 0 && !hasOwnPostSince(after, me.id, turnStartSeq)) murmur.post(NO_REPLY_NOTICE ...)
store.put(key, {...rec, lastFedSeq: fedSeq})
exitCode !== 0 || timedOut → throw (기존 attempts/MAX_ATTEMPTS 경로가 받는다)
```

**harness 변경은 세션을 무효화한다.** spec §3 은 "지시문·모델은 매 턴 플래그로 주입되므로
UI 수정이 자동 반영되고 무효화 장치가 필요 없다"고 했는데, harness 는 플래그가 아니라 **실행
바이너리**라 그 논리가 적용되지 않는다 — claude 가 발급한 session-id 를 codex 에 넘기면
resume 이 깨진다. `rec.harness !== def.harness` 면 `sessionId` 와 `lastFedSeq` 를 버리고 첫 턴으로
다시 시작한다(workspace 디렉터리는 재사용한다 — 그 안의 작업 산출물은 harness 와 무관하다).
그 스레드의 대화 기억 한 번을 잃지만, 이어 붙일 수 없는 세션을 이어 붙이려다 매 턴 실패하는
것보다 낫다. **테스트로 고정할 것**: 같은 threadKey 에서 harness 를 바꾸면 다음 턴이
`isFirstTurn: true` 로 조립되고 옛 sessionId 가 인자에 남지 않는다.

앞 태스크가 이연한 두 건이 여기서 만난다. **둘 다 이 태스크에서 닫는다.**

- **`ensureWorkspace` 의 존재 확인이 `access()` 라 파일/디렉터리를 구분하지 않는다**(Task 4 리뷰).
  같은 경로에 일반 파일이 있으면(비정상 종료가 남긴 빈 파일 등) 디렉터리로 간주해 그대로
  돌려주고, **그 경로를 cwd 로 쓰는 것이 바로 이 태스크다** — PTY spawn 이 ENOTDIR 로 죽거나
  더 나쁘게는 엉뚱한 곳에서 돈다. `packages/agent/src/workspace.ts` 의 확인을
  `stat().isDirectory()` 로 바꾸고, 경로가 존재하되 디렉터리가 아니면 던진다(그건 폴백 대상이
  아니라 사람이 고쳐야 할 상태다). 테스트도 함께 추가한다.
- **안전 거부(refusal)가 조용히 사라지지 않는지 확인한다**(Task 5 리뷰). 옛 `reply.ts::extractReply`
  는 `stop_reason === 'refusal'` 을 잡아 *"이 요청에는 답할 수 없었습니다(안전 거부: …)"* 를
  채널에 남겼다. 새 구조에는 그 자리가 없다 — 러너가 응답을 파싱하지 않기 때문이다. 하네스가
  거부하면 프로세스는 **정상 종료(exit 0)하고 발화가 없다**. 즉 `NO_REPLY_NOTICE` 경로가 이
  경우를 덮는다. 그 사실을 테스트로 고정하고(거부를 흉내내는 가짜 하네스 = exit 0 + 발화 없음),
  덮지 않는다면 사람 눈에는 에이전트가 조용히 죽은 것으로 보인다 — 옛 코드가 막던 바로 그것이다.
- **`buildTurnPrompt` 에 `channelId`·`threadRootId` 를 넘기는 것은 이 태스크의 책임이다**
  (Task 5 수정 라운드). `main.ts` 가 이미 `mention.channelId` 와 `anchor` 를 들고 있으므로
  그 값을 그대로 넘긴다 — 여기서 새로 계산하지 마라. 계산하는 순간 네 번째 진실 원천이 된다.

세부 둘: ① `repoDir = def.workingDir ?? process.cwd()` — workspace 격리는 workingDir 가
avcs repo 일 때만 성립하고 아니면 Task 4 폴백으로 그 자리에서 돈다. ② throw 하는 에러
메시지에 `result.tail` 을 포함시킨다 — PTY 는 stderr 가 스트림에 섞이므로 이게 없으면
`policy.ts::isCredentialFailure` 가 자격증명 실패를 패턴으로 잡을 수 없다.

프롬프트 머리에 `channelId`·`threadRootId` 를 명시해 에이전트가 `message.post` 대상을 안다. 기동 시 `writeMcpConfigOnce` 1회. 기존 `mkdtemp`+PAT 파일 경로 전부 삭제.

- [ ] **Step 4: 통과 확인** — agent 스위트 전체 + `pnpm --filter @murmur/agent typecheck`
- [ ] **Step 5: 커밋** — `feat(agent): 멘션 턴을 세션 resume 으로 — 기억은 디스크에, 발화는 에이전트가`

---

### Task 10: 데스크탑 — 멘션 권한 스위치

**Files:**
- Modify: `packages/desktop/src/components/settings/AgentsSettings.tsx` (draft 초기값 `:21`, fromView `:29`, configPatch `:69` 부근, 폼에 select 1개)
- Test: 기존 AgentsSettings 테스트 파일에 케이스 추가

**Interfaces:**
- Consumes: `AgentView.mentionPermission`, `MENTION_PERMISSIONS`(shared)

- [ ] **Step 1: 실패하는 테스트** — "Mention permission select 가 auto 기본으로 렌더되고, readonly 선택이 updateAgent patch 에 실린다" (기존 harness select 테스트 패턴 복제)
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** — harness select 아래 같은 스타일로:

```tsx
<label className={label}>
  Mention permission
  <select aria-label="Mention permission" value={draft.mentionPermission}
    onChange={(e) => setDraft({ ...draft, mentionPermission: e.target.value as MentionPermission })}>
    <option value="auto">auto — 멘션 턴에서 도구를 모두 허용</option>
    <option value="readonly">readonly — 읽기만 (상담 전용)</option>
  </select>
  <span className="text-[11px] text-zinc-500">사람이 터미널로 직접 조종할 때는 이 설정과 무관하게 하네스가 물어본다.</span>
</label>
```

- [ ] **Step 4: 통과 확인** — desktop 스위트
- [ ] **Step 5: 커밋** — `feat(desktop): 멘션 권한 스위치 — 서버가 열어 둔 조정 수단은 UI 에서 도달 가능해야 한다`

---

### Task 11: 문서·마감

**Files:**
- Modify: `docs/operations.md` §7 (러너 감독 — PATH 에 필요한 실행 파일이 `claude` 만이 아니라 `codex`·`gemini`·`avcs` 로 늘었다), `packages/agent/README.md` (세션·workspace·권한 모델 요약), `docs/roadmap.md` §5 ("harness 다양성" 항목을 실측 결과로 갱신)
- Test: 없음 (문서)

- [ ] **Step 1: 문서 3곳 갱신** — spec 을 근거 문서로 링크
- [ ] **Step 2: 전체 검증** — `pnpm test` (모노레포 전체) + `pnpm -r typecheck` — 모두 초록 확인
- [ ] **Step 3: 실물 확인 (로컬)** — 로컬 스택 + 실제 claude 로 성공 기준 1·2·5·7 을 손으로: 같은 스레드 2회 멘션(기억), 러너 재시작 후 멘션(기억 유지), 발화 없는 지시문으로 NO_REPLY 확인, `ls /tmp | grep murmur-agent` 로 PAT 파일 부재
- [ ] **Step 4: 커밋** — `docs: 러너 세션 코어 착지 — 운영·로드맵 반영`

---

## 스파이크 결과 (Task 1 이 기록)

실행 환경(전부 `~/.local/bin`, `--version` 실측 — 회차 1 리뷰 지적으로 재확인):

```
$ claude --version
2.1.252 (Claude Code)
$ codex --version
codex-cli 0.148.0
$ gemini --version
0.54.4
```

아래 각 항목은 "명령 → 관찰 → VERDICT" 순. **표와 실측이 다르면 실측이 이긴다** —
§4 표는 이 결과에 맞춰 갱신 대상이다.

### Step 1: claude 비대화형 resume 조합

```bash
SID=$(uuidgen | tr A-Z a-z)
claude -p --session-id $SID --model haiku "hello 라고만 답해"     # → "hello"
claude -p -r $SID --model haiku "방금 내가 뭐라고 했지?"           # → "\"hello 라고만 답해\"라고 했습니다."
```

두 번째 턴이 첫 턴을 정확히 기억한다. 추가로 **resume 이 cwd 에 안 묶이는지**까지
확인했다 — 세션을 만든 디렉터리와 전혀 다른 새 `mktemp -d` 에서 `-r` 로 재개해도
같은 기억을 돌려준다. `--resume`(장문)도 `-r`(단문)과 동일하게 동작한다.

VERDICT: **CONFIRMED** — 단, §4 표의 "사람 턴" 행 옆에 붙던 암묵적 전제
("세션이 프로젝트 디렉터리에 귀속되므로 workspace 디렉터리 고정이 필요")는
**DIFFERENT: cwd 무관**. claude 세션은 session-id 로만 식별되고 cwd 필터링이
없다 — 러너가 매 턴마다 `avcs workspace project` 로 다른 디렉터리에 체크아웃해도
resume 이 깨지지 않는다는 뜻이다(Task 7 의 workingDir 설계에 유리한 소식).

### Step 2: 인터랙티브 PTY + MCP env 확장

인터랙티브 TUI 는 스크립트로 조종할 수 없으므로(브리프 지침대로) **print 모드로
동등 사실을 확인**했다 — TUI 자체의 검증은 아래처럼 열려 있는 채로 남긴다.

로컬 스택 기동(포트 3400/5432 가 다른 워크트리(`rusalka`)에 이미 점유돼 있어
`dorado` 전용 포트로 올렸다 — 아래는 이번 스파이크에서 실제로 쓴 절차):

```bash
# docker-compose.override.yml (gitignored, 이번에 신규 작성 — 유지함)
services:
  postgres:
    ports:
      - "5433:5432"

docker compose up -d postgres
DATABASE_URL='postgres://murmur:murmur@localhost:5433/murmur' PORT=3401 \
  pnpm --filter @murmur/server dev &   # 마이그레이션 자동 실행 확인

curl -X POST localhost:3401/bootstrap -d '{"handle":"me","displayName":"Me","password":"changeme1"}'
TOKEN=$(curl -X POST localhost:3401/auth/login -d '{"handle":"me","password":"changeme1"}' | jq -r .token)
AGENT_ID=$(curl -X POST localhost:3401/accounts/agents -H "authorization: Bearer $TOKEN" \
  -d '{"handle":"spike-bot","displayName":"Spike Bot","harness":"claude-code"}' | jq -r .id)
PAT=$(curl -X POST localhost:3401/accounts/$AGENT_ID/pats -H "authorization: Bearer $TOKEN" \
  -d '{"label":"spike"}' | jq -r .token)   # murp_...

cat > /tmp/murmur-mcp.json <<'EOF'
{"mcpServers":{"murmur":{"type":"http","url":"http://localhost:3401/mcp","headers":{"Authorization":"Bearer ${MURMUR_PAT}"}}}}
EOF
MURMUR_PAT=$PAT claude -p --mcp-config /tmp/murmur-mcp.json --model haiku "list your available MCP tools"
```

결과: murmur MCP 가 연결되고 `account_me · channel_list · inbox_poll · inbox_read ·
message_post · message_read · message_search · work_link · workspace_guide` 9개
도구가 전부 노출됐다 — `mcpPlugin.ts` 가 등록한 도구 이름과 일치.

VERDICT: **CONFIRMED (print 모드)**. TUI 모드(`/mcp` 로 손으로 connected 확인)는
**NOT MEASURED — TUI 는 스크립트로 조종 불가**로 열어 둔다. print 모드가 같은
`--mcp-config`+env 확장 경로를 타므로 위험은 낮다고 판단하지만, 배포 전 사람이
한 번은 손으로 확인해야 한다(Task 11 Step 3 의 실물 확인에 이미 포함돼 있다).

**부가 발견 (표에는 없던 사실, §7 재검토 근거로 기록):** `--strict-mcp-config`
플래그가 존재하고, 켜면 지정한 `--mcp-config` 파일의 서버만 남기고 그 외 전부
차단된다. 이 단언은 처음엔 strict **켠** 쪽 출력만 근거로 삼았다는 지적을 받아
strict **끈** 쪽도 별도로 재현했다(murmur 서버는 이번엔 안 띄우고 PAT 도 가짜값 —
"murmur 연결 성공"이 아니라 "다른 전역 서버가 같이 뜨는가"만 보는 것이 목적):

```
$ MURMUR_PAT='murp_fake' claude -p --mcp-config /tmp/murmur-mcp.json \
    --model haiku "list the names of your available MCP tools, names only"
## Available MCP Tools
### AVCS (38 tools)
mcp__avcs__avcs_approval_record, mcp__avcs__avcs_blame, ... (38개 전부)
### AVCSHub (8 tools)
mcp__avcshub__check_report, mcp__avcshub__issue_create, ...
### Buddy (13 tools)
mcp__buddy__buddy_dream, mcp__buddy__buddy_forget, ...
### Slack (18 tools)
mcp__claude_ai_Slack__slack_add_reaction, ...
### Chrome DevTools (32 tools)
mcp__plugin_chrome-devtools-mcp_chrome-devtools__click, ...
### Requiring Authentication
claude.ai Notion, claude.ai Gmail, claude.ai Google Drive, ...
```

즉 이 세션 운영자의 `~/.claude.json` 전역 MCP 서버(avcs·avcshub·buddy·Slack·
Chrome DevTools, 그리고 미인증 Notion/Gmail/Google Drive 등)가 `--mcp-config`
로 지정한 murmur 하나만 있을 때도 그대로 전부 딸려 나온다 — 예상대로였다,
**이 발견으로 spec §7 이 뒤집혔다(커밋 8a116fb) — 아래는 그 결과이지 열린 질문이 아니다.**
초판 §7 은 "avcs MCP 도 물어야 하므로 strict 를 쓰지 않는다"고 적었는데 거짓 전제였다:
설정 파일을 러너가 만들므로 avcs 를 그 안에 넣으면 된다(`avcs mcp`, stdio, env 없음 —
실측 확인). 확정된 결정은 **`--strict-mcp-config` 를 쓰고 생성 설정에 murmur + avcs 둘만
넣는다**이며, Task 6 의 `writeMcpConfigOnce` 와 Task 9 의 조립이 이것을 구현한다.
검토 대상으로 남기지 않는다.

### Step 3: codex 표면

```bash
codex exec --help | head -30
codex mcp --help
codex mcp add --help
tail -1 ~/.codex/session_index.jsonl | python3 -m json.tool
codex --help | grep -i "instructions\|system"
```

실측:

- **`exec resume` 존재 확인** — 단, 최상위 `codex resume <id>` 는 **인터랙티브
  피커**이고, 비대화형 표는 반드시 `codex exec resume [SESSION_ID] [PROMPT]`
  (서브커맨드) 다. §4 표의 `codex exec resume <id> "<ctx>"` 표기는 CONFIRMED.
  실제로 `codex exec "..."` 로 첫 턴을 띄우고(JSON 출력의 `thread_id` 를 획득)
  `codex exec resume <thread_id> "..."` 로 재개해 기억을 확인했다 — 서로 다른
  `mktemp -d` 사이에서도 성공(claude 와 동일하게 cwd 무관).
- **`session_index.jsonl` 스키마는 표의 전제와 다르다 — DIFFERENT.** 실제 필드는
  `{id, thread_name, updated_at}` 뿐이고 **`cwd` 가 없다.** 이 인덱스는 인터랙티브
  TUI 의 "이름 붙은 스레드"만 기록하는 것으로 보인다 — 우리가 `codex exec` 로
  만든 세션은 이 파일에 **한 줄도 추가되지 않았다.** 진짜 세션 저장소는
  `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` 이고, 그 첫 줄
  (`type:"session_meta"`) 안에 `session_id · id · timestamp · cwd · originator ·
  cli_version · source` 가 다 있다. **러너가 codex 세션을 찾거나 상태를 검증할
  일이 있으면 `session_index.jsonl` 이 아니라 이 rollout 파일 경로 규칙을
  참조해야 한다.**
- **MCP 등록 형식이 claude 와 근본적으로 다르다 — DIFFERENT.** `codex mcp add
  <name> --url <url> --bearer-token-env-var <ENV>` 는 **`~/.codex/config.toml`
  에 영구 기록**한다 — Global Constraints 의 "하네스 영구 설정을 바꾸는 명령
  금지"에 정면으로 걸린다. 실제로 안전하게 쓸 수 있는 건 **턴마다 `-c` 오버라이드**
  다: `-c 'mcp_servers.murmur.url="http://.../mcp"' -c
  'mcp_servers.murmur.bearer_token_env_var="MURMUR_PAT"'`. 실측: 이 두 `-c` 를
  붙여 `codex exec` 를 돌리면 murmur MCP 가 연결되고(`channels, inbox, messages,
  work links` 도구 확인), **`~/.codex/config.toml` 은 변경되지 않는다**
  (`grep mcp_servers` 로 확인 — `murmur` 항목 없음). `--ephemeral` 은 필요
  없다(그 플래그는 세션 롤아웃 자체를 디스크에 안 남기는 옵션이라 오히려 resume
  을 깨뜨린다 — 켜지 않았다). PAT 는 여기서도 env 변수 이름만 argv 에 실리고
  값은 안 실린다 — claude 와 동일한 안전성.
- **지시문 주입구 없음 — CONFIRMED (브리프의 예상대로).** `--instructions`/
  `--system` 계열 플래그가 `codex --help` 에 전혀 없다. 대안: 프롬프트 앞에
  구분 태그로 접두 — 예) `<<SYSTEM>>...<</SYSTEM>>\n<프롬프트>`. codex 쪽
  `TurnPlan` 은 이 접두를 `promptCtx` 조립 단계에서 처리해야 한다(별도 플래그
  슬롯 없음).
- **부가 발견: `-a`/`--ask-for-approval` 은 `codex exec` 서브커맨드에 없다 —
  최상위(인터랙티브) `codex` 에만 있다.** `codex exec --help` 와 `codex exec
  resume --help` 둘 다 `-a` 를 나열하지 않는다 — `-s`(sandbox: read-only /
  workspace-write / danger-full-access) 만 있다. §4 표의 `-s danger-full-access
  -a never` 같은 조합은 **DIFFERENT: `codex exec` 경로에서는 `-a` 를 뺀다** —
  승인 정책은 exec 모드에서 샌드박스(`-s`)와
  `--dangerously-bypass-approvals-and-sandbox`(readonly 가 아닐 때만, 매우
  위험 — 셸 명령이 샌드박스 없이 실행된다) 조합으로만 조정 가능하다. `auto`
  는 `-s danger-full-access`, `readonly` 는 `-s read-only` 로 매핑하고 `-a` 는
  Task 6 표에서 제거한다.

VERDICT: **DIFFERENT** (세션 스키마·MCP 등록·승인 플래그 세 곳 모두 표의 전제와
다르다). `exec resume` 존재와 형태만 CONFIRMED.

**[Critical] 이 실측은 Task 8 을 그대로 무너뜨린다 — 이름을 걸고 적는다.**
Task 8(§ 607–618)의 `findCodexSessionId(indexJsonl, {cwd, sinceMs})` 는
`session_index.jsonl` 을 **cwd 로 매칭**해 codex 세션 id 를 찾는 설계다. 위
실측 세 가지가 이 설계를 세 겹으로 무너뜨린다: (a) 그 파일의 실제 필드는
`{id, thread_name, updated_at}` 로 애초에 `cwd` 가 없다, (b) `codex exec` 로 만든
세션은 그 파일에 **한 줄도 안 들어간다** — cwd 가 있었어도 매칭할 대상 자체가
없었다, (c) `codex exec --json` 은 stdout 첫 줄에서 곧바로
`{"type":"thread.started","thread_id":"..."}` 를 내놓는다 — 애초에 파일을 뒤져
id 를 "찾을" 필요가 없다. **Task 8 은 존재하지 않는 파일 스키마를 존재하지 않는
레코드에서 찾는 함수를 짜고 있었다** — 그대로는 첫 테스트 픽스처부터 성립하지
않는다.

리뷰 요청대로 대안 A(rollout 파일 glob)가 성립하려면 그 파일에 `cwd` 가 있어야
하므로, Step 3 에서 이미 만든 세션(재사용, 새로 안 만듦)의 최신 rollout 파일을
다시 열어 키 이름만 확인했다(대화 내용은 옮기지 않는다):

```bash
$ ls -t ~/.codex/sessions/**/*.jsonl | head -1
/Users/jaebin/.codex/sessions/2026/09/01/rollout-2026-09-01T23-00-31-01a05d45-....jsonl
$ head -1 <그 파일> | python3 -c '...payload.keys()...'
payload keys: ['session_id', 'id', 'timestamp', 'cwd', 'originator', 'cli_version',
  'source', 'thread_source', 'model_provider', 'base_instructions', 'history_mode',
  'context_window']
cwd value: /private/var/folders/.../tmp.4PUsIQ02fm   # 그 turn 을 실행한 mktemp 디렉터리와 일치
```

**판정: A 가 가능하다** — `session_meta`(각 rollout 파일의 1번째 줄) 에 정확한
이름의 `cwd` 필드가 있고 실제 실행 디렉터리와 일치한다. Task 8 은
`findCodexSessionId(indexJsonl, ...)` 를 폐기하고 다음 모양으로 다시 설계해야
한다:

- **대안 A — rollout 파일 glob** (channel): `~/.codex/sessions/**/rollout-*.jsonl`
  을 mtime 역순으로 훑어 각 파일 1번째 줄의 `session_meta.cwd` 가 일치하는 첫
  파일을 찾고 `session_meta.session_id` 를 취한다. **장점**: PTY 를 평범하게
  띄워 `codex exec`/`codex exec resume` 을 그대로 쓰므로 사람이 진행 중 턴에
  attach 할 수 있다(spec §6 셋째 경우 "멘션 턴에 attach" 가 유지된다). **비용**:
  디렉터리 통째로 glob+정렬해야 하고(세션이 많아지면 느려질 수 있다), rollout
  파일 포맷은 codex 내부 구현이라 버전이 바뀌면 깨질 수 있는 비공개 계약이다.
- **대안 B — `--json` stdout 파싱**: `codex exec --json` 의 첫 줄
  `{"type":"thread.started","thread_id":...}` 를 그 자리에서 파싱해 id 를
  얻는다. **장점**: 세션 id 가 사실상 공짜고 파일 스캔이 없다. **비용**: 그
  턴의 화면이 사람이 읽는 터미널이 아니라 JSON 이벤트 스트림이 된다 — **사람이
  붙어도 터미널이 아니다.** 이 프로젝트가 부록 A 에서 ACP 를 기각한 바로 그
  이유("stdio 는 하나다 — 사람이 들어가 볼 터미널이 없다")가 codex 턴에서만
  재현된다. `--json` 을 켠 채로는 spec §6 셋째 경우(멘션 턴에 attach)와 §14
  성공 기준 3(소유자가 진행 중 턴의 실제 화면을 본다)이 codex 에서만 깨진다.

**A 를 채택한다** — attach 요구가 spec 전체를 관통하는 핵심 성공 기준(§14-3)
이라 B 로 그것을 codex 에서만 포기하는 비용이 더 크다. Task 8 의 함수 시그니처를
`findCodexSessionId(indexJsonl, {cwd, sinceMs})` 에서
`findCodexSessionId(sessionsDir, {cwd, sinceMs})` 로 바꾸고, "다른 cwd 1개,
대상 cwd 1개" 픽스처는 `session_index.jsonl` 대신 임시 `sessions/**/rollout-*.jsonl`
트리로 다시 짜야 한다 — 이것이 Task 6 뿐 아니라 **Task 8 도 이 스파이크 결과에
맞춰 다시 써야 한다**는 뜻이다.

### Step 4: gemini 표면

```bash
gemini --help | grep -iA2 "approval\|yolo\|prompt\b"
SID=$(uuidgen); gemini --session-id $SID -p "hello 라고만 답해"
gemini -r "$SID" -p "방금 내가 뭐라고 했지?"
```

실측 (플래그 표면은 `--help` 로 인증 없이 확인 가능, 실제 라운드트립은 인증
블로커로 막혔다 — 아래 참조):

- **`-r/--resume` 은 UUID 를 받지 않는다 — DIFFERENT.** `--help` 원문:
  `-r, --resume  Resume a previous session. Use "latest" for most recent or
  index number (e.g. --resume 5)`. `--session-id` 는 "**새** 세션을 지정한
  UUID 로 시작"하는 용도지 재개용이 아니다. 실측으로도 재현됐다 —
  `gemini -r "$SID" -p ...` 는 `Error resuming session: No previous sessions
  found for this project.` 를 반환했다(세션이 프로젝트=cwd 스코프라는 뜻이기도
  하다 — "for this project" 문구). §4 표의 `-r <id> -p "<ctx>"` 는 **DIFFERENT:
  gemini 는 UUID resume 을 지원하지 않는다.** 대안은 인덱스 기반(`--resume
  <n>`) 또는 `latest` 뿐이라 **세션 특정 재개가 사실상 불가능** — 이는 Task 6/9
  설계에 영향이 크다(여러 스레드를 동시에 돌리는 러너가 "몇 번째" 세션인지
  추적해야 한다는 뜻이라 claude/codex 와 같은 표 모양으로 못 넣는다. gemini 를
  1차 harness 다양성 목표로 삼은 §14 성공 기준 8 의 근거
  ["id 할당형이라 가깝다"]가 **틀렸다** — id 로 재개하는 게 아니라 index 로
  재개한다. 대안 harness 로는 codex 가 더 가깝다).
- **권한/비대화형 플래그**: `-y/--yolo`(전부 자동 승인), `--approval-mode
  {default,auto_edit,yolo,plan}`, `-p/--prompt`(headless), `-s/--sandbox`,
  `--allowed-mcp-server-names`, `--allowed-tools`(**DEPRECATED**, Policy Engine
  으로 대체 권고) 를 확인. `auto` → `--approval-mode yolo`, `readonly` →
  `--approval-mode plan` 매핑이 가능해 보인다(미검증 — 실제 라운드트립 불가로
  아래에서 NOT MEASURED 처리).
- **인증 블로커 — 실제 모델 호출 라운드트립은 NOT MEASURED.** 이 머신의 gemini
  OAuth 계정이 "This client is no longer supported for Gemini Code Assist for
  individuals. To continue using Gemini, please migrate to the Antigravity
  suite of products" 로 전부 거부된다(`GEMINI_API_KEY`/`GOOGLE_API_KEY` 도 미설정).
  `--list-sessions` 조차 이 에러로 실패해 세션 저장 자체를 확인할 수 없었다.

VERDICT: **DIFFERENT (resume 인자 형식 — 표를 반드시 고쳐야 한다)** +
**NOT MEASURED (실제 라운드트립 — 이 환경의 gemini 계정이 API 인증을 잃었다.
별도로 `GEMINI_API_KEY` 발급 후 재검증 필요)**.

### Step 5: `avcs workspace land` 의 미추적 파일 처리

```bash
cd ~/dev/my-workspace/avcs
avcs workspace project spike-test --out /tmp/ws-spike
touch /tmp/ws-spike/untracked-note.md
avcs workspace land spike-test
```

`project` 까지는 실행했다(235개 파일을 `/tmp/.../ws-spike` 로 프로젝션 성공).
**`land` 자체는 권한 분류기가 차단해 실행하지 못했다** — "Blocked by classifier"
로 거부되어, 지침(§ "결과를 판단할 수 없으면 NOT MEASURED로 남기고 강행하지
않는다")대로 강행하지 않고 멈췄다.

**부가로 기록할 사고:** `avcs workspace land --help` 를 옵션 확인용으로
먼저 시도했는데, avcs CLI 는 서브커맨드에 `--help` 관례가 없어 **`--help`
자체가 워크스페이스 이름으로 파싱**됐고, 실제로 `landed workspace --help` 가
찍히며 `avcs workspace list` 에 `landed  --help` 항목이 생겼다(git 트리는
깨끗함 — 프로젝션한 적 없는 이름이라 내용 없는 랜드였다, 무해하지만 목록은
오염). **avcs CLI 에 서브커맨드 `--help` 가 없다는 것 자체가 실측 결과다** —
`land`/`project` 앞에 함부로 `--help` 를 붙이면 실제 명령이 실행된다. 이후
avcs 작업에서 이 실수를 반복하지 않도록 별도로 기록해 둔다(공개 avcs 리포지토리
쪽에 UX 이슈로 등록할 만한 소재이나 이번 스파이크 범위 밖).

VERDICT: **NOT MEASURED — 권한 분류기가 실제 `land` 실행을 차단.** 미추적
파일이 오브젝트로 들어가는지는 미확인. 이번 Phase 는 영향 없음(브리프 원문)
이므로 후속 우선순위는 낮지만, Phase 2 이후 `avcs workspace land` 를 실제로
호출하는 코드가 생기면 그 전에 반드시 재검증해야 한다.

### 정리(cleanup)

- `docker-compose.override.yml` (postgres `5433:5432`) 은 **남겨뒀다** — gitignore
  대상이고 다음 작업(Task 2 이후 서버 통합 테스트)에도 재사용 가능.
- 스파이크로 띄운 `dorado` 컴포즈 스택(서버 프로세스 + `dorado-postgres-1`
  컨테이너)은 전부 내렸다 — `docker compose down` 완료, `dorado_pgdata` 볼륨만
  남아 있다(재기동 시 자동 재사용, 삭제해도 무방).
- `/tmp/murmur-mcp.json`, `/tmp/ws-spike` 등 임시 파일은 삭제했다.
- `~/dev/my-workspace/avcs` 에는 `avcs workspace project spike-test` 로 만든
  in-flight 워크스페이스가 **land 되지 않은 채 남아 있다**(land 가 차단됐으므로
  삭제 커맨드가 없다 — 다른 in-flight 브랜치들과 같은 성격이라 무해하게 방치).
  실수로 생긴 `--help` landed 워크스페이스도 내용이 없어 마찬가지로 방치했다.
  이 리포지토리에는 커밋도 푸시도 하지 않았다.
