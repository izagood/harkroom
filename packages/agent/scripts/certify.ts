// `certify` — 하네스 하나가 **계약을 실제로 만족하는지 실물로 재는** 명령.
//
//     pnpm --filter @harkroom/agent certify -- <harness> [--turn] [--isolated]
//
// ## 왜 이것이 필요한가
//
// `RUNNABLE_HARNESSES` 에 들어가는 기준은 이 저장소가 이미 정해 뒀다 — *"실물 CLI 로 첫 턴
// + resume 왕복이 도는 것을 봤는가"*. 그런데 **그 확인이 사람 손이다.** 누가 언제 무엇을
// 봤는지가 커밋 메시지와 주석에만 남고, 하네스가 판을 올리면 다시 손으로 확인해야 한다.
// 하네스를 여럿 붙이려면 그 확인이 명령 하나여야 한다.
//
// ## 무엇을 재는가 — 계약의 T0 네 요구
//
// murmur 가 하네스에 요구하는 것은 넷뿐이다(하네스 출력을 파싱하지 않기 때문이다 —
// 발화·진행·중단은 에이전트가 murmur MCP 로 직접 한다):
//
//   1. TUI 로 뜬다
//   2. 준비 신호를 화면에 낸다        ← `boot` 단계
//   3. bracketed paste 로 프롬프트를 받는다  ← `--turn` 단계
//   4. MCP 서버 하나를 붙일 수 있다    ← 아직 이 스크립트의 범위 밖(아래 "아직 안 하는 것")
//
// ## 프로덕션 코드로 잰다 — 베끼지 않는다
//
// 부팅 대기·준비 판정·붙여넣기 주입을 여기서 다시 구현하지 않고 `runPtyTurn` 과
// `looksReadyForPrompt` 를 **그대로 부른다**. 베끼면 사본만 초록인 상태가 만들어지고, 그것은
// 이 저장소가 이미 여러 번 지목한 실패 모양이다(`pty.ts` 가 판정 함수를 export 하는 이유가
// 같다). 그래서 이 스크립트가 초록이면 "프로덕션 경로가 이 하네스에서 돈다"는 뜻이 된다.
//
// ## 아직 안 하는 것 (지어내지 않는다)
//
// resume 왕복 · 세션 id 발견 · MCP 등록과 격리 · `readonly` 권한 수단. 앞의 둘은 `--turn`
// 이 만든 세션 위에서만 잴 수 있고, 뒤의 둘은 하네스마다 **수단 자체가 다른 층**이라
// (`mcpRegistration` 의 세 갈래) 이 스크립트보다 어댑터가 먼저 답해야 한다.
// 목록과 근거: `docs/specs/2026-09-11-opencode-measurement.md` §4.
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_HARNESSES, type AgentHarness } from '@harkroom/shared';

import { adapterFor } from '../src/adapters/index.js';
import { looksReadyForPrompt, runPtyTurn, type PtyControls } from '../src/pty.js';
import { ensureWorkspaceTrusted } from '../src/workspaceTrust.js';
import type { TurnPlan } from '../src/turn.js';

/**
 * 부팅 상한. 넉넉히 두고 **실제로 걸린 시간을 보고한다** — 상한은 "실패로 접는 선"이고,
 * 사람이 알고 싶은 것은 걸린 시간이다. 실측(이 스크립트로): claude 0.3초, opencode 2.5초.
 */
const READY_TIMEOUT_MS = 90_000;

/** 화면을 사람이 읽게 만든다. 판정에는 안 쓴다 — 판정은 `looksReadyForPrompt` 가 한다. */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][0-9]*;[^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b[()][AB012]/g, '');
}

interface Check {
  name: string;
  ok: boolean;
  /** 사람이 읽을 한 줄. 실패했을 때 **무엇을 봤는지**가 여기 들어가야 쓸모가 있다. */
  detail: string;
}

function usage(): never {
  console.error(
    `사용법: certify <harness> [--turn] [--isolated]\n` +
      `  harness     ${AGENT_HARNESSES.join(' | ')}\n` +
      `  --turn      프롬프트를 실제로 주입한다 (모델을 부른다 — 비용과 인증이 필요하다)\n` +
      `  --isolated  어댑터가 말한 계정 축 환경변수를 빈 디렉터리로 덮어 띄운다\n` +
      `              (격리 홈에서도 뜨는지. **로그인이 안 따라가면 실패하는 것이 정상이다**)`,
  );
  process.exit(2);
}

/**
 * 어댑터가 말한 계정 축을 **빈 자리로** 돌린다.
 *
 * 축이 여럿인 하네스(opencode 의 XDG 셋)에서 **하나만 덮으면 반쪽 격리**가 된다 —
 * 자격증명은 갈리는데 세션은 공유되고, 그 상태는 조용하다. 그래서 목록을 통째로 덮는다.
 */
function isolatedEnv(harness: AgentHarness, root: string): Record<string, string> {
  const axis = adapterFor(harness).account;
  if (axis === null) return {};
  return Object.fromEntries(axis.configDirEnv.map((key) => [key, join(root, key.toLowerCase())]));
}

async function certify(
  harness: AgentHarness,
  opts: { turn: boolean; isolated: boolean },
  reportScreen: (screen: string) => void,
): Promise<Check[]> {
  const adapter = adapterFor(harness);
  const checks: Check[] = [];
  const root = await mkdtemp(join(tmpdir(), `certify-${harness}-`));
  // **realpath 로 편다.** macOS 의 `/var` 는 `/private/var` 로 가는 심볼릭 링크이고,
  // 하네스는 신뢰 장부를 **자기가 해석한 경로**로 찾는다. 펴지 않으면 우리가
  // `/var/...` 키로 적고 claude 는 `/private/var/...` 로 찾아 대화상자가 그대로 뜬다 —
  // 첫 실행에서 정확히 그렇게 물렸다(화면에 "Quick safety check" 가 떴다).
  const cwd = await realpath(root).then((r) => join(r, 'workspace'));
  // **`mkdtemp` 가 아니라 `mkdir` 이다.** 앞 판본이 `mkdtemp(cwd)` 를 불렀는데 그것은
  // 접두사를 받아 `workspaceXXXX` 를 만든다 — `cwd` 자체는 없는 채로 PTY 를 띄웠고,
  // 하네스는 한 바이트도 못 내고 죽었다(화면 0바이트). 첫 실행에서 그대로 물렸다.
  await mkdir(cwd, { recursive: true });

  const plan: TurnPlan = {
    command: adapter.command,
    // **인자 없이 띄운다.** 이 단계가 재는 것은 "TUI 로 뜨고 준비 신호를 내는가" 하나이고,
    // argv 조립은 아직 없을 수도 있다(`PRESETS` 가 'unsupported' 인 하네스가 그렇다).
    args: [],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
      ...(opts.isolated ? isolatedEnv(harness, root) : {}),
    },
    // TUI 다 — fd 0 이 PTY 여야 사람이 칠 수 있고, 주입도 그 위에서 된다.
    stdinFile: null,
  };

  /**
   * **러너가 PTY 를 띄우기 전에 하는 일을 여기서도 한다.**
   *
   * 첫 실행에서 claude 가 90초를 못 넘겼다(화면 1373바이트). 프로덕션은 spawn 전에
   * `ensureWorkspaceTrusted` 로 신뢰를 적어 두는데 이 스크립트가 그 단계를 빠뜨렸기
   * 때문이다 — 그러면 신뢰 대화상자가 화면을 덮고, 러너는 사람이 아니라 답할 수 없다.
   *
   * 이 한 줄이 빠졌을 때 나온 실패가 **사람이 손으로 확인할 때 정확히 겪는 실패**라는
   * 점이 이 스크립트의 존재 이유를 그대로 보여 준다. 신뢰 장부가 없는 하네스
   * (`trust: null`)에는 아무것도 안 한다 — 그 판단도 어댑터가 한다.
   */
  await ensureWorkspaceTrusted({
    harness,
    workspaceDir: cwd,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    codexHome: process.env.CODEX_HOME ?? join(root, 'codex-home'),
  });

  let seen = Buffer.alloc(0);
  let readyAtMs: number | null = null;
  let controls: PtyControls | null = null;
  const startedMs = Date.now();

  const result = await runPtyTurn(plan, {
    cwd,
    // 준비를 본 뒤 우리가 직접 끊는다 — 시계에 맡기면 "왜 끝났는지"가 흐려진다.
    timeoutMs: opts.turn ? 180_000 : READY_TIMEOUT_MS + 15_000,
    onSpawn: (c) => { controls = c; },
    onData: (chunk) => {
      seen = Buffer.concat([seen, chunk]);
      if (readyAtMs !== null) return;
      // **프로덕션 판정을 그대로 부른다**(패턴만 어댑터에서 온다).
      if (!looksReadyForPrompt(seen.toString('utf8'), adapter.screen.ready)) return;
      readyAtMs = Date.now();
      // 주입 단계가 아니면 준비를 본 순간이 이 검사의 끝이다. 중단 수단도 여기서 함께 잰다.
      if (!opts.turn) controls?.kill('SIGTERM');
    },
    ...(opts.turn
      ? {
          injectPrompt: {
            // 모델을 부르되 **가장 짧게** 부른다. 재는 것은 답의 내용이 아니라 주입이 닿았는가다.
            text: 'Reply with exactly: CERTIFY_OK',
            readyPattern: adapter.screen.ready,
            readyTimeoutMs: READY_TIMEOUT_MS,
          },
        }
      : {}),
  }).catch((err: unknown) => {
    // `PromptNotDeliveredError` 도 여기로 온다 — 준비를 못 본 것이고, 그 사실이 곧 결과다.
    checks.push({ name: '턴 실행', ok: false, detail: err instanceof Error ? err.message : String(err) });
    return null;
  });

  checks.unshift({
    name: 'TUI 준비 신호',
    ok: readyAtMs !== null,
    detail: readyAtMs !== null
      ? `${((readyAtMs - startedMs) / 1000).toFixed(1)}초 만에 ${adapter.screen.ready} 를 봤다`
      : `${READY_TIMEOUT_MS / 1000}초 안에 ${adapter.screen.ready} 를 못 봤다`
        + ` (화면 ${seen.length}바이트${result ? `, 종료 코드 ${result.exitCode}` : ''})`
        // 0바이트 + 즉시 종료는 "준비 신호가 틀렸다"가 아니라 **뜨지도 못했다**는 뜻이다.
        // 그 둘을 한 문장으로 뭉뚱그리면 원인을 엉뚱한 데서 찾는다.
        + (seen.length === 0 ? ' — 한 바이트도 못 냈다: 실행 파일·cwd·인증을 먼저 본다' : ''),
  });

  if (!opts.turn && readyAtMs !== null) {
    checks.push({
      name: 'SIGTERM 중단',
      // 프로세스가 끝났다는 것만 본다 — 종료 코드는 하네스마다 다르고, 우리가 정한 값이 아니다.
      ok: result !== null,
      detail: result === null ? '끝나지 않았다' : `종료 코드 ${result.exitCode}${result.timedOut ? ' (시계가 끊었다)' : ''}`,
    });
  }

  if (opts.turn) {
    // 주입이 **닿았는가**를 화면으로 잰다. 모델의 답을 기다리지 않는 이유: 답의 유무는
    // 하네스가 아니라 모델·네트워크의 사실이고, 우리가 재려는 것은 붙여넣기가 입력창에
    // 들어갔는가다.
    const screen = seen.toString('utf8');
    checks.push({
      name: 'bracketed paste 주입',
      ok: screen.includes('CERTIFY_OK'),
      detail: screen.includes('CERTIFY_OK') ? '주입한 문자열이 화면에 보인다' : '주입한 문자열이 화면에 없다',
    });
  }

  reportScreen(stripAnsi(seen.toString('utf8')));
  await rm(root, { recursive: true, force: true });
  return checks;
}

const [nameArg, ...flags] = process.argv.slice(2);
if (!nameArg || !(AGENT_HARNESSES as readonly string[]).includes(nameArg)) usage();
const harness = nameArg as AgentHarness;
const opts = { turn: flags.includes('--turn'), isolated: flags.includes('--isolated') };

console.log(`certify ${harness}${opts.turn ? ' --turn' : ''}${opts.isolated ? ' --isolated' : ''}`);
let lastScreen = '';
const checks = await certify(harness, opts, (screen) => { lastScreen = screen; });
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
// 실패했을 때 **화면을 보여 준다.** 실패 한 줄만으로는 "준비 신호가 틀렸다"와 "관문이 떴다"와
// "로그인이 없다"를 구분할 수 없고, 그 셋은 고치는 자리가 전혀 다르다.
if (checks.some((c) => !c.ok) && lastScreen) {
  console.log('\n--- 마지막 화면 ---\n' + lastScreen.slice(-1200));
}

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? '\n전부 통과.' : `\n${failed}개 실패.`);
// **초록이라고 RUNNABLE 이 되는 것은 아니다.** 이 스크립트가 아직 안 재는 것들이 있고
// (머리 주석 "아직 안 하는 것"), 그 목록이 비기 전에는 사람이 마지막 판단을 한다.
process.exit(failed === 0 ? 0 : 1);
