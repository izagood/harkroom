# P2+P3 — 멘션 턴을 TUI 로 돌린다

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 멘션 턴을 `claude -p` 가 아니라 TUI 로 띄워 사람이 진행 중인 턴에 직접 칠 수 있게 하고, 그에 맞는 턴의 끝을 정한다.

**Architecture:** `stdinFile` 을 없애 자식의 fd 0 이 PTY 가 되면 `acceptsPtyInput` → `acceptsInput` 이 참이 되고 서버·데스크탑은 손대지 않아도 입력이 열린다. 프롬프트는 bracketed paste 로 PTY 에 주입한다. TUI 는 답하고도 죽지 않으므로 턴의 끝을 **"발화했고 아무도 안 본다"** 로 다시 정의하고, 회수는 인터랙티브 턴이 쓰는 viewer 기반 장치를 그대로 재사용한다.

**Tech Stack:** TypeScript (ESM, `type: module`), Node ≥22, vitest 3, node-pty.

**Spec:** `docs/specs/2026-09-08-tui-execution-model-design.md` (§3-1 ~ §3-5), 실측표는 `docs/specs/2026-09-01-runner-sessions-pty-design.md` §5-4

## Global Constraints

- 대상은 `packages/agent` 뿐이다. **서버·데스크탑은 이 계획에서 한 줄도 안 바꾼다** — 입력 게이트가 러너의 `acceptsInput` 한 값에서 파생되기 때문이다(설계 §2).
- **P2 와 P3 는 한 릴리스여야 한다.** TUI 는 답하고도 안 죽으므로, 새 종료 조건 없이 TUI 만 넣으면 모든 턴이 `turnTimeoutMs`(30분)까지 살아 있다가 SIGKILL 로 끝난다.
- **codex 는 안 바꾼다.** 계속 `exec`(stdinFile)로 돌고 그 세션은 관찰 전용이다. P5 의 일이다.
- **하네스 tail 로 하는 자격증명 판정을 없앤다.** 주입한 프롬프트가 PTY 에 에코돼 tail 에 섞이므로, 그대로 두면 본문에 `authentication_error` 를 적은 사람이 러너를 `exit 78` 로 물러나게 할 수 있다(설계 §3-4). murmur PAT 판정(HTTP status)은 **그대로 둔다**.
- **미로그인 프리플라이트는 만들지 않는다.** 조건 기반 부팅 대기가 그 일을 한다 — 미로그인 TUI 는 채팅 준비 상태에 영원히 못 닿으므로 부팅 상한에서 실패한다(Task 2).
- 주석은 한국어로, 저장소의 기존 톤을 따른다: **무엇을 하는지가 아니라 왜 그래야 하는지, 그러지 않으면 무엇이 깨지는지**.
- 테스트: `pnpm --filter @murmur/agent exec vitest run <파일>`. 전체는 `pnpm --filter @murmur/agent test`.

## File Structure

| 파일 | 책임 |
|---|---|
| `packages/agent/src/turn.ts` (수정) | claude 프리셋에서 `mode` 분기를 없앤다 — 멘션도 TUI |
| `packages/agent/src/pty.ts` (수정) | `injectPrompt` 옵션: 조건 기반 부팅 대기 → bracketed paste 주입 |
| `packages/agent/src/mentionTurn.ts` (수정) | `stdinFile` 을 안 만들고 주입으로 넘긴다. 발화 감지·회수·무발화 타임아웃 |
| `packages/agent/src/mentionScheduler.ts` (수정) | 유예 판정을 `viewer > 0` 으로 |
| `packages/agent/src/policy.ts` (수정) | 하네스 자격증명 tail 매칭 제거 |
| `packages/agent/src/harnessErrors.ts` (수정) | 자격증명도 JSONL 로 분류한다 |

---

### Task 1: claude 프리셋에서 mode 분기를 없앤다

**Files:**
- Modify: `packages/agent/src/turn.ts` (CLAUDE_PRESET 의 `session()`)
- Test: `packages/agent/test/turn.test.ts`, `packages/agent/test/acceptance-cli.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `buildTurnCommand({ harness: 'claude-code', mode: 'mention', … })` 의 argv 에 `-p` 가 **없다**.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/turn.test.ts` 에 추가:

```ts
  it('멘션 턴도 TUI 로 조립된다 — -p 가 없다(2026-09-08 실행 모델 교체)', () => {
    const first = buildTurnCommand({
      harness: 'claude-code', mode: 'mention', sessionId: SESSION, isFirstTurn: true,
      mcpConfigPath: '/tmp/mcp.json', pat: 'murp_x', murmurUrl: 'http://localhost:3400',
    });
    expect(first.args).not.toContain('-p');
    expect(first.args).toContain('--session-id');

    const resumed = buildTurnCommand({
      harness: 'claude-code', mode: 'mention', sessionId: SESSION, isFirstTurn: false,
      mcpConfigPath: '/tmp/mcp.json', pat: 'murp_x', murmurUrl: 'http://localhost:3400',
    });
    expect(resumed.args).not.toContain('-p');
    expect(resumed.args).toContain('-r');
  });

  it('멘션과 인터랙티브의 argv 가 같아진다 — 갈라 둘 근거가 없어졌다', () => {
    const common = {
      harness: 'claude-code' as const, sessionId: SESSION, isFirstTurn: false,
      mcpConfigPath: '/tmp/mcp.json', pat: 'murp_x', murmurUrl: 'http://localhost:3400',
    };
    const mention = buildTurnCommand({ ...common, mode: 'mention' });
    const interactive = buildTurnCommand({ ...common, mode: 'interactive' });
    expect(mention.args).toEqual(interactive.args);
  });
```

`SESSION` 은 이 파일의 기존 상수다. 없으면 그 파일이 쓰는 uuid 상수를 그대로 쓴다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/turn.test.ts`
Expected: FAIL — `args` 에 `-p` 가 들어 있다

- [ ] **Step 3: 최소 구현을 쓴다**

`turn.ts` 의 `CLAUDE_PRESET.session` 을 다음으로 교체한다:

```ts
  session(sessionId, isFirstTurn, _mode) {
    // `buildTurnCommand` 가 이 함수를 부르기 전에 `assertValidSession` 이 이미 non-null 을
    // 보장했다(claude 의 `allowsNullSessionOnFirstTurn` 은 false).
    const id = sessionId as string;
    // **`mode` 를 보지 않는다(2026-09-08 실행 모델 교체).** 멘션 턴도 TUI 로 돈다 —
    // `-p` 를 붙이면 프롬프트를 stdin 파일로 줘야 하고, 그 순간 자식의 fd 0 이 PTY 가
    // 아니게 되어 사람이 그 턴에 칠 수 없다(스펙 §5-3·§5-4). 사람이 개입할 수 있게 하는
    // 것이 터미널을 보여 주는 이유이므로, 그 제약을 받아들일 근거가 없다.
    //
    // 첫 턴은 resume 이 아니다: `--session-id <uuid>` 로 뜨고, 첫 메시지가 들어가면 그
    // uuid 의 세션 파일이 생겨 이후 `-r` 이 성립한다. 여기서 `-r` 로 조립하면 존재한 적
    // 없는 세션을 이어받으려다 "No conversation found" 로 죽는다.
    return isFirstTurn ? ['--session-id', id] : ['-r', id];
  },
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/turn.test.ts test/acceptance-cli.test.ts`
Expected: PASS. `acceptance-cli.test.ts` 가 실물 CLI 에 argv 를 대조하므로, 여기서 초록이면 조립한 플래그가 실제로 존재한다는 뜻이다. 기존 케이스가 `-p` 를 기대하고 있으면 그 기대를 갱신한다 — 그것이 이 변경의 요점이다.

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/turn.ts packages/agent/test/turn.test.ts packages/agent/test/acceptance-cli.test.ts
git commit -m "feat(agent): 멘션 턴도 TUI 로 조립한다 — claude 프리셋의 mode 분기 제거

-p 를 붙이면 프롬프트를 stdin 파일로 줘야 하고 그 순간 자식의 fd 0 이 PTY 가
아니게 되어 사람이 그 턴에 칠 수 없다. 터미널을 보여 주는 이유가 개입인데
그 제약을 받아들일 근거가 없다."
```

---

### Task 2: 프롬프트 주입 — 조건 기반 부팅 대기 + bracketed paste

**Files:**
- Modify: `packages/agent/src/pty.ts`
- Test: `packages/agent/test/pty.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `RunPtyTurnOptions` 에 `injectPrompt?: { text: string; readyPattern?: RegExp; readyTimeoutMs?: number }` 가 붙는다. 준비 신호를 못 보면 그 턴은 `TurnResult { exitCode: 1, timedOut: false, tail }` 이 아니라 **`PromptNotDeliveredError` 를 reject 한다**.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/pty.test.ts` 에 추가. `FAKE_HARNESS`(`test/helpers/fake-harness.mjs`)를 쓰는 기존 방식을 따른다:

```ts
describe('injectPrompt — TUI 에 프롬프트를 넣는다(2026-09-08)', () => {
  it('준비 신호를 본 뒤 bracketed paste 로 감싸 보낸다 — 여러 줄이 한 메시지로 간다', async () => {
    // fake-harness 는 준비 신호를 찍고 stdin 을 읽어 그대로 되뱉는다.
    const plan = fakePlan(['ready-then-echo']);
    const chunks: Buffer[] = [];
    const result = await runPtyTurn(plan, {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      onData: (c) => chunks.push(c),
      injectPrompt: { text: '첫 줄\n둘째 줄', readyPattern: /READY/, readyTimeoutMs: 10_000 },
    });
    const seen = Buffer.concat(chunks).toString('utf8');
    // 감싸지 않으면 첫 개행에서 조기 전송돼 '둘째 줄' 이 별개 메시지가 된다.
    expect(seen).toContain('[200~');
    expect(seen).toContain('[201~');
    expect(result.exitCode).toBe(0);
  });

  it('준비 신호를 못 보면 상한에서 실패한다 — 조용히 프롬프트 없는 TUI 를 남기지 않는다', async () => {
    // 준비 신호를 영원히 안 찍는 하네스(미로그인 화면·신뢰 대화상자가 이 모양이다).
    const plan = fakePlan(['hang-silent']);
    await expect(runPtyTurn(plan, {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      injectPrompt: { text: '아무거나', readyPattern: /READY/, readyTimeoutMs: 800 },
    })).rejects.toThrow(/준비 신호/);
  });

  it('injectPrompt 가 없으면 아무것도 쓰지 않는다 — codex 의 stdinFile 경로가 그대로다', async () => {
    const plan = fakePlan(['exit-0']);
    const chunks: Buffer[] = [];
    await runPtyTurn(plan, { cwd: process.cwd(), timeoutMs: 10_000, onData: (c) => chunks.push(c) });
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain('[200~');
  });
});
```

`fakePlan(args)` 은 이 파일이 이미 쓰는 헬퍼다(없으면 기존 케이스가 `TurnPlan` 을 만드는 방식을 그대로 쓴다). `test/helpers/fake-harness.mjs` 에 두 시나리오를 더한다:

```js
// ready-then-echo: 준비 신호를 찍고 stdin 을 읽어 되뱉은 뒤 종료한다.
if (mode === 'ready-then-echo') {
  process.stdout.write('READY\n');
  process.stdin.setEncoding('utf8');
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    // bracketed paste 의 끝 표식이 오면 받은 것을 그대로 되뱉고 끝낸다.
    if (buf.includes('[201~')) { process.stdout.write(buf); process.exit(0); }
  });
}

// hang-silent: 아무 신호도 안 찍고 버틴다 — 미로그인 화면·모달의 모양이다.
if (mode === 'hang-silent') {
  setInterval(() => {}, 1000);
}
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/pty.test.ts`
Expected: FAIL — `injectPrompt` 가 옵션 타입에 없다

- [ ] **Step 3: 최소 구현을 쓴다**

`pty.ts` 상단에 에러 타입을 더한다(`ExecutableNotFoundError` 옆):

```ts
/**
 * TUI 가 프롬프트를 받을 준비 상태에 닿지 못했다.
 *
 * **조용히 넘어가면 안 되는 이유**: 준비 전에 쓴 바이트는 사라진다. 그대로 두면 하네스가
 * 프롬프트 없이 떠서 무발화 타임아웃(기본 30분)까지 살아 있고, 사람은 30분을 기다린 끝에
 * "답변에 실패했습니다"를 본다. 미로그인 화면·디렉터리 신뢰 대화상자가 정확히 이 모양이라
 * (§5-4 실측), 이 실패가 그것들을 함께 잡는 그물이다.
 */
export class PromptNotDeliveredError extends Error {
  constructor(public readonly waitedMs: number, public readonly tail: string) {
    super(`TUI 준비 신호를 ${waitedMs}ms 안에 못 봤다 — 프롬프트를 넣지 못했다. 마지막 출력: ${tail}`);
    this.name = 'PromptNotDeliveredError';
  }
}
```

`RunPtyTurnOptions` 에 더한다:

```ts
  /**
   * TUI 에 넣을 프롬프트(2026-09-08 실행 모델 교체). 있으면 spawn 뒤 **준비 신호를 기다렸다가**
   * bracketed paste 로 감싸 쓰고 `\r` 로 보낸다.
   *
   * **bracketed paste 로 감싸는 이유**: 그냥 쓰면 첫 개행에서 조기 전송돼 여러 줄 프롬프트가
   * 여러 메시지로 갈라진다(§5-4 실측).
   *
   * **준비 대기가 조건 기반인 이유**: 고정 슬립은 두 방향으로 틀린다 — 짧으면 프롬프트를
   * 잃고(준비 전 바이트는 사라진다), 길면 매 턴을 그만큼 늦춘다.
   */
  injectPrompt?: {
    text: string;
    /** 이 패턴이 출력에 보이면 준비된 것으로 본다. 생략하면 claude TUI 의 입력 프롬프트. */
    readyPattern?: RegExp;
    /** 준비 상한. 넘기면 `PromptNotDeliveredError`. 생략하면 60초. */
    readyTimeoutMs?: number;
  };
```

`runPtyTurn` 안, `dataListener` 를 건 **뒤**에 주입 배선을 넣는다:

```ts
    // ── 프롬프트 주입(2026-09-08). 준비 신호를 본 뒤에만 쓴다.
    if (opts.injectPrompt) {
      const { text, readyPattern = DEFAULT_READY_PATTERN, readyTimeoutMs = 60_000 } = opts.injectPrompt;
      let injected = false;
      const startedAt = Date.now();
      const readyTimer = setTimeout(() => {
        if (injected || settled) return;
        // 준비를 못 봤다 — 이 턴은 프롬프트 없이 도는 것이 아니라 실패로 끝난다.
        readyProbe.dispose();
        proc.kill('SIGKILL');
        reject(new PromptNotDeliveredError(Date.now() - startedAt, decodeTailText(tail.snapshot())));
      }, readyTimeoutMs);
      readyTimer.unref?.();
      const readyProbe = proc.onData(() => {
        if (injected) return;
        if (!readyPattern.test(decodeTailText(tail.snapshot()))) return;
        injected = true;
        clearTimeout(readyTimer);
        readyProbe.dispose();
        // 감싸고 나서 전송한다. 두 번에 나눠 쓰는 이유: 붙여 쓰면 일부 TUI 가 끝 표식과
        // 개행을 한 덩어리로 읽어 전송을 건너뛴다.
        proc.write(`[200~${text}[201~`);
        proc.write('\r');
      });
    }
```

파일 상단 상수에 더한다:

```ts
/**
 * claude TUI 가 입력을 받을 준비가 됐다는 신호. 화면에 뜨는 입력 프롬프트 표시다.
 *
 * **버전에 기대는 값이다.** claude 가 이 표시를 바꾸면 준비를 못 보고 상한에서 실패한다 —
 * 조용히 넘어가는 것보다 낫다(그때는 프롬프트가 사라진 채 30분을 기다린다). 실패가 곧
 * 이 상수를 고쳐야 한다는 신호다.
 */
const DEFAULT_READY_PATTERN = /[❯>]\s*$|Ask\s+\w+\s+to\s+do\s+anything/m;
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/pty.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/pty.ts packages/agent/test/pty.test.ts packages/agent/test/helpers/fake-harness.mjs
git commit -m "feat(agent): TUI 에 프롬프트를 주입한다 — 조건 기반 준비 대기 + bracketed paste

준비 전에 쓴 바이트는 사라진다. 고정 슬립은 짧으면 프롬프트를 잃고 길면 매
턴을 늦추므로 조건으로 기다리고 상한을 둔다. 상한을 넘기면 조용히 넘어가지
않고 실패한다 — 미로그인 화면과 신뢰 대화상자가 정확히 그 모양이라, 이
실패가 그것들을 함께 잡는 그물이다."
```

---

### Task 3: 멘션 턴이 TUI 로 뜬다

**Files:**
- Modify: `packages/agent/src/mentionTurn.ts` (`stdinFile` 을 만드는 곳과 `deps.runTurn` 호출부)
- Test: `packages/agent/test/mentionTurn.test.ts`

**Interfaces:**
- Consumes: Task 1 의 argv, Task 2 의 `injectPrompt`.
- Produces: 멘션 턴의 `TurnPlan.stdinFile === null`, `runTurn` opts 에 `injectPrompt.text` 가 실린다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
  it('멘션 턴은 stdinFile 없이 뜨고 프롬프트는 주입으로 간다 — 사람이 칠 수 있다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    const { deps, plans, runTurn } = await makeDeps(fake);
    let injected: string | undefined;
    runTurn.script = async (_plan, opts: { injectPrompt?: { text: string } }) => {
      injected = opts.injectPrompt?.text;
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });

    // fd 0 이 PTY 다 — 이 하나가 acceptsInput 을 참으로 만든다(스펙 §5-3 의 판정 그대로).
    expect(plans[0]!.stdinFile).toBeNull();
    expect(acceptsPtyInput(plans[0]!)).toBe(true);
    // 프롬프트는 argv 가 아니라 주입으로 간다 — argv 로 가면 ps 에 대화가 샌다(#117).
    expect(injected).toContain('안녕');
    expect(plans[0]!.args.join(' ')).not.toContain('안녕');
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: FAIL — `stdinFile` 이 non-null 이다

- [ ] **Step 3: 최소 구현을 쓴다**

`mentionTurn.ts` 에서 `stdinFile` 을 만드는 블록(현재 `writePromptFile` 을 부르는 곳)을 다음으로 교체한다:

```ts
  // **프롬프트는 파일이 아니라 주입으로 간다(2026-09-08 실행 모델 교체).**
  //
  // `#117` 이 대화 본문을 argv 에서 stdin 파일로 옮긴 이유(같은 머신의 다른 사용자가
  // `ps -ef` 로 스레드 내용을 읽는다)는 **여기서도 지켜진다** — 주입은 argv 를 지나지
  // 않는다. 바뀐 것은 "파일이냐 PTY 냐"뿐이고, 그 선택이 사람이 이 턴에 칠 수 있는지를
  // 결정한다(스펙 §5-3: 판정은 fd 0 의 정체 하나로 한다).
  //
  // codex 는 그대로 `exec` + stdinFile 이다 — P5 전까지 두 세계가 함께 산다.
  const usesTui = def.harness === 'claude-code';
  let stdinFile: string | null = null;
  if (!usesTui) {
    stdinFile = await writePromptFile(deps.stateDir, combinedPromptForExec);
  }
```

`combinedPromptForExec` 는 기존 codex 분기가 쓰던 값이다(지시문 + 본문을 합친 것) — 그 조립을 그대로 둔다.

`deps.runTurn(plan, { … })` 호출에 더한다:

```ts
      // TUI 로 뜬 턴에만 주입한다. codex 의 exec 은 stdin 파일이 프롬프트다.
      ...(usesTui ? { injectPrompt: { text: prompt } } : {}),
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/mentionTurn.ts packages/agent/test/mentionTurn.test.ts
git commit -m "feat(agent): 멘션 턴이 stdinFile 없이 뜨고 프롬프트는 주입으로 간다

이 한 줄이 acceptsInput 을 참으로 만든다 — 서버·데스크탑은 손대지 않아도
입력이 열린다(스펙 §5-3 의 판정이 fd 0 의 정체 하나만 보기 때문이다).

#117 이 막은 것(ps 노출)은 그대로다: 주입은 argv 를 지나지 않는다."
```

---

### Task 4: 턴의 끝 — 발화 감지와 viewer 기반 회수

**Files:**
- Modify: `packages/agent/src/mentionTurn.ts`
- Test: `packages/agent/test/mentionTurn.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `MentionTurnDeps` 에 `orphanMs?: number`(기본 60초)·`utteranceProbeMs?: number`(기본 3초)·`schedule?`(테스트 주입)가 붙는다. `TurnRelay.openSession` 이 `onViewerCount?: (n: number) => void` 를 받는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
describe('턴의 끝 — 발화 + 관찰자 없음 (2026-09-08)', () => {
  it('발화하면 회수한다 — TUI 는 답하고도 안 죽으므로 러너가 끝을 정한다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    let killed: string | null = null;
    const { deps, runTurn } = await makeDeps(fake, { utteranceProbeMs: 10, orphanMs: 10 });
    runTurn.script = async (_plan, opts: {
      onSpawn?: (c: { write(b: Buffer): void; resize(c: number, r: number): void; kill(s?: string): void }) => void;
    }) => {
      opts.onSpawn?.({ write: () => {}, resize: () => {}, kill: (s) => { killed = s ?? 'SIGTERM'; } });
      await fake.post(CHANNEL, '답했다', null);      // 발화
      await new Promise((r) => setTimeout(r, 200));  // TUI 처럼 안 죽고 버틴다
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    expect(killed).toBe('SIGTERM');
  });

  it('관찰자가 있으면 발화해도 회수하지 않는다 — 사람이 보고 있으면 러너는 끼어들지 않는다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    let killed: string | null = null;
    let notifyViewers: ((n: number) => void) | undefined;
    const { deps, runTurn } = await makeDeps(fake, {
      utteranceProbeMs: 10,
      orphanMs: 10,
      relay: {
        openSession: (input: { onViewerCount?: (n: number) => void }) => {
          notifyViewers = input.onViewerCount;
          return { sessionId: 's1', push: () => {}, bindInput: () => {}, close: () => {} };
        },
      },
    });
    runTurn.script = async (_plan, opts: { onSpawn?: (c: { write(b: Buffer): void; resize(c: number, r: number): void; kill(s?: string): void }) => void }) => {
      opts.onSpawn?.({ write: () => {}, resize: () => {}, kill: (s) => { killed = s ?? 'SIGTERM'; } });
      notifyViewers?.(1);                            // 사람이 붙어 있다
      await fake.post(CHANNEL, '답했다', null);
      await new Promise((r) => setTimeout(r, 200));
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    expect(killed).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: FAIL — `killed` 가 `null` (아무도 회수하지 않는다)

- [ ] **Step 3: 최소 구현을 쓴다**

`mentionTurn.ts` 의 `TurnRelay.openSession` 입력에 `onViewerCount?: (count: number) => void` 를 더하고, `MentionTurnDeps` 에 더한다:

```ts
  /**
   * 발화를 확인하는 주기(기본 3초). TUI 는 답하고도 안 죽으므로 러너가 "답했는가"를
   * 직접 봐야 한다 — 그 신호는 스레드의 발화이고, 그것은 서버에만 있다.
   */
  utteranceProbeMs?: number;
  /** 발화 뒤 관찰자가 0 일 때 회수까지의 유예(기본 60초). 인터랙티브 턴과 같은 값이다. */
  orphanMs?: number;
  /** 테스트가 타이머를 잡기 위한 주입. 생략하면 setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void;
```

`deps.runTurn(...)` 호출 앞에 상태와 회수 배선을 둔다:

```ts
  // ── 턴의 끝(2026-09-08). TUI 는 답하고도 죽지 않으므로 러너가 끝을 정한다.
  //
  // 끝의 정의는 **"발화했고 아무도 안 본다"** 다. 발화만으로 즉시 죽이면 사람이 답을 보고
  // 이어서 칠 수 없고(터미널을 보여 주는 이유가 그것이다), 관찰자만 보면 아무도 안 보는
  // 스레드의 프로세스가 영원히 산다. 두 조건이 함께 있어야 한다.
  //
  // 회수 장치를 새로 만들지 않는다 — `interactiveTurn.ts` 의 viewer 기반 고아 회수가 이미
  // 그것이고, 그 주석이 근거를 적어 뒀다: 패널 닫힘·소켓 단절·앱 강제종료가 서버 관점에서
  // 전부 "뷰어 소멸" 하나로 수렴한다.
  const schedule = deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
  const end: {
    controls: PtyWriter | null; exited: boolean; spoke: boolean; viewers: number;
    cancelReclaim: (() => void) | null; cancelProbe: (() => void) | null;
  } = { controls: null, exited: false, spoke: false, viewers: 0, cancelReclaim: null, cancelProbe: null };

  const reclaim = (): void => {
    if (end.exited || !end.controls) return;
    // SIGTERM 이 1차다 — 하네스가 모델 요청 중일 수 있어 정리할 기회를 준다. 세션은
    // 디스크라 kill 로 잃는 것이 없다.
    end.controls.kill('SIGTERM');
  };

  /** 끝 조건을 다시 잰다. 발화·뷰어 어느 쪽이 바뀌어도 여기로 모인다. */
  const reconsiderEnd = (): void => {
    if (end.exited) return;
    if (!end.spoke || end.viewers > 0) {
      end.cancelReclaim?.();
      end.cancelReclaim = null;
      return;
    }
    if (end.cancelReclaim) return; // 이미 유예 중 — 다시 세우면 유예가 늘어난다.
    end.cancelReclaim = schedule(() => { end.cancelReclaim = null; reclaim(); }, deps.orphanMs ?? 60_000);
  };

  const onViewerCount = (count: number): void => {
    end.viewers = count;
    reconsiderEnd();
  };
```

세션을 열 때 `onViewerCount` 를 넘기고, `runTurn` 의 `onSpawn` 에서 `end.controls = writer` 를 잡는다. 그리고 발화 폴링을 건다:

```ts
    // 발화 폴링. 서버에만 있는 사실이라 물어보는 수밖에 없다 — 에이전트는 자기 PAT 로
    // 서버에 직접 발화하므로 러너의 PTY 출력에는 그 사실이 안 나타난다.
    const probeMs = deps.utteranceProbeMs ?? 3_000;
    const probe = (): void => {
      if (end.exited || end.spoke) return;
      void deps.murmur.readThread(channelId, anchor, turnStartSeq)
        .then((after) => {
          if (end.exited || end.spoke) return;
          if (countOwnPostsSince(after, deps.me.id, turnStartSeq) > 0) {
            end.spoke = true;
            reconsiderEnd();
            return;
          }
          end.cancelProbe = schedule(probe, probeMs);
        })
        // 관측 실패로 턴을 죽이지 않는다 — 다음 주기에 다시 묻는다.
        .catch(() => { end.cancelProbe = schedule(probe, probeMs); });
    };
    end.cancelProbe = schedule(probe, probeMs);
```

`runTurn` 이 돌아오면(어느 경로로든) 정리한다:

```ts
  } finally {
    end.exited = true;
    end.cancelProbe?.();
    end.cancelReclaim?.();
  }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/mentionTurn.ts packages/agent/test/mentionTurn.test.ts
git commit -m "feat(agent): 턴의 끝을 '발화 + 관찰자 없음' 으로 정한다

TUI 는 답하고도 죽지 않으므로 러너가 끝을 정해야 한다. 발화만으로 즉시
죽이면 사람이 답을 보고 이어 칠 수 없고, 관찰자만 보면 아무도 안 보는
스레드의 프로세스가 영원히 산다.

회수 장치는 interactiveTurn 의 viewer 기반 고아 회수를 그대로 쓴다."
```

---

### Task 5: 타임아웃을 무발화 경과로 바꾼다

**Files:**
- Modify: `packages/agent/src/mentionTurn.ts`
- Test: `packages/agent/test/mentionTurn.test.ts`

**Interfaces:**
- Consumes: Task 4 의 `end` 상태.
- Produces: `runTurn` 에 넘기는 `timeoutMs` 가 `0`(무기한)이 되고, 무발화 판정은 러너가 한다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
  it('무발화가 turnTimeoutMs 를 넘기면 회수하고 실패로 끝난다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    let killed: string | null = null;
    const { deps, runTurn } = await makeDeps(fake, { utteranceProbeMs: 10, turnTimeoutMs: 50 });
    runTurn.script = async (_plan, opts: { onSpawn?: (c: { write(b: Buffer): void; resize(c: number, r: number): void; kill(s?: string): void }) => void }) => {
      opts.onSpawn?.({ write: () => {}, resize: () => {}, kill: (s) => { killed = s ?? 'SIGTERM'; } });
      await new Promise((r) => setTimeout(r, 300));  // 아무 말도 안 한다
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    expect(killed).toBe('SIGTERM');
  });

  it('관찰자가 있으면 무발화 타임아웃도 재지 않는다 — 사람이 보고 있으면 끼어들지 않는다', async () => {
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');
    let killed: string | null = null;
    let notifyViewers: ((n: number) => void) | undefined;
    const { deps, runTurn } = await makeDeps(fake, {
      utteranceProbeMs: 10, turnTimeoutMs: 50,
      relay: {
        openSession: (input: { onViewerCount?: (n: number) => void }) => {
          notifyViewers = input.onViewerCount;
          return { sessionId: 's1', push: () => {}, bindInput: () => {}, close: () => {} };
        },
      },
    });
    runTurn.script = async (_plan, opts: { onSpawn?: (c: { write(b: Buffer): void; resize(c: number, r: number): void; kill(s?: string): void }) => void }) => {
      opts.onSpawn?.({ write: () => {}, resize: () => {}, kill: (s) => { killed = s ?? 'SIGTERM'; } });
      notifyViewers?.(1);
      await new Promise((r) => setTimeout(r, 300));
      return { exitCode: 0, timedOut: false, tail: '' };
    };

    await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION });
    expect(killed).toBeNull();
  });
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: FAIL — 첫 케이스에서 아무도 회수하지 않는다

- [ ] **Step 3: 최소 구현을 쓴다**

Task 4 의 `end` 상태에 무발화 시계를 더한다. `onSpawn` 안(컨트롤을 잡은 직후):

```ts
        // **무발화 시계(2026-09-08).** `turnTimeoutMs` 는 이제 프로세스 수명이 아니라
        // "답 없이 흐른 시간"을 잰다 — TUI 는 답하고도 안 죽으므로 프로세스 수명으로
        // 재면 정상 턴까지 시간 한도에 걸린다.
        //
        // 관찰자가 있으면 재지 않는다: 인터랙티브 턴이 이미 `timeoutMs: 0`(무기한)인 것과
        // 같은 규칙이고, 회수(3-2)·유예(3-5)와 한 문장으로 모인다 — 사람이 보고 있으면
        // 러너는 끼어들지 않는다.
        end.cancelSilence = schedule(() => {
          if (end.exited || end.spoke || end.viewers > 0) return;
          end.silenced = true;
          reclaim();
        }, deps.turnTimeoutMs);
```

`end` 타입에 `cancelSilence: (() => void) | null; silenced: boolean` 을 더하고 `finally` 에서 `end.cancelSilence?.()` 를 부른다.

`runTurn` 에 넘기는 `timeoutMs` 를 바꾼다:

```ts
      // **0 = 무기한**(pty.ts 옵션 주석). 시간 한도는 러너가 무발화로 잰다 — PTY 쪽 시계는
      // 프로세스 수명을 재는데, TUI 에서는 그 둘이 다른 사실이다.
      timeoutMs: usesTui ? 0 : deps.turnTimeoutMs,
```

무발화로 끝난 턴은 실패로 다룬다 — 결과 판정에서:

```ts
  if (end.silenced) {
    // tail 은 담지 않는다: TUI 에서는 주입한 프롬프트가 에코돼 섞이고, 그것이 판정 재료가
    // 되면 사람이 러너를 죽일 수 있다(설계 §3-4). 사실만 적는다.
    throw new Error(`harness 무발화 ${deps.turnTimeoutMs}ms — 답 없이 시간 한도를 넘겼다`);
  }
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/mentionTurn.ts packages/agent/test/mentionTurn.test.ts
git commit -m "feat(agent): turnTimeoutMs 가 무발화 경과를 잰다

TUI 는 답하고도 안 죽으므로 프로세스 수명으로 재면 정상 턴까지 한도에
걸린다. 관찰자가 있으면 재지 않는다 — 회수·유예와 같은 조건이다."
```

---

### Task 6: 유예 판정을 viewer 로 바꾼다

**Files:**
- Modify: `packages/agent/src/mentionScheduler.ts`
- Test: `packages/agent/test/mentionScheduler.test.ts`

**Interfaces:**
- Consumes: 없음(레지스트리 대신 주입된 조회 함수를 쓴다).
- Produces: `MentionSchedulerDeps` 에 `viewersOf(threadKey: string): number` 가 붙는다. `controlOf` 판정은 그대로 두고 **그 앞에** viewer 판정이 선다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`mentionScheduler.test.ts` 에 추가:

```ts
  it('그 스레드를 보고 있는 사람이 있으면 유예한다 — 주입이 사람의 타이핑과 섞이면 안 된다', async () => {
    let calls = 0;
    const scheduler = createMentionScheduler({
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => { calls += 1; return { stopRequestedAt: null }; },
      buildTurnDeps: () => ({}) as never,
      viewersOf: () => 1,          // 사람이 보고 있다
      hooks: {
        resumeHandoff: async () => {}, stopRequested: () => {},
        exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
    });

    const out = await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    expect(out.deferred).toBe(1);
    expect(calls).toBe(0);
  });

  it('보는 사람이 없으면 그대로 띄운다', async () => {
    let calls = 0;
    const scheduler = createMentionScheduler({
      murmur: { markRead: async (ids) => ids.length, post: async () => 1 },
      registry: new TurnRegistry(),
      queue: new MentionQueue(),
      accountLane: [null],
      runMentionTurn: async () => { calls += 1; return { stopRequestedAt: null }; },
      buildTurnDeps: () => ({}) as never,
      viewersOf: () => 0,
      hooks: {
        resumeHandoff: async () => {}, stopRequested: () => {},
        exitIfUnrecoverable: () => {}, noticeHarnessLogin: async () => {},
      },
      startedAtMs: 0,
    });

    const out = await scheduler.admit(batchOf([{ entryId: 1, messageId: 'm1' }]), ctx);
    expect(out.started).toBe(1);
    await scheduler.drain();
    expect(calls).toBe(1);
  });
```

기존 `harness()` 헬퍼에도 `viewersOf: () => 0` 을 더한다(기본은 아무도 안 본다).

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts`
Expected: FAIL — `viewersOf` 가 타입에 없고, 첫 케이스가 `started: 1` 로 온다

- [ ] **Step 3: 최소 구현을 쓴다**

`MentionSchedulerDeps` 에 더한다:

```ts
  /**
   * 이 스레드를 지금 보고 있는 사람 수(2026-09-08).
   *
   * **왜 턴의 종류가 아니라 뷰어인가.** 멘션 턴이 TUI 가 되면서 두 종류의 실질 차이가
   * "누가 열었나"뿐이 됐다. 유예가 막아야 하는 것은 그 이름이 아니라 **입력이 섞이는 것**
   * 이다 — 사람이 터미널에서 타이핑하는 중에 러너가 bracketed paste 를 밀어 넣으면 두
   * 입력이 같은 PTY 에서 겹친다. 그 사실을 정확히 재는 값이 뷰어 수다.
   */
  viewersOf(threadKey: string): number;
```

`admit` 의 유예 블록을 다음으로 넓힌다(`controlOf` 판정 **앞**에 뷰어를 본다):

```ts
        // 사람이 이 스레드를 보고 있으면 유예한다 — 주입이 그 사람의 타이핑과 섞인다.
        // `controlOf`(인터랙티브 턴·이어받기 예약)보다 **앞**이다: 뷰어가 더 넓은 사실이고,
        // 좁은 판정이 먼저 서면 넓은 경우를 못 잡는다.
        const watching = deps.viewersOf(threadKey) > 0;
        const controlling = watching ? { openedByHandle: undefined } : deps.registry.controlOf(threadKey);
        if (watching || controlling) {
```

이하 유예 본문(통지·`queue.defer`)은 그대로다.

- [ ] **Step 4: main.ts 를 배선한다**

`main.ts` 의 `createMentionScheduler({...})` 에 더한다:

```ts
  // 릴레이가 그 스레드의 세션에 붙어 있는 뷰어 수를 안다. 릴레이가 없으면 0 이다 —
  // 아무도 못 보는 것이 사실이므로 유예할 이유도 없다.
  viewersOf: (threadKey) => relay.viewersOf?.(threadKey) ?? 0,
```

`relay.ts` 의 `RelayClient` 에 `viewersOf(threadKey: string): number` 를 더한다. `LiveSession` 이 이미 `onViewerCount` 로 받은 값을 들고 있으므로 그 값을 threadKey 로 찾아 돌려준다. 세션이 없으면 0.

- [ ] **Step 5: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionScheduler.test.ts && pnpm --filter @murmur/agent typecheck`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add packages/agent/src/mentionScheduler.ts packages/agent/src/main.ts packages/agent/src/relay.ts packages/agent/test/mentionScheduler.test.ts
git commit -m "feat(agent): 유예 판정을 턴 종류에서 뷰어 유무로 바꾼다

멘션 턴이 TUI 가 되면서 두 종류의 실질 차이가 '누가 열었나' 뿐이 됐다.
유예가 막아야 하는 것은 이름이 아니라 입력이 섞이는 것이고, 그 사실을
정확히 재는 값이 뷰어 수다."
```

---

### Task 7: 하네스 자격증명 판정을 tail 에서 뗀다

**Files:**
- Modify: `packages/agent/src/policy.ts`, `packages/agent/src/harnessErrors.ts`, `packages/agent/src/mentionTurn.ts`
- Test: `packages/agent/test/policy.test.ts`, `packages/agent/test/harnessErrors.test.ts`

**Interfaces:**
- Consumes: `readLastApiError`(P1).
- Produces: `isCredentialFailure` 의 `'harness-credential'` 판정이 `err.harnessApiError` 만 본다. tail 문자열 매칭은 사라진다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`policy.test.ts` 에 추가:

```ts
  it('사람이 넣은 프롬프트가 에코돼 tail 에 섞여도 자격증명 실패로 읽지 않는다(2026-09-08)', () => {
    // TUI 는 입력을 에코한다. 그대로 두면 본문에 이 문구를 적은 사람이 러너를 78 로
    // 물러나게 할 수 있고, 그 러너가 맡은 모든 스레드가 함께 죽는다.
    const err = new Error('harness 종료 1: 사용자가 보낸 말 — authentication_error 를 조사해줘');
    expect(isCredentialFailure(err)).toBe('other');
  });

  it('하네스가 낸 구조화 에러는 자격증명 실패로 읽는다', () => {
    const err = Object.assign(new Error('harness 종료 1: (에코 섞인 tail)'), {
      harnessApiError: 'API Error: authentication_error · Please run /login',
    });
    expect(isCredentialFailure(err)).toBe('harness-credential');
  });

  it('murmur PAT 판정은 그대로다 — status 로만 잰다', () => {
    const err = Object.assign(new Error('unauthorized'), { source: MURMUR_ERROR_SOURCE, status: 401 });
    expect(isCredentialFailure(err)).toBe('murmur-credential');
  });
```

`MURMUR_ERROR_SOURCE` import 를 더한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/policy.test.ts`
Expected: FAIL — 첫 케이스가 `'harness-credential'` 로 온다(tail 매칭이 잡는다)

- [ ] **Step 3: 최소 구현을 쓴다**

`policy.ts` 의 `isCredentialFailure` 에서 하네스 tail 매칭을 걷어낸다:

```ts
export function isCredentialFailure(err: unknown): CredentialFailureType {
  const status = (err as { status?: number } | null)?.status;
  // murmur 클라이언트가 붙인 태그가 있으면 그쪽이다. 판정은 **HTTP status 로만** 한다.
  if ((err as { source?: string } | null)?.source === MURMUR_ERROR_SOURCE) {
    return status === 401 || status === 403 ? 'murmur-credential' : 'other';
  }

  // **하네스 자격증명은 tail 문자열로 재지 않는다(2026-09-08).** TUI 는 주입한 프롬프트를
  // 그대로 에코하므로 tail 에 사람이 쓴 말이 섞인다. 그 재료로 판정하면 본문에
  // `authentication_error` 를 적은 사람이 러너를 78 로 물러나게 할 수 있고, 그 러너가 맡은
  // **모든 스레드**가 함께 죽는다(설계 §3-4).
  //
  // 대신 하네스가 자기 세션 파일에 남긴 구조화 에러를 본다(`harnessErrors.ts`). 거기에는
  // 사람의 말이 섞일 수 없다.
  const structured = (err as { harnessApiError?: unknown } | null)?.harnessApiError;
  if (typeof structured === 'string' && HARNESS_CREDENTIAL_PATTERNS.some((re) => re.test(structured))) {
    return 'harness-credential';
  }
  return 'other';
}
```

`HARNESS_CREDENTIAL_PATTERNS` 는 그대로 둔다 — 재료만 바뀌고 문구 목록은 여전히 유효하다.

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/policy.test.ts`
Expected: PASS. 기존 tail 기반 케이스가 있으면 **구조화 필드로 옮긴다**(삭제가 아니라 이설이다).

- [ ] **Step 5: 전체 확인과 커밋**

Run: `pnpm --filter @murmur/agent typecheck && pnpm --filter @murmur/agent test`

```bash
git add packages/agent/src/policy.ts packages/agent/test/policy.test.ts
git commit -m "fix(agent): 하네스 자격증명 판정을 tail 에서 뗀다

TUI 는 주입한 프롬프트를 에코하므로 tail 에 사람이 쓴 말이 섞인다. 그 재료로
판정하면 본문에 authentication_error 를 적은 사람이 러너를 78 로 물러나게 할
수 있고, 그 러너가 맡은 모든 스레드가 함께 죽는다.

문구 목록은 그대로 두고 재료만 세션 파일의 구조화 에러로 바꾼다."
```

---

## 최종 확인

- [ ] `pnpm --filter @murmur/agent test` — 전부 통과
- [ ] `pnpm -r typecheck && pnpm -r test` — 워크스페이스 회귀 없음
- [ ] 실물 확인 ①: 러너를 띄우고 멘션을 하나 보낸 뒤 데스크탑에서 그 터미널을 연다. **입력창이 접히지 않고 칠 수 있어야 한다**(지금까지는 `observe-only` 로 접혔다).
- [ ] 실물 확인 ②: 그 상태에서 `Ctrl+C` 를 친다. `Interrupted · What should Claude do instead?` 가 뜨고 프로세스가 살아 있어야 한다.
- [ ] 실물 확인 ③: 에이전트가 답한 뒤 터미널을 닫으면 유예 뒤 프로세스가 회수되는지 본다(`ps` 로 claude 프로세스가 사라지는지).

## 이 계획이 하지 않는 것

- **codex.** 계속 `exec` + stdinFile 로 돈다. P5 의 일이다.
- **`[이어받기]` 철거.** P3 가 끝나면 아무도 안 부르게 되지만, 먼저 지우면 이어받기가 필요한 구간이 남는다. P4 의 일이다.
- **미로그인 프리플라이트.** Task 2 의 조건 기반 준비 대기가 그 일을 한다 — 미로그인 TUI 는 채팅 준비에 못 닿아 상한에서 실패하고, 계정 축이 다음으로 넘어간다. keychain 탐침을 새로 만들 이유가 없다.
- **`isSessionIdConflict` 의 이설.** 그 실패는 부팅 중에 나고 그때 tail 에는 아직 프롬프트가 안 들어갔다(주입은 준비 신호 뒤다). 오염 경로가 없으므로 그대로 둔다.
