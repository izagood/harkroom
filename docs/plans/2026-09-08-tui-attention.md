# TUI 가 사람을 부른다 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 멘션 턴이 하네스의 첫 실행 관문에 걸리면 그 PTY 를 죽이지 않고 사람에게
넘겨, 사람이 관문을 지나는 순간 프롬프트가 주입되어 턴이 그대로 이어지게 한다.

**Architecture:** `pty.ts` 의 준비 상한이 SIGKILL 대신 `onAttention` 콜백을 부른다.
`readyProbe` 가 살아 있으므로 사람이 관문을 지나면 그 자리에서 주입된다. 러너는 계정
풀을 다 태운 뒤에만 부르고, 그 사실이 새 릴레이 프레임(`attention.required`)으로 서버를
거쳐 데스크탑 이벤트(`agent.attention`)가 되어 터미널 패널이 자동으로 열린다.

**Tech Stack:** TypeScript ESM, Node ≥22, vitest 3, node-pty, Tauri 2 + React

**Spec:** `docs/specs/2026-09-08-tui-attention-design.md`

## Global Constraints

- 준비 상한 기본값은 **60초**(`pty.ts::injectPrompt.readyTimeoutMs` 기본). 바꾸지 않는다.
- `onAttention` 이 **없으면** 지금 동작 그대로다: SIGKILL + `PromptNotDeliveredError`.
  콜백 유무가 두 정책을 가른다 — 별도 플래그를 두지 않는다(스펙 §2-1).
- 사람을 부르는 것은 **계정 풀을 다 태운 뒤**다(스펙 §2-3). `claudeAccounts.ts:140` 의
  `switchesAccount(PromptNotDeliveredError) === true` 는 **그대로 둔다**.
- 릴레이로 나가는 화면 바이트는 `output` 과 **같은 규율로 base64** 다. 서버는 열지 않는다.
- 새 릴레이 능력 문자열은 `'attention'`. `RUNNER_CAPS`(`relay.ts:34`)에 더한다.
- 새 옵셔널 필드/프레임은 구 러너·구 서버가 모른다 — **없으면 "없다"로 읽는다.**
  없는 것을 있다고 표시하지 않는다(`docs/design.md` §4).
- 한국어 주석. 기존 파일의 주석 밀도와 어조를 따른다.
- 테스트는 `packages/agent/test/`, 픽스처는 `packages/agent/test/fixtures/`,
  가짜 하네스는 `packages/agent/test/helpers/fake-harness.mjs`.

---

### Task 1: 관문 측정 — 설계의 미확정 둘을 없앤다

스펙 §4 확인 항목 1·7 이다. **이 결과가 Task 5 의 §2-4(계정당 창 하나)를 확정하거나
뒤집는다.** 코드 변경은 없고, 산출물은 픽스처와 스펙 갱신이다.

**Files:**
- Create: `packages/agent/test/fixtures/claude-tui-onboarding-theme.txt`
- Create: `packages/agent/test/fixtures/claude-tui-bypass-warning.txt`
- Create: `packages/agent/test/gatekeeperScreens.test.ts`
- Modify: `docs/specs/2026-09-08-tui-attention-design.md`(§2-4 인용문, §4 항목 1·7)

**Interfaces:**
- Consumes: `looksReadyForPrompt(rawOutput, pattern?)` — `packages/agent/src/pty.ts` 의
  기존 export. 시그니처 `(rawOutput: string, pattern?: RegExp) => boolean`.
- Produces: 픽스처 파일 2개와, 스펙에 확정된 사실 두 줄(③의 저장 단위 / 오판 지점).

- [ ] **Step 1: 측정 스크립트를 쓴다**

`packages/agent/probe-gatekeeper.tmp.mjs` (임시 — 커밋하지 않는다):

```js
import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [, , CFG, WS, OUT] = process.argv;
const p = spawn('claude', ['--session-id', randomUUID(), '--permission-mode', 'bypassPermissions'], {
  name: 'xterm-256color', cols: 120, rows: 40, cwd: WS,
  env: { ...process.env, CLAUDE_CONFIG_DIR: CFG },
});
let raw = '';
p.onData((d) => { raw += d; });
setTimeout(() => {
  writeFileSync(OUT, raw);              // 실물 그대로 뜬다 — ANSI 를 지우지 않는다
  const flat = raw.replace(/\[[0-9;?]*[a-zA-Z]/g, '').replace(/\s+/g, ' ');
  const 관문 =
    /Ask\s+\S+\s+to\s+do\s+anything/.test(flat) ? '없음 — 입력 프롬프트 도달'
    : /text style that looks best/.test(flat) ? '① 온보딩 테마'
    : /project you created or one you trust/.test(flat) ? '② 폴더 신뢰'
    : /Bypass Permissions mode/.test(flat) ? '③ bypass 수락'
    : '알 수 없음';
  console.log(`관문=${관문}  → ${OUT}`);
  p.kill('SIGKILL');
  process.exit(0);
}, 20_000);
```

**화면 문구로 판별하는 것이 이 스크립트의 요점이다.** ②와 ③은 화면에 똑같이
`❯ No, exit` 를 써서, 커서 뒤 바이트만 보면 구분되지 않는다 — 2026-09-08 에 실제로
그렇게 오판했다.

- [ ] **Step 2: 관문 ③의 저장 단위를 잰다**

`hasTrustDialogAccepted` 가 **이미 심어진** 워크스페이스 둘이 필요하다(그래야 ②가
안 뜨고 ③만 남는다). 없으면 만든다:

```bash
cd packages/agent
WS_A=$(mktemp -d)/a && WS_B=$(mktemp -d)/b && mkdir -p "$WS_A" "$WS_B"
CFG=~/.murmur-agent/claude-accounts/work/aria
python3 - "$CFG/.claude.json" "$WS_A" "$WS_B" <<'PY'
import json, sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
d = json.load(open(p))
for ws in (a, b):
    d.setdefault('projects', {}).setdefault(ws, {})['hasTrustDialogAccepted'] = True
json.dump(d, open(p, 'w'))
print('신뢰 심음:', a, b)
PY
node probe-gatekeeper.tmp.mjs "$CFG" "$WS_A" /tmp/gate-a.txt
```

`관문=③ bypass 수락` 이 나와야 한다. 그러면 그 창에서 사람이 `↓` + `Enter` 로
`Yes, I accept` 를 고른 뒤(같은 명령을 터미널에서 직접 실행), **다른** 워크스페이스로 잰다:

```bash
node probe-gatekeeper.tmp.mjs "$CFG" "$WS_B" /tmp/gate-b.txt
```

- `관문=없음` → ③은 **계정 단위**다. 스펙 §2-4 확정, Task 5 를 계획대로 진행한다.
- `관문=③` → ③은 **워크스페이스 단위**다. **여기서 멈추고 사람에게 보고한다** —
  스펙 §2-4 와 §6 을 다시 써야 하고(모든 첫 턴이 관문에 걸리므로 `workspaceTrust.ts`
  가 ③도 심어야 한다), Task 5 의 범위가 바뀐다.

- [ ] **Step 3: 준비 오판 지점을 찾는다**

스펙 §2-5 는 "프로덕션 턴이 준비 신호를 `true` 로 봤다"를 소거법으로 결론지었다.
어느 화면의 어느 글자인지 찾는다:

```bash
node -e '
const { looksReadyForPrompt } = await import("./src/pty.js");
const raw = require("fs").readFileSync(process.argv[1], "utf8");
console.log("READY =", looksReadyForPrompt(raw));
const clean = raw.replace(/\][^]*(?:|\\)/g, "")
                 .replace(/[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]/g, "");
for (const m of clean.matchAll(/[❯›](.)/g)) {
  const c = m[1];
  console.log(`  커서 뒤: U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")}`,
              c === " " ? "← NBSP (준비로 읽힌다)" : JSON.stringify(c));
}
' /tmp/gate-a.txt
```

관문 ①의 화면으로도 같은 것을 돌린다(온보딩을 안 지난 계정 설정 복사본이 필요하다 —
`.claude.json` 을 복사해 `hasCompletedOnboarding` 키를 지우면 된다).

- [ ] **Step 4: 실물 화면을 픽스처로 뜬다**

```bash
cp /tmp/gate-a.txt test/fixtures/claude-tui-bypass-warning.txt
cp /tmp/gate-onboarding.txt test/fixtures/claude-tui-onboarding-theme.txt
rm -f probe-gatekeeper.tmp.mjs
```

**실물을 띄우는 테스트는 커밋하지 않는다** — 로그인·환경에 의존해 CI 에서 꺼지거나
빨개진다. 회귀선은 픽스처다.

- [ ] **Step 5: 픽스처에 대한 판정 테스트를 쓴다**

`packages/agent/test/gatekeeperScreens.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { looksReadyForPrompt } from '../src/pty.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');

// 2026-09-08 실물 화면. 관문이 늘 때마다 여기에 한 줄이 붙는다 — 그것이 이 파일의 값이다.
describe('첫 실행 관문 화면은 준비가 아니다', () => {
  const 관문들 = [
    ['① 온보딩 테마 선택', 'claude-tui-onboarding-theme.txt'],
    ['② 폴더 신뢰', 'claude-tui-trust-modal.txt'],
    ['③ bypassPermissions 수락', 'claude-tui-bypass-warning.txt'],
  ] as const;

  for (const [label, file] of 관문들) {
    it(`${label} 화면에서 준비 신호가 거짓이다`, () => {
      expect(looksReadyForPrompt(read(file))).toBe(false);
    });
  }

  it('입력 프롬프트 화면에서만 참이다', () => {
    expect(looksReadyForPrompt(read('claude-tui-ready.txt'))).toBe(true);
  });

  // **커서 문자만으로는 못 가른다.** 이 단언이 없으면 다음 사람이 판정을 `/[❯›]/` 로
  // 되돌리고, 그 순간 모든 관문이 준비로 읽힌다(2026-09-08 이 결함의 실제 모양).
  it('관문 화면에도 커서 문자는 있다 — 커서만 보는 판정으로 되돌리지 마라', () => {
    for (const [, file] of 관문들) {
      expect(/[❯›]/.test(read(file))).toBe(true);
    }
  });
});
```

- [ ] **Step 6: 테스트를 돌려 통과를 확인한다**

Run: `cd packages/agent && npx vitest run test/gatekeeperScreens.test.ts`
Expected: PASS (5개)

**Step 3 에서 오판 지점을 찾았다면 여기서 빨개진다.** 그때는 `DEFAULT_READY_PATTERN`
(`pty.ts`)을 그 화면이 거짓이 되도록 좁히고 다시 돌린다 — 단, 스펙 §2-5 는 **판정을
고쳐도 남는다**(다음 관문에 또 진다). Task 3 을 빼지 마라.

- [ ] **Step 7: 스펙을 확정 사실로 갱신한다**

`docs/specs/2026-09-08-tui-attention-design.md` 의 §2-4 머리 인용문에서 "미확정" 문구를
지우고 측정 결과를 적는다. §4 의 항목 1·7 을 `~~취소선~~` + `**확인 완료(날짜)**` 로
바꾼다(항목 5 가 이미 그 형식이다).

- [ ] **Step 8: 커밋**

```bash
git add packages/agent/test/fixtures/claude-tui-onboarding-theme.txt \
        packages/agent/test/fixtures/claude-tui-bypass-warning.txt \
        packages/agent/test/gatekeeperScreens.test.ts \
        docs/specs/2026-09-08-tui-attention-design.md
git commit -m "test(agent): 첫 실행 관문 화면 3종을 실물 픽스처로 고정한다"
```

---

### Task 2: 준비 실패가 PTY 를 죽이지 않는다

스펙 §2-1.

**Files:**
- Modify: `packages/agent/src/pty.ts:296-312`(`injectPrompt` 옵션), `498-528`(준비 상한)
- Modify: `packages/agent/test/helpers/fake-harness.mjs`(관문 모드 추가)
- Test: `packages/agent/test/pty.test.ts`

**Interfaces:**
- Consumes: `RunPtyTurnOptions`(`pty.ts:291`), `PromptNotDeliveredError`(`pty.ts:127`).
- Produces: `RunPtyTurnOptions['injectPrompt']['onAttention']` —
  `(screen: string) => void`. 호출되면 PTY 는 살아 있고, 그 턴은 `runPtyTurn` 의
  프라미스를 **아직 정착시키지 않는다**(exit 또는 회수가 정착시킨다).

- [ ] **Step 1: 가짜 하네스에 관문 모드를 더한다**

`packages/agent/test/helpers/fake-harness.mjs` 끝에:

```js
// 2026-09-08: 첫 실행 관문 흉내. 준비 신호가 **아닌** 화면(승인 메뉴)을 그리고 버틴다.
// 사람이 Enter 를 보내면 그때서야 입력 프롬프트를 그린다 — "사람이 관문을 지나면 그
// 자리에서 주입된다"(스펙 §2-2)의 회귀선이다.
//
// '❯' 뒤가 **보통 공백**인 것이 요점이다: 실물 승인 메뉴가 그 모양이고, 러너의 준비
// 판정은 NBSP(U+00A0) 로 입력창과 메뉴를 가른다. 여기를 NBSP 로 바꾸면 이 픽스처가
// 실물과 다른 성질을 갖게 되고, 테스트는 초록인데 프로덕션은 관문을 준비로 읽는다.
if (mode === 'gatekeeper') {
  process.stdout.write('WARNING: fake gatekeeper\n❯ No, exit\n  Yes, I accept\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    if (!d.includes('\r') && !d.includes('\n')) return;
    // 사람이 관문을 지났다 — 이제 입력 프롬프트를 그린다(NBSP).
    process.stdout.write('\n❯ ');
    process.stdin.on('data', (x) => {
      if (String(x).includes('[201~')) { process.stdout.write(`injected:${x}`); process.exit(0); }
    });
  });
  setTimeout(() => process.exit(23), 20_000); // 안전망
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`packages/agent/test/pty.test.ts` 에 추가:

```ts
describe('준비 상한 — onAttention 이 있으면 죽이지 않는다', () => {
  it('상한을 넘기면 onAttention 을 부르고 PTY 는 살아 있다', async () => {
    const 화면: string[] = [];
    const ring = new RingBuffer(64 * 1024);
    const turn = runPtyTurn(plan('gatekeeper'), {
      cwd: process.cwd(), timeoutMs: 0, ring,
      injectPrompt: { text: '안녕', readyTimeoutMs: 300, onAttention: (s) => 화면.push(s) },
    });

    // 상한이 지나기를 기다린다 — 조건으로 기다린다(고정 슬립은 느린 CI 에서 샌다).
    await vi.waitFor(() => expect(화면).toHaveLength(1), { timeout: 5_000 });
    // 부른 화면에는 관문이 실려 있다 — 데스크탑이 "무엇을 기다리는지" 보여줄 재료다.
    expect(화면[0]).toContain('fake gatekeeper');

    // **PTY 가 살아 있다는 증거**: 사람 흉내로 Enter 를 보내면 하네스가 응답한다.
    // 죽었다면 이 입력은 아무 데도 안 가고 아래 waitFor 가 시간 초과로 빨개진다.
    ptyWriter!.write(Buffer.from('\r'));
    const r = await turn;
    expect(r.exitCode).toBe(0);
    expect(r.tail).toContain('injected:');   // 관문을 지난 뒤 프롬프트가 실제로 들어갔다
  }, 30_000);

  it('onAttention 이 없으면 지금대로 죽고 던진다', async () => {
    await expect(runPtyTurn(plan('gatekeeper'), {
      cwd: process.cwd(), timeoutMs: 0,
      injectPrompt: { text: '안녕', readyTimeoutMs: 300 },
    })).rejects.toBeInstanceOf(PromptNotDeliveredError);
  }, 20_000);
});
```

위 첫 테스트가 `ptyWriter` 를 쓰므로, `onSpawn` 으로 잡는다. `describe` 안에 둔다:

```ts
let ptyWriter: PtyWriter | null = null;
// onSpawn 은 runPtyTurn 옵션이다. 위 호출에 `onSpawn: (c) => { ptyWriter = c; }` 를 더한다.
```

`PromptNotDeliveredError` 와 `vi` 를 import 에 더한다:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { composeSpawn, PromptNotDeliveredError, RingBuffer, resolveExecutable, runPtyTurn, type PtyWriter } from '../src/pty.js';
```

- [ ] **Step 3: 테스트가 실패하는 것을 확인한다**

Run: `cd packages/agent && npx vitest run test/pty.test.ts -t '준비 상한'`
Expected: FAIL — 첫 테스트는 `onAttention` 이 타입에 없어 컴파일 에러이거나,
호출되지 않아 `waitFor` 시간 초과.

- [ ] **Step 4: 옵션에 `onAttention` 을 더한다**

`packages/agent/src/pty.ts` 의 `injectPrompt` 옵션(`:302-308`)에:

```ts
    /** 준비 상한. 넘기면 `PromptNotDeliveredError`. 생략하면 60초. */
    readyTimeoutMs?: number;
    /**
     * 준비 상한을 넘겼을 때 **죽이는 대신 부른다**(2026-09-08).
     *
     * 여기까지 온 화면은 사람 손이 필요한 것이다 — 첫 실행 승인 관문이 대표적이고,
     * 그 목록은 우리 계약이 아니라 하네스의 것이라 열거로 끝나지 않는다(스펙 §1).
     * **그 화면을 죽이면 사람이 열어 볼 대상 자체가 없어진다.**
     *
     * 이것이 있으면 PTY 를 유지하고, `readyProbe` 도 살려 둔다: 사람이 관문을 지나
     * 입력 프롬프트가 그려지는 순간 패턴이 맞아 프롬프트가 그대로 주입된다(스펙 §2-2).
     * 그래서 **사람의 개입이 턴을 대체하지 않고 통과시킨다.**
     *
     * 없으면 지금 동작 그대로다(SIGKILL + PromptNotDeliveredError) — 사람이 붙을 수
     * 없는 호출자(비대화형 프로브, 테스트)의 경로다. 콜백 유무가 두 정책을 가르고,
     * 그래서 플래그를 따로 두지 않는다.
     */
    onAttention?: (screen: string) => void;
```

- [ ] **Step 5: 상한 콜백을 두 갈래로 만든다**

`pty.ts:501-514` 의 `readyTimer` 를 바꾼다:

```ts
      const { text, readyPattern = DEFAULT_READY_PATTERN, readyTimeoutMs = 60_000,
              onAttention } = opts.injectPrompt;
      let injected = false;
      const startedAt = Date.now();
      let readyProbe: NodePty.IDisposable | null = null;
      const readyTimer = setTimeout(() => {
        if (injected || settled) return;
        const screen = decodeTailText(tail.snapshot());
        if (onAttention) {
          // **여기서 아무것도 정착시키지 않는다.** readyProbe 를 그대로 살려 두므로
          // 사람이 관문을 지나면 아래 주입이 일어나고 턴이 이어진다. 이 턴의 끝은
          // exit 또는 고아 회수다 — 인터랙티브 턴과 같은 규칙이다(#337).
          onAttention(screen);
          return;
        }
        // 준비를 못 봤고 부를 사람도 없다 — 이 턴은 프롬프트 없이 도는 것이 아니라 실패다.
        readyProbe?.dispose();
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        dataListener.dispose();
        exitListener.dispose();
        try { proc.kill('SIGKILL'); } catch { /* 이미 죽었으면 회수할 것도 없다 */ }
        reject(new PromptNotDeliveredError(Date.now() - startedAt, screen));
      }, readyTimeoutMs);
```

- [ ] **Step 6: 테스트가 통과하는 것을 확인한다**

Run: `cd packages/agent && npx vitest run test/pty.test.ts`
Expected: PASS (기존 테스트 포함 전부)

- [ ] **Step 7: 커밋**

```bash
git add packages/agent/src/pty.ts packages/agent/test/pty.test.ts \
        packages/agent/test/helpers/fake-harness.mjs
git commit -m "feat(agent): 준비 상한이 onAttention 이 있으면 PTY 를 죽이지 않는다"
```

---

### Task 3: 주입이 먹혔는지 재는 확인 창

스펙 §2-5. **Task 2 만으로는 오늘의 30분 무발화가 안 잡힌다** — 그 턴들은 준비 신호를
`true` 로 봤으므로 상한에 닿지도 않았다.

**Files:**
- Modify: `packages/agent/src/pty.ts`(`injectPrompt` 옵션 + 주입 직후 확인 창)
- Test: `packages/agent/test/pty.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `onAttention: (screen: string) => void`.
- Produces: `injectPrompt.confirmDelivery?: { probe: () => boolean | Promise<boolean>;
  withinMs?: number }`. `probe` 가 "대화가 시작됐다"를 판정한다. 생략하면 확인 창 자체가
  없다(기존 동작).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/pty.test.ts` 에 추가:

```ts
describe('주입 확인 창 — 준비 신호만으로는 부족하다', () => {
  it('주입 뒤 증거가 없으면 onAttention 을 부른다', async () => {
    // 'ready-then-echo' 는 준비 신호를 찍고 주입을 받아 되뱉는다 — 즉 **주입은 먹었다**.
    // 그런데 probe 가 거짓이면(대화가 시작된 증거가 없으면) 사람을 불러야 한다.
    // 2026-09-08 프로덕션이 정확히 이 모양이었다: 준비로 읽고, 주입하고, 세션 파일은
    // 안 생기고, 30분을 태웠다.
    const 화면: string[] = [];
    await runPtyTurn(plan('ready-then-echo'), {
      cwd: process.cwd(), timeoutMs: 10_000,
      injectPrompt: {
        text: '안녕',
        confirmDelivery: { probe: () => false, withinMs: 300 },
        onAttention: (s) => 화면.push(s),
      },
    });
    expect(화면).toHaveLength(1);
  }, 20_000);

  it('증거가 있으면 부르지 않는다', async () => {
    const 화면: string[] = [];
    await runPtyTurn(plan('ready-then-echo'), {
      cwd: process.cwd(), timeoutMs: 10_000,
      injectPrompt: {
        text: '안녕',
        confirmDelivery: { probe: () => true, withinMs: 300 },
        onAttention: (s) => 화면.push(s),
      },
    });
    expect(화면).toHaveLength(0);
  }, 20_000);

  it('confirmDelivery 가 없으면 확인 창도 없다 — 기존 호출자는 그대로다', async () => {
    const 화면: string[] = [];
    const r = await runPtyTurn(plan('ready-then-echo'), {
      cwd: process.cwd(), timeoutMs: 10_000,
      injectPrompt: { text: '안녕', onAttention: (s) => 화면.push(s) },
    });
    expect(r.exitCode).toBe(0);
    expect(화면).toHaveLength(0);
  }, 20_000);
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `cd packages/agent && npx vitest run test/pty.test.ts -t '주입 확인 창'`
Expected: FAIL — `confirmDelivery` 가 타입에 없다.

- [ ] **Step 3: 옵션과 확인 창을 구현한다**

`pty.ts` 의 `injectPrompt` 옵션에:

```ts
    /**
     * 주입이 **먹혔는지** 재는 확인 창(2026-09-08, 스펙 §2-5).
     *
     * 준비 신호는 "화면이 입력을 받을 모양이다"까지만 말한다. 판정이 오판하면 프롬프트가
     * 관문에 타이핑되고, 그 턴은 상한에도 안 걸린 채 무발화 한도까지 간다 — 실측 12~30분.
     * 판정을 정교하게 만드는 것으로는 못 막는다(관문이 늘 때마다 지는 싸움이다).
     *
     * `probe` 는 "대화가 실제로 시작됐다"를 판정한다. 러너는 세션 JSONL 의 존재를 쓴다 —
     * 화면 문자열로 재면 하네스 버전에 묶이지만, 파일 생성은 사실 자체다.
     *
     * 생략하면 확인 창이 없다(기존 호출자 그대로).
     */
    confirmDelivery?: {
      probe: () => boolean | Promise<boolean>;
      /** 주입부터 증거까지 허용할 시간. 생략하면 15초(스펙 §2-5). */
      withinMs?: number;
    };
```

주입 직후(`readyProbe` 콜백의 `proc.write('\r')` 다음)에:

```ts
        // 주입이 **먹혔는지** 확인한다(스펙 §2-5). 여기서도 아무것도 정착시키지 않는다 —
        // 사람을 부를 뿐이고, readyProbe 는 이미 소임을 다해 dispose 됐다.
        const confirm = opts.injectPrompt?.confirmDelivery;
        if (confirm && onAttention) {
          const timer = setTimeout(() => {
            if (settled) return;
            void (async () => {
              let ok = false;
              try { ok = await confirm.probe(); } catch { ok = false; }
              // 프로브가 던지면 "증거 없음"으로 읽는다 — 사람을 부르는 쪽이 안전하다.
              // 반대로 읽으면 오늘처럼 조용히 태운다.
              if (!ok && !settled) onAttention(decodeTailText(tail.snapshot()));
            })();
          }, confirm.withinMs ?? 15_000);
          timer.unref?.();
        }
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `cd packages/agent && npx vitest run test/pty.test.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/pty.ts packages/agent/test/pty.test.ts
git commit -m "feat(agent): 주입이 먹혔는지 재는 확인 창을 둔다"
```

---

### Task 4: 릴레이 계약 — 프레임과 이벤트

스펙 §3-1, §3-2.

**Files:**
- Modify: `packages/shared/src/index.ts:1726`(`RunnerCap`), `:1735`(`RelayRunnerFrame`),
  `:1550`(`WsServerEvent`)
- Modify: `packages/server/src/events.ts`
- Test: `packages/shared/test/` 의 기존 계약 테스트 파일(없으면
  `packages/shared/test/relayFrames.test.ts` 생성)

**Interfaces:**
- Produces:
  - `RunnerCap` 에 `'attention'` 추가.
  - `RelayRunnerFrame` 에
    `{ type: 'attention.required'; sessionId: string; accountLabel: string; screen: string }`.
    `screen` 은 **base64**.
  - `WsServerEvent` 에
    `{ type: 'agent.attention'; sessionId: string; channelId: string;
       threadRootId: string | null; agentHandle: string; accountLabel: string }`.

- [ ] **Step 1: 타입을 더한다**

`packages/shared/src/index.ts` — `RunnerCap`:

```ts
export type RunnerCap = 'input' | 'interactive' | 'handoff' | 'attention';
```

`RelayRunnerFrame` 의 마지막 항목 뒤에:

```ts
  /**
   * 이 세션이 **사람 손을 기다린다**(2026-09-08). 러너가 준비 신호를 상한 안에 못
   * 봤거나(첫 실행 승인 관문), 주입이 먹지 않았고 — **계정 풀을 다 태운 뒤**다. 즉
   * 이 화면은 다른 계정으로 우회되지 않는다.
   *
   * `interactive.opened` 와 프레임을 가른 이유는 `interactive.reserved` 를 가른 이유와
   * 같다: "사람이 열었다"와 "기계가 부른다"는 사람이 다음에 할 일이 다르다. 전자는 이미
   * 사람이 앞에 있고, 후자는 **아직 아무도 모른다** — 그래서 후자만 앱이 화면을 띄운다.
   *
   * `screen` 은 `output` 과 **같은 규율로 base64** 다. 서버는 열지 않는다: 관문 화면에도
   * 계정 이메일 같은 것이 실린다.
   */
  | { type: 'attention.required'; sessionId: string; accountLabel: string; screen: string };
```

`WsServerEvent` 에:

```ts
  /**
   * 에이전트 세션이 사람 손을 기다린다(2026-09-08). 데스크탑이 그 스레드의 터미널
   * 패널을 연다 — 사람은 [터미널 열기]를 누를 이유조차 모르는 상태이므로, 앱이 먼저
   * 말해야 한다. `accountLabel` 은 "어느 계정이 막혔는지"를 사람에게 보여줄 재료다.
   */
  | { type: 'agent.attention'; sessionId: string; channelId: string;
      threadRootId: string | null; agentHandle: string; accountLabel: string }
```

`packages/server/src/events.ts` 의 같은 유니온에도 같은 항목을 더한다(그 파일이 서버
쪽 발행 타입을 따로 갖는다).

- [ ] **Step 2: 계약 테스트를 쓴다**

`packages/shared/test/relayFrames.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { RelayRunnerFrame, RunnerCap, WsServerEvent } from '../src/index.js';

describe('attention 계약', () => {
  it('프레임이 세션과 화면을 함께 싣는다', () => {
    const f: RelayRunnerFrame = {
      type: 'attention.required',
      sessionId: 's1',
      accountLabel: 'aria',
      screen: Buffer.from('WARNING').toString('base64'),
    };
    expect(f.type).toBe('attention.required');
    // base64 규율: 서버가 열지 않는다는 계약을 타입이 아니라 이 단언이 지킨다.
    expect(Buffer.from(f.screen, 'base64').toString('utf8')).toBe('WARNING');
  });

  it("능력 문자열이 'attention' 이다", () => {
    const cap: RunnerCap = 'attention';
    expect(cap).toBe('attention');
  });

  it('데스크탑 이벤트가 스레드를 가리킨다 — 세션만으로는 패널을 못 연다', () => {
    const e: WsServerEvent = {
      type: 'agent.attention', sessionId: 's1', channelId: 'c1',
      threadRootId: 't1', agentHandle: 'murmur', accountLabel: 'aria',
    };
    expect(e.channelId).toBe('c1');
  });
});
```

- [ ] **Step 3: 테스트를 돌린다**

Run: `cd packages/shared && npx vitest run test/relayFrames.test.ts`
Expected: PASS

- [ ] **Step 4: 커밋**

```bash
git add packages/shared/src/index.ts packages/shared/test/relayFrames.test.ts \
        packages/server/src/events.ts
git commit -m "feat(shared): attention.required 프레임과 agent.attention 이벤트를 더한다"
```

---

### Task 5: 러너가 부른다 — 계정 축 뒤에, 계정당 하나

스펙 §2-3, §2-4. **Task 1 Step 2 의 결과가 ③을 워크스페이스 단위로 판정했다면 이
태스크를 시작하기 전에 멈추고 보고한다.**

**Files:**
- Modify: `packages/agent/src/relay.ts:34`(`RUNNER_CAPS`), `OpenSession` 인터페이스,
  `openSession` 구현
- Create: `packages/agent/src/attentionLedger.ts`
- Modify: `packages/agent/src/mentionTurn.ts:748-760`(`runTurn` 옵션 조립)
- Test: `packages/agent/test/attentionLedger.test.ts`

**Interfaces:**
- Consumes:
  - Task 2 의 `injectPrompt.onAttention: (screen: string) => void`
  - Task 3 의 `injectPrompt.confirmDelivery: { probe: () => boolean | Promise<boolean>;
    withinMs?: number }`
  - Task 4 의 `attention.required` 프레임과 `RunnerCap` 의 `'attention'`
  - 기존 `mentionTurn.ts` 의 고아 회수 유예 `deps.orphanMs ?? 60_000`(`:690`)
- Produces:
  - `attentionLedger.ts`: `createAttentionLedger(): AttentionLedger`,
    `interface AttentionLedger { claim(accountLabel: string, sessionId: string): boolean;
    release(accountLabel: string): void; }`
    — `claim` 은 **처음 부르는 계정에만 true** 를 준다.
  - `OpenSession.needsAttention(screen: string, accountLabel: string): void` —
    `screen` 을 base64 로 감싸 `attention.required` 를 쏜다.
  - `harnessErrors.ts`: `sessionTranscriptExists(configDir: string, sessionId: string): boolean`
  - `mentionTurn.ts` 의 `deps` 에 두 필드:
    `accountLabel?: string`(풀 미구성이면 `undefined` → `'(기본)'` 으로 읽는다),
    `attentionLedger: AttentionLedger`

- [ ] **Step 1: 원장의 실패하는 테스트를 쓴다**

`packages/agent/test/attentionLedger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createAttentionLedger } from '../src/attentionLedger.js';

// 관문은 계정 단위다(스펙 §2-4, Task 1 실측). 한 번 지나면 그 계정의 나머지 턴이
// 풀리므로, 같은 계정으로 창을 여러 개 띄우면 사람이 같은 승인을 여러 번 한다 —
// 2026-09-08 에 7개 스레드가 동시에 걸렸다.
describe('attention 원장', () => {
  it('같은 계정은 한 번만 부른다', () => {
    const l = createAttentionLedger();
    expect(l.claim('aria', 's1')).toBe(true);
    expect(l.claim('aria', 's2')).toBe(false);
  });

  it('계정이 다르면 각각 부른다 — 관문은 계정마다 따로다', () => {
    const l = createAttentionLedger();
    expect(l.claim('aria', 's1')).toBe(true);
    expect(l.claim('cedar', 's2')).toBe(true);
  });

  it('놓으면 다시 부를 수 있다 — 다음 관문(④)은 또 사람이 필요하다', () => {
    const l = createAttentionLedger();
    l.claim('aria', 's1');
    l.release('aria');
    expect(l.claim('aria', 's2')).toBe(true);
  });

  it('계정 이름이 없는 러너(풀 미구성)도 한 번은 부른다', () => {
    // 계정 풀을 안 만든 러너의 경로다. 라벨이 없다고 사람을 못 부르면, 그 러너는
    // 관문에 걸렸을 때 아무 말도 못 한다.
    const l = createAttentionLedger();
    expect(l.claim('(기본)', 's1')).toBe(true);
    expect(l.claim('(기본)', 's2')).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `cd packages/agent && npx vitest run test/attentionLedger.test.ts`
Expected: FAIL — 모듈이 없다.

- [ ] **Step 3: 원장을 만든다**

`packages/agent/src/attentionLedger.ts`:

```ts
/**
 * 어느 계정으로 이미 사람을 불렀는지 기억한다(2026-09-08, 스펙 §2-4).
 *
 * **왜 계정 단위인가.** 첫 실행 관문은 계정 설정(`CLAUDE_CONFIG_DIR`)에 기록되므로 한
 * 번 지나면 그 계정의 나머지 턴이 풀린다. 스레드마다 부르면 사람이 같은 승인을 반복한다 —
 * 2026-09-08 에 7개 스레드가 동시에 걸렸고, 그대로였다면 창이 7개 떴다.
 *
 * **왜 러너 안의 Map 인가.** 이 사실은 러너 프로세스보다 오래 살 필요가 없다. 러너가
 * 다시 뜨면 관문도 다시 재는 것이 맞다 — 디스크에 남기면 "예전에 불렀다"가 사람이 그
 * 승인을 실제로 했다는 뜻으로 잘못 굳는다.
 */
export interface AttentionLedger {
  /** 이 계정으로 처음 부르는가. true 면 부른다. */
  claim(accountLabel: string, sessionId: string): boolean;
  /** 그 계정의 부름을 놓는다(세션 종료). 다음 관문은 다시 부를 수 있다. */
  release(accountLabel: string): void;
}

export function createAttentionLedger(): AttentionLedger {
  const held = new Map<string, string>();
  return {
    claim(accountLabel, sessionId) {
      if (held.has(accountLabel)) return false;
      held.set(accountLabel, sessionId);
      return true;
    },
    release(accountLabel) {
      held.delete(accountLabel);
    },
  };
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `cd packages/agent && npx vitest run test/attentionLedger.test.ts`
Expected: PASS (4개)

- [ ] **Step 5: 릴레이에 프레임 전송을 더한다**

`packages/agent/src/relay.ts`:

```ts
export const RUNNER_CAPS: readonly RunnerCap[] = ['input', 'interactive', 'handoff', 'attention'];
```

`OpenSession` 인터페이스에:

```ts
  /**
   * 이 세션이 사람 손을 기다린다(2026-09-08). `screen` 은 화면 tail 이고, 여기서
   * base64 로 감싸 보낸다 — 호출자는 그 규율을 몰라도 된다.
   */
  needsAttention(screen: string, accountLabel: string): void;
```

`openSession` 구현(`:347` 부근)의 반환 객체에:

```ts
      needsAttention(screen, accountLabel) {
        send({
          type: 'attention.required',
          sessionId: info.sessionId,
          accountLabel,
          screen: Buffer.from(screen, 'utf8').toString('base64'),
        });
      },
```

- [ ] **Step 6: 멘션 턴에 배선한다**

`packages/agent/src/mentionTurn.ts` 의 `runTurn` 옵션(`:757` 의 `injectPrompt` 자리)을
바꾼다:

```ts
      ...(usesTui ? {
        injectPrompt: {
          text: prompt,
          // 주입이 **먹혔는지**도 잰다(스펙 §2-5). 증거는 세션 JSONL 의 존재다 —
          // 화면 문자열로 재면 하네스 버전에 묶이지만, 파일 생성은 사실 자체다.
          confirmDelivery: {
            probe: () => sessionTranscriptExists(deps.claudeConfigDir, rec.sessionId),
          },
          // **사람 부르기는 마지막 수단이다**(스펙 §2-3). 여기까지 왔다는 것은
          // `withAccountFailover` 가 풀을 다 태웠다는 뜻이다 — 준비 실패는 계정 전환
          // 방아쇠이므로(claudeAccounts.ts:140), 마지막 계정이 아니면 이 콜백이 아니라
          // 그 전환이 먼저 일어난다.
          onAttention: (screen: string) => {
            const label = deps.accountLabel ?? '(기본)';
            if (!deps.attentionLedger.claim(label, rec.sessionId)) return;
            session?.needsAttention(screen, label);
          },
        },
      } : {}),
```

`sessionTranscriptExists` 를 `packages/agent/src/harnessErrors.ts` 에 더한다 —
그 파일이 이미 `<configDir>/projects/*/<sid>.jsonl` 경로를 안다:

```ts
/**
 * 이 세션의 대화 기록 파일이 존재하는가 — 즉 **대화가 실제로 시작됐는가**(스펙 §2-5).
 *
 * `readLastApiError` 와 같은 경로를 본다. 내용을 읽지 않는 이유: 여기서 필요한 것은
 * "무엇을 말했나"가 아니라 "말이 시작됐나" 하나뿐이고, 그 판정은 빠르고 틀릴 수 없어야
 * 한다(주입 직후 15초 안에 불린다).
 */
export function sessionTranscriptExists(configDir: string, sessionId: string): boolean
```

- [ ] **Step 7: 원장을 러너 기동부에 배선한다**

`packages/agent/src/main.ts` 에서 `createAttentionLedger()` 를 한 번 만들어
멘션 턴 deps 로 넘긴다. 세션이 닫힐 때 `release` 를 부른다(`OpenSession.close` 옆).

- [x] **Step 8: ~~회수 유예를 늘린다~~ — 코드를 읽어 보니 필요 없다**

계획을 쓸 때 §2-6 이 "기계가 불러서 뷰어가 0 에서 시작하므로 유예를 따로 둔다"고 했는데,
실제 코드는 **이미 옳게 동작한다**:

- `reconsiderEnd` 의 회수 예약은 `end.spoke` 가 참일 때만 걸린다. 사람을 부른 턴은 아직
  발화하지 않았으므로 애초에 예약되지 않는다 — 60초 유예에 걸릴 일이 없다.
- 그 턴의 끝을 잡는 것은 무발화 시계(`turnTimeoutMs`, 기본 30분)이고, 그 시계는
  `end.viewers > 0` 이면 그냥 지나간다. **사람이 오면 살아남고, 아무도 안 오면 30분 뒤
  회수된다** — §2-6 이 원한 것이 정확히 이것이다.

그래서 새 유예 값(`attentionOrphanMs`)을 만들지 않는다. 값을 하나 더 두면 "무발화 30분"과
"부름 유예 10분" 중 어느 것이 먼저인지를 다음 사람이 매번 다시 따져야 한다.

- [ ] **Step 9: 전체 테스트를 돌린다**

Run: `cd packages/agent && npx vitest run`
Expected: PASS (기존 548 + 새 테스트)

- [ ] **Step 10: 커밋**

```bash
git add packages/agent/src/attentionLedger.ts packages/agent/src/relay.ts \
        packages/agent/src/mentionTurn.ts packages/agent/src/harnessErrors.ts \
        packages/agent/src/main.ts packages/agent/test/attentionLedger.test.ts \
        packages/agent/test/mentionTurn.test.ts
git commit -m "feat(agent): 계정 축을 다 태운 뒤 계정당 한 번만 사람을 부른다"
```

---

### Task 6: 서버가 중계한다

스펙 §3-2.

**Files:**
- Modify: `packages/server/src/ws/relay.ts`(러너 프레임 처리)
- Test: `packages/server/test/` 의 릴레이 테스트 파일

**Interfaces:**
- Consumes: Task 4 의 `attention.required` 프레임과 `agent.attention` 이벤트.
- Produces: 러너 프레임을 받아 그 세션의 **소유 계정에게만** `agent.attention` 을 쏜다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

기존 릴레이 테스트 파일에 추가(파일명은 `packages/server/test/` 에서
`relay` 를 포함하는 것을 쓴다):

```ts
it('attention.required 를 받으면 소유자에게 agent.attention 을 쏜다', async () => {
  // 세션이 먼저 등록돼 있어야 채널·스레드를 알 수 있다 — session.started 가 항상
  // 먼저 온다는 순서 보장에 기댄다(RelayRunnerFrame 주석).
  hub.onRunnerFrame(runner, { type: 'session.started', session: 세션뷰 });
  hub.onRunnerFrame(runner, {
    type: 'attention.required', sessionId: 세션뷰.sessionId,
    accountLabel: 'aria', screen: Buffer.from('WARNING').toString('base64'),
  });
  expect(발행된이벤트).toContainEqual(expect.objectContaining({
    type: 'agent.attention',
    sessionId: 세션뷰.sessionId,
    channelId: 세션뷰.channelId,
    accountLabel: 'aria',
  }));
});

it('세션을 모르면 아무것도 쏘지 않는다 — 채널을 모르면 패널을 못 연다', () => {
  hub.onRunnerFrame(runner, {
    type: 'attention.required', sessionId: '모르는세션',
    accountLabel: 'aria', screen: '',
  });
  expect(발행된이벤트).toHaveLength(0);
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `cd packages/server && npx vitest run -t 'attention'`
Expected: FAIL — 프레임이 처리되지 않아 이벤트가 안 나온다.

- [ ] **Step 3: 프레임 처리를 더한다**

`packages/server/src/ws/relay.ts` 의 러너 프레임 `switch` 에:

```ts
      case 'attention.required': {
        const s = sessions.get(frame.sessionId);
        // 세션을 모르면 채널·스레드를 알 수 없고, 그러면 데스크탑이 열 패널이 없다.
        // 조용히 버린다 — 없는 것을 있다고 표시하지 않는다.
        if (!s) break;
        // **화면 바이트는 여기서 열지 않는다.** `output` 과 같은 규율이다. 데스크탑이
        // 필요하면 attach 해서 ring 재생으로 본다.
        publish({
          type: 'agent.attention',
          sessionId: s.sessionId,
          channelId: s.channelId,
          threadRootId: s.threadRootId,
          agentHandle: handleOf(s.agentAccountId),
          accountLabel: frame.accountLabel,
        }, [ownerOf(s.agentAccountId)]);
        break;
      }
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `cd packages/server && npx vitest run`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add packages/server/src/ws/relay.ts packages/server/test/
git commit -m "feat(server): attention.required 를 소유자의 agent.attention 으로 중계한다"
```

---

### Task 7: 앱이 터미널을 자동으로 연다

스펙 §3-3.

**Files:**
- Modify: `packages/desktop/src/state/controller.ts:410`(이벤트 `case` 목록)
- Test: `packages/desktop/test/` 의 컨트롤러 테스트

**Interfaces:**
- Consumes: Task 4 의 `agent.attention` 이벤트, 기존 `api.attachAgentSession(sessionId)`
  (`packages/desktop/src/lib/api.ts:360`).
- Produces: 없음(종단).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it('agent.attention 을 받으면 그 스레드의 터미널을 연다', async () => {
  await controller.handleEvent({
    type: 'agent.attention', sessionId: 's1', channelId: 'c1',
    threadRootId: 't1', agentHandle: 'murmur', accountLabel: 'aria',
  });
  expect(api.attachAgentSession).toHaveBeenCalledWith('s1');
});

it('이미 그 세션의 패널이 열려 있으면 다시 열지 않는다', async () => {
  state.openTerminalSessionId = 's1';
  await controller.handleEvent({
    type: 'agent.attention', sessionId: 's1', channelId: 'c1',
    threadRootId: 't1', agentHandle: 'murmur', accountLabel: 'aria',
  });
  expect(api.attachAgentSession).not.toHaveBeenCalled();
});

it('창이 백그라운드면 알림만 띄운다 — 남의 화면 앞으로 끌어내지 않는다', async () => {
  state.windowFocused = false;
  await controller.handleEvent({
    type: 'agent.attention', sessionId: 's1', channelId: 'c1',
    threadRootId: 't1', agentHandle: 'murmur', accountLabel: 'aria',
  });
  expect(api.attachAgentSession).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(expect.stringContaining('murmur'));
});
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `cd packages/desktop && npx vitest run -t 'agent.attention'`
Expected: FAIL — `case` 가 없어 아무 일도 안 일어난다.

- [ ] **Step 3: 이벤트 처리를 더한다**

`packages/desktop/src/state/controller.ts` 의 `switch` 에:

```ts
      case 'agent.attention': {
        // 사람은 [터미널 열기]를 누를 이유조차 모르는 상태다 — 관문에 걸린 턴은
        // 화면에 아무 신호도 남기지 않는다. 그래서 앱이 먼저 연다.
        if (state.openTerminalSessionId === ev.sessionId) break;
        if (!state.windowFocused) {
          // 창을 남의 작업 앞으로 끌어내지 않는다. 사람이 누를 때 연다.
          notify(`${ev.agentHandle} 가 승인을 기다립니다 (${ev.accountLabel})`);
          break;
        }
        void openTerminalForSession(ev.sessionId, ev.channelId, ev.threadRootId);
        break;
      }
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `cd packages/desktop && npx vitest run`
Expected: PASS

- [ ] **Step 5: 워크스페이스 전체 테스트**

Run: `pnpm -r test`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add packages/desktop/src/state/controller.ts packages/desktop/test/
git commit -m "feat(desktop): 에이전트가 사람을 부르면 터미널을 자동으로 연다"
```

---

## 머지 전 실물 확인

스펙 §4 의 남은 항목이다. **단위 테스트가 전부 초록인 것으로는 이 층이 보증되지 않는다** —
2026-09-08 에 583개 초록 아래에서 준비 패턴이 한 번도 안 맞았다.

- [ ] 관문에 걸린 턴에서 앱의 터미널이 **자동으로 뜨는가**(Task 7 종단).
- [ ] 그 터미널에서 사람이 승인하면 **프롬프트가 주입되고 답이 스레드에 오는가**
      (스펙 §2-2 — 이 설계 값의 대부분).
- [ ] 같은 계정의 다른 스레드 턴이 **창을 더 띄우지 않고** 풀리는가(§2-4).
- [ ] 주입 확인 창 15초가 정상 턴을 오인하지 않는가(§4-6). 오인하면 값을 올린다.
