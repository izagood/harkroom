// 한 턴을 PTY 안에서 실행하고, 프로세스가 끝날 때까지 기다린다. 턴의 끝은 하네스 출력을
// 해석해서 판단하지 않는다 — 프로세스 종료 그 자체가 턴의 끝이다(turn.ts 와 같은 원칙:
// 러너는 하네스 출력을 파싱하지 않는다). 그래서 이 모듈의 표면은 좁다: exitCode, timedOut,
// tail 세 개뿐이다.
//
// child_process 가 아니라 PTY 를 쓰는 이유: Phase 2 는 이 프로세스가 뱉는 바이트를 그대로
// 데스크톱 터미널로 중계한다 — "같은 터미널을 사람에게 넘겨준다"는 제품 요구가 이 러너
// 재작업 전체의 존재 이유다. 코딩 에이전트 CLI 는 TUI 를 그리고, 권한을 묻고, Ctrl+C 를
// 받고, stdout 이 tty 가 아니면 다르게 동작한다 — 파이프로는 이 중 아무것도 재현되지 않는다.
// Phase 1 은 그 중계를 아직 안 하지만, 버퍼와 바이트 그대로 보존하는 규율은 그 소비자를
// 위해 지금부터 지킨다.
//
// node-pty 는 1.1.0 이 아니라 1.2.0-beta.15 로 고정돼 있다(package.json, task-7 리포트 —
// 1.1.0 은 macOS 프리빌드의 spawn-helper 실행 비트가 빠져 pnpm 설치 직후 즉시 깨진다,
// microsoft/node-pty#850). **node-pty 가 #850 을 포함한 1.2.0 stable 을 내면 이 핀을
// 내려라** — 그때 가서 다시 beta 를 쓸 이유가 없다.
//
// **`node-pty` 를 정적으로 import 하지 않는다.** 배포 번들에서 러너(`Contents/MacOS`)와
// `node-pty`(`Contents/Resources`)가 서로 다른 자리에 놓이고, ESM 해석기는 러너 파일 기준
// 으로만 `node_modules` 를 걸어 올라가므로 정적 import 는 거기서 해석되지 않는다. 이전에는
// Rust 가 번들 안에 심볼릭 링크를 만들어 이었지만 **`stapler` 가 그 링크를 거부한다**
// (`invalid destination for symbolic link in bundle`) — 자세한 근거와 실측은
// `nodePtyLoader.ts` 모듈 주석에 있다.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type * as NodePty from 'node-pty';
import { loadNodePty, sidecarDirFromModule } from './nodePtyLoader.js';
import { ExecutableNotFoundError } from './policy.js';
import type { TurnPlan } from './turn.js';

/**
 * 해석된 `node-pty`. **처음 쓸 때 한 번만 해석하고 그 뒤로는 재사용한다.**
 *
 * 모듈 최상단에서 즉시 해석하지 않는 이유: 이 모듈을 import 하는 것만으로 네이티브 애드온을
 * `dlopen` 하게 되고, 그러면 PTY 를 전혀 쓰지 않는 경로(테스트가 `composeSpawn` 같은 순수
 * 함수만 부르는 경우, `--version` 같은 인자 처리)까지 `node-pty` 의 존재를 요구한다.
 * `policy.ts` 가 `node-pty` 를 안 물게 떼어 둔 것과 같은 이유다.
 */
let cached: typeof NodePty | null = null;

function nodePty(): typeof NodePty {
  cached ??= loadNodePty(sidecarDirFromModule(import.meta.url));
  return cached;
}

/**
 * 셸 인용 — 단일 인자를 안전한 셸 문자열로 만든다.
 * 공백, $, ", ', 등이 있는 경로·인자를 그대로 붙이면 셸이 이를 특별한 문자로
 * 해석하거나 단어 분리해 명령이 깨진다. 단일 인용부호 안에 넣고, 내부의 단일 인용은
 * `'...'\''...'` 로 전치한다(셸의 표준 규칙).
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * PTY 에 실제로 넘길 명령·인자를 정한다.
 *
 * **순수 함수로 빼낸 이유**: `exec` 가 있는지, 인용이 걸렸는지는 조립된 문자열을 봐야
 * 확인할 수 있다. 이 결정이 `runPtyTurn` 안에 있으면 테스트가 "종료 코드가 0이다" 로
 * 갈음하게 되고, 그건 `exec` 가 없어도 통과한다(실제로 그런 테스트가 있었다).
 *
 * `stdinFile` 이 있으면 `sh -c 'exec <명령> <인자...> < <파일>'` 로 감싼다.
 * - **`exec` 가 필수다.** 없으면 최종 프로세스가 `sh` 가 되어 시그널이 하네스에 닿지
 *   않는다(`SIGKILL_GRACE_MS` 경로와 `hang-ignore-sigterm` 테스트가 이것에 의존한다).
 * - **명령·인자·파일 경로를 모두 인용한다.** 하나라도 빠지면 공백이 든 경로에서 깨진다.
 *
 * `stdinFile` 이 `null` 이면 감싸지 않는다 — 인터랙티브·resume 턴은 stdin 이 PTY 여야 한다.
 *
 * **이 래핑을 없애지 않은 이유(#380 1단계 실측).** #380 은 프롬프트를 `pty.write()` 로
 * 보내 이 `sh -c` 래핑을 통째로 없애자고 제안했다. 실물 CLI 로 직접 확인했다(macOS,
 * claude 2.1.237 `-p`, codex-cli 0.153.2 `exec`): **두 하네스 모두 stdin 이 tty(PTY) 면
 * 프롬프트 위치인자 없이는 stdin 을 아예 읽지 않고 즉시 실패한다** —
 * `Input must be provided either through stdin or as a prompt argument when using --print`,
 * `No prompt provided. Either specify one as an argument or pipe the prompt into stdin.`
 * spawn 직후 동기적으로 `write()` 해도 결과가 같았다 — race 가 아니라 `isatty(0)` 판정이다.
 * 즉 `stdinFile` 을 없애고 `pty.write()` 로 프롬프트를 보내는 순간, 프로덕션이 실제로 쓰는
 * 두 하네스 모두에서 턴이 통째로 실패한다. 부가적으로, 그렇게 보낸 프롬프트는 PTY 가 그대로
 * 에코해 tail 앞부분에 남는다(관측: `MY_SECRET_PROMPT_MARKER_XYZ\r\n...`) — `policy.ts::
 * isCredentialFailure` 가 tail 만으로 판정하므로, 프롬프트 본문에 그 함수가 찾는 문구
 * (`x-api-key`, `authentication_error`, `could not resolve authentication` 등)가 들어가면
 * 무관한 실패가 자격증명 실패로 오판된다(재현: `test/policy.test.ts` "#380 1단계 실측").
 * 이 두 사실 중 첫째만으로도 이 래핑을 없애면 안 된다는 결론에 이른다 — 그래서 `stdinFile`
 * 경로는 남겨 뒀다. 회귀 고정: `test/pty.test.ts` "#380 1단계 실측".
 *
 * **범위 주의(2026-09-08 실측).** 위 결론은 **`-p`/`exec` 모드에 한정된다.** 거절하는 주체가
 * `--print` 의 `isatty(0)` 판정이기 때문이다 — TUI(비 `-p`)는 stdin 이 tty 인 것이 정상이고,
 * 이 저장소의 인터랙티브 턴(`interactiveTurn.ts`, `stdinFile: null`)이 이미 그렇게 돈다.
 * TUI 에 bracketed paste(`ESC[200~ … ESC[201~`)로 여러 줄 프롬프트를 주입하는 것은 실물에서
 * **된다**(claude 2.1.263). 그러니 이 주석을 "PTY 로는 프롬프트를 못 준다"로 읽으면 안 된다.
 *
 * 다만 **둘째 사실(에코 오염)은 TUI 로 가도 따라온다** — 주입한 본문이 그대로 에코돼 tail 에
 * 섞이고, `policy.ts::isCredentialFailure` 가 그 문자열로 판정해 러너를 78 로 물러나게 한다.
 * 실행 모델을 TUI 로 바꾸려면 그 판정을 tail 에서 떼는 것이 선행 조건이다.
 * 근거와 실측표: `docs/specs/2026-09-01-runner-sessions-pty-design.md` §5-4.
 */
export function composeSpawn(plan: TurnPlan): { command: string; args: string[] } {
  if (!plan.stdinFile) return { command: plan.command, args: plan.args };
  const parts = [plan.command, ...plan.args].map(shellQuote).join(' ');
  return { command: 'sh', args: ['-c', `exec ${parts} < ${shellQuote(plan.stdinFile)}`] };
}

/**
 * 이 계획의 PTY 에 **사람이 입력할 수 있는가**(#369).
 *
 * `composeSpawn` 바로 아래 두는 이유: 답의 근거가 그 함수가 하는 일 자체다. `stdinFile` 이
 * 있으면 `sh -c 'exec <하네스> ... < <파일>'` 로 감싸이고, 그 순간 자식의 fd 0 은 PTY slave
 * 가 아니라 일반 파일이다 — 파일이 EOF 에 닿은 뒤 PTY master 에 쓴 바이트는 자식에게
 * **도달하지 않는다**(#369 재현: EOF_SEEN 뒤 입력에 data 이벤트가 한 번도 안 왔다).
 *
 * **하네스 종류로 판정하지 않는다**(`claude -p` 인지 보지 않는다). 원인은 하네스가 아니라
 * stdin 리다이렉션이고, 그 사실 하나로 재면 하네스가 늘어도 이 판정은 안 깨진다.
 */
export function acceptsPtyInput(plan: TurnPlan): boolean {
  return plan.stdinFile === null;
}

/**
 * TUI 가 프롬프트를 받을 준비 상태에 닿지 못했다(2026-09-08 실행 모델 교체).
 *
 * **조용히 넘어가면 안 되는 이유**: 준비 전에 쓴 바이트는 사라진다. 그대로 두면 하네스가
 * 프롬프트 없이 떠서 무발화 한도(기본 30분)까지 살아 있고, 사람은 30분을 기다린 끝에
 * "답변에 실패했습니다"를 본다. 미로그인 화면과 디렉터리 신뢰 대화상자가 정확히 이 모양이라
 * (스펙 §5-4 실측), 이 실패가 그것들을 함께 잡는 그물이기도 하다 — 그래서 별도의 로그인
 * 사전 확인을 만들지 않는다.
 */
export class PromptNotDeliveredError extends Error {
  constructor(public readonly waitedMs: number, public readonly tail: string) {
    super(`TUI 준비 신호를 ${waitedMs}ms 안에 못 봤다 — 프롬프트를 넣지 못했다. 마지막 출력: ${tail}`);
    this.name = 'PromptNotDeliveredError';
  }
}

/**
 * TUI 가 **입력을 받을 준비**가 됐다는 신호.
 *
 * ## 왜 커서 문자만으로는 안 되는가 (2026-09-08 프로덕션 사고)
 *
 * 초판은 `[❯›]` 하나였다. **`❯` 는 입력창의 표시가 아니라 모든 메뉴의 선택 커서다** —
 * 실물에서 이것을 담은 승인 화면을 셋 만났고 전부 준비로 오인됐다:
 *
 * - 폴더 신뢰: `❯No,exit` / `Yes, I trust this folder`
 * - 온보딩(로그인 방식): `❯1. Claude account with subscription …`
 * - 팀 텔레메트리 승인: `❯1.Yes,Itrustthesesettings`
 *
 * 오인하면 프롬프트가 그 모달에 타이핑되고, 턴은 무발화 한도(기본 30분)까지 매달린다.
 * 모달을 **부정 목록**으로 하나씩 막는 길은 끝나지 않는다 — 하네스 판본·조직 설정마다 새
 * 승인 화면이 생기고, 그때마다 러너가 조용히 멈춘다.
 *
 * ## 그래서 긍정 신호로 잰다
 *
 * 채팅 입력창에만 있는 것을 본다:
 * - claude: `❯` 뒤의 **비분리 공백(U+00A0)** — 입력줄을 그 문자로 채운다. 메뉴는 `❯1.`,
 *   `❯No,exit` 처럼 보통 문자가 붙는다.
 * - codex: `Ask <이름> to do anything` 자리표시자.
 *
 * 다섯 화면(위 셋 + claude·codex 입력창)에 대조한 회귀선이 `acceptance-cli.test.ts` 에 있다.
 *
 * **판본에 기대는 값이다.** 표시가 바뀌면 준비를 못 보고 상한에서 실패한다 — 조용히
 * 프롬프트를 흘리는 것보다 낫다. 실패가 곧 이 상수를 고쳐야 한다는 신호다.
 */
const DEFAULT_READY_PATTERN = /[❯›]\u00a0|Ask\s+\S+\s+to\s+do\s+anything/;

/**
 * 준비 판정 **전에** 화면 제어 시퀀스를 걷어낸다.
 *
 * 걷어내지 않으면 표시가 ANSI 바이트 사이에 끼여 안 보이거나, 반대로 색·커서 시퀀스의
 * 문자를 표시로 오인한다. `tail` 은 사람이 읽는 로그이자 여기서 쓰는 판정 재료이므로,
 * 그 두 용도를 가르는 자리가 여기다.
 */
function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][0-9]*;[^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b[()][AB012]/g, '');
}

/**
 * 이 출력이 "입력을 받을 준비" 로 보이는가. **수용 테스트가 실물 화면들에 대고 같은 판정을
 * 쓰기 위해 export 한다** — 테스트가 패턴을 베껴 쓰면 프로덕션이 바뀔 때 그 사본만 초록으로
 * 남는다(이 저장소가 이미 겪은 종류의 어긋남이다).
 */
export function looksReadyForPrompt(rawOutput: string, pattern: RegExp = DEFAULT_READY_PATTERN): boolean {
  return pattern.test(stripAnsi(rawOutput));
}

/**
 * **하네스가 턴 도중에 사람에게 묻는 화면**(2026-09-09 실측).
 *
 * `--permission-mode auto` 는 위험으로 판정한 명령을 차단하고 사람에게 확인을 받는다. 그
 * 화면이 이 모양이다:
 *
 * ```
 * Auto mode classifier requires confirmation for this command.
 * Do you want to proceed?
 * ❯ 1. Yes
 *   3. No
 * ```
 *
 * **준비 판정과 같은 규율을 쓴다**(`looksReadyForPrompt` 주석의 판례): 모달을 부정 목록으로
 * 하나씩 막는 길은 끝나지 않으므로 **묻는 화면에만 있는 것**을 본다 — 확인 문장과 번호
 * 선택지다. 둘 다 채팅 입력창에는 없다.
 *
 * **판본에 기대는 값이다.** 표시가 바뀌면 관문을 못 보고, 그 턴은 정지 시계에 걸려 접힌다 —
 * 그 실패가 이 상수를 고쳐야 한다는 신호다(`DEFAULT_READY_PATTERN` 과 같은 계약).
 */

/*
 * **`›` 와 `Press enter to continue` 가 왜 여기 있나(2026-09-11 실측).**
 *
 * 준비 패턴은 `[❯›]` 로 두 글자를 다 보는데 이 패턴은 `❯` 하나만 봤다. 그래서 codex 의
 * 선택 화면이 관문으로 보이지 않았고, 러너가 그 위에 붙여넣고 `\r` 를 쳤다. 그 화면은
 * 업데이트 선택지였고 기본값이 **"Update now (runs `curl … | sh`)"** 였다 — 러너의 Enter
 * 하나가 설치 명령을 실행했다(codex-cli 0.153.0 → 0.154.0). fixture:
 * `test/fixtures/codex-tui-update-prompt.txt`.
 *
 * 그 사고가 말하는 것은 패턴 하나가 아니다: **모르는 화면에는 아무것도 치지 않는다** 가
 * 규칙이어야 한다. 그래서 `runPtyTurn` 이 주입 **직전에** 이 판정을 한 번 더 한다.
 */
const DEFAULT_GATE_PATTERN =
  /Do you want to (?:proceed|continue)\?|requires confirmation|Press enter to continue|^\s*[❯›]\s*\d+\.\s/m;

/** 패턴이 **마지막으로** 맞은 위치. 없으면 -1. */
function lastMatchIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let last = -1;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    last = m.index;
    // 길이 0 매치가 lastIndex 를 못 밀어 무한 루프가 되는 것을 막는다.
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return last;
}

/**
 * 이 출력의 **마지막 화면이 관문인가**.
 *
 * ## 왜 있다/없다가 아니라 순서인가
 *
 * `tail` 은 화면 스냅샷이 아니라 최근 바이트 흐름이다(`TAIL_CAP_BYTES`) — 관문 글자와
 * 입력창 표시가 **둘 다** 그 안에 남아 있을 수 있다. 존재만 보면 사람이 관문을 지난 뒤에도
 * 판정이 참으로 남아 같은 턴에서 두 번 부르고, 반대로 입력창 표시만 보면 관문이 그 위에
 * 그려졌는데도 준비된 것으로 읽는다. **마지막에 그려진 쪽이 지금 화면이므로 더 뒤에 있는
 * 쪽을 믿는다.**
 *
 * 수용 테스트가 실물 화면에 대고 같은 판정을 쓰기 위해 export 한다 — 테스트가 패턴을 베껴
 * 쓰면 프로덕션이 바뀔 때 그 사본만 초록으로 남는다(`looksReadyForPrompt` 와 같은 이유).
 */
export function looksLikeGate(
  rawOutput: string,
  gate: RegExp = DEFAULT_GATE_PATTERN,
  ready: RegExp = DEFAULT_READY_PATTERN,
): boolean {
  const screen = stripAnsi(rawOutput);
  const gateAt = lastMatchIndex(screen, gate);
  if (gateAt < 0) return false;
  return gateAt > lastMatchIndex(screen, ready);
}

/**
 * 사람을 부른 **자리**. 두 자리의 **범위가 다르기 때문에** 갈라야 한다(`attentionLedger.ts`).
 *
 * - `'startup'` — 프롬프트를 넣기 전에 만난 관문(온보딩·폴더 신뢰·텔레메트리 수락). 그
 *   승인은 **계정 설정에 기록되므로** 한 번 지나면 그 계정의 모든 스레드가 함께 풀린다.
 *   그래서 계정 원장으로 묶어 한 번만 부른다 — 안 묶으면 7개 스레드가 창 7개를 띄운다
 *   (2026-09-08 실측).
 * - `'gate'` — 대화가 시작된 뒤 하네스가 묻는 확인(`--permission-mode auto` 의 classifier).
 *   **명령 하나에 대한 물음이라 계정으로 묶으면 안 된다**: 묶으면 먼저 걸린 스레드가
 *   원장을 쥐고, 다른 스레드의 턴은 아무 신호 없이 서 있다가 정지 시계에 접힌다.
 */
export type AttentionKind = 'startup' | 'gate';

// SIGTERM → SIGKILL 유예 시간. 하네스가 모델 요청을 붙잡고 있는 도중일 수 있다 — 바로
// SIGKILL 을 쏘면 정리(임시 파일, in-flight 요청 등)할 기회 자체를 빼앗는다.
const SIGKILL_GRACE_MS = 5_000;

// tail 은 policy.ts::isCredentialFailure 가 자격증명 실패를 판단하는 유일한 증거다. PTY
// 안에서는 stdout 과 stderr 가 한 스트림으로 섞여 나오므로, 이 버퍼 말고는 근거가 없다.
// 그래서 호출자가 ring 을 안 넘겨도 이 버퍼는 항상 채운다 — ring 은 Phase 2(라이브 중계)를
// 위한 *추가* 싱크일 뿐, tail 의 출처가 아니다.
const TAIL_CAP_BYTES = 2 * 1024;

/**
 * 고정 용량 링 버퍼. capBytes 를 넘는 순간 앞(오래된 쪽)을 잘라 뒤(최신)를 남긴다 — "tail"
 * 이라는 이름이 실제로 끝을 가리키려면 잘라내는 방향이 이래야 한다.
 *
 * **절단은 바이트 단위이고, 일부러 UTF-8 문자 경계로 정렬하지 않는다.** 이 버퍼는 `ring`
 * (Phase 2 가 그대로 xterm 으로 중계할 raw 바이트)과 내부 tail 버퍼 양쪽에 다 쓰인다.
 * ring 쪽에서 문자 경계로 정렬하면 ANSI 이스케이프 시퀀스도 같은 규칙으로 잘려 화면이
 * 깨진다 — 문자 하나가 깨지는 것보다 훨씬 나쁘다. 터미널 중계에서 청크 경계의 부분 문자는
 * 정상이고, xterm 이 다음 청크와 이어붙여 알아서 완성한다. tail(사람이 읽는 로그,
 * policy.ts::isCredentialFailure 입력) 쪽의 U+FFFD 잡음은 이 클래스가 아니라 `runPtyTurn`
 * 이 tail 을 문자열로 뜨는 지점(`decodeTailText`)에서 따로 처리한다 — 소비자마다 정답이
 * 달라서, 버퍼 자체에 규칙을 넣지 않고 소비자 쪽에 남겨 뒀다.
 */
export class RingBuffer {
  /** 용량만큼 **한 번** 잡고 그 안에서만 돈다. */
  private readonly buf: Buffer;
  /** 가장 오래된 바이트의 위치. */
  private start = 0;
  /** 채워진 바이트 수(0 ≤ len ≤ cap). */
  private len = 0;
  private readonly cap: number;

  constructor(capBytes: number) {
    this.cap = Math.max(1, capBytes);
    this.buf = Buffer.alloc(this.cap);
  }

  /**
   * **청크 길이만큼만 복사한다**(O(chunk)). 예전 구현은 `Buffer.concat([this.buf, data])`
   * 였다 — 청크 하나마다 버퍼 전체를 새로 할당하고 복사했으므로, 256KB ring 에 초당 수백
   * 청크가 오는 TUI 재그리기에서 청크당 최대 256KB memcpy 를 물었다. 담는 내용은 그때와
   * 같고(바이트·순서·절단 방향), 비용만 사라진다.
   */
  push(data: Buffer): void {
    if (data.length === 0) return;
    // 한 청크가 용량보다 크면 **끝의 cap 바이트만** 남는다 — 감아 쓸 것도 없다.
    if (data.length >= this.cap) {
      data.copy(this.buf, 0, data.length - this.cap);
      this.start = 0;
      this.len = this.cap;
      return;
    }
    const end = (this.start + this.len) % this.cap;
    // 끝을 넘으면 두 조각으로 나눠 쓴다(뒤쪽 남은 자리 → 앞으로 감기).
    const first = Math.min(data.length, this.cap - end);
    data.copy(this.buf, end, 0, first);
    if (first < data.length) data.copy(this.buf, 0, first);
    if (this.len + data.length > this.cap) {
      // 넘친 만큼 오래된 쪽을 밀어낸다 — 새로 쓴 바이트의 끝이 곧 새 시작점이다.
      this.start = (end + data.length) % this.cap;
      this.len = this.cap;
    } else {
      this.len += data.length;
    }
  }

  snapshot(): Buffer {
    // 호출자가 반환값을 변형해도 내부 버퍼가 오염되지 않도록 복사본을 준다.
    // 감긴 것을 **오래된 것부터** 펴서 준다 — 저장 순서가 아니라 도착 순서가 계약이다.
    const out = Buffer.alloc(this.len);
    const end = this.start + this.len;
    if (end <= this.cap) {
      this.buf.copy(out, 0, this.start, end);
    } else {
      const first = this.cap - this.start;
      this.buf.copy(out, 0, this.start, this.cap);
      this.buf.copy(out, first, 0, end - this.cap);
    }
    return out;
  }
}

/**
 * 출력 프레임 합치기. PTY 청크 하나가 곧 WS 프레임 하나였고, 프레임마다
 * `JSON.stringify` + base64 가 붙는다(러너에서 한 번, 서버가 뷰어마다 한 번 더).
 * TUI 재그리기는 그 청크를 초당 수십~수백 개 만든다 — 그리는 화면은 하나인데.
 *
 * **선행 청크는 즉시 내보낸다**(leading edge). 사람이 친 글자의 에코가 이 경로로 돌아오므로,
 * 고정 지연을 걸면 타이핑이 그만큼 늦게 그려진다 — 조용할 때의 첫 청크는 기다리지 않는다.
 * 그 뒤 창(window) 안에 들어오는 것들만 모아 창 끝에 한 번 내보내고, 창이 비면 다시
 * "조용한 상태"로 돌아간다. 결과: 한 글자 에코는 지연 0, 화면 폭포는 창당 프레임 1개.
 */
export interface OutputCoalescer {
  push(chunk: Buffer): void;
  /** 끝났다 — 타이머를 끄고 **남은 것을 반드시 내보낸다**(턴의 마지막 화면이 여기 있다). */
  stop(): void;
}

/**
 * 창 길이. 화면 한 프레임(~16.7ms)보다 짧게 잡아, 합치기가 눈에 보이는 지연이 되지 않게
 * 한다. 폭포에서는 이 값이 곧 프레임 상한(초당 ~83개)이다.
 */
const OUTPUT_COALESCE_MS = 12;

export function createOutputCoalescer(opts: {
  windowMs: number;
  emit: (chunk: Buffer) => void;
  /** 테스트가 시간을 손으로 돌리기 위한 이음새(`relay.ts` 의 `schedule` 과 같은 이유). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): OutputCoalescer {
  const setTimer = opts.setTimer ?? ((fn, ms): unknown => {
    const t = setTimeout(fn, ms);
    // 합치기 타이머가 프로세스를 살려 두지 않게 한다 — 이건 대기가 아니라 버퍼다.
    t.unref?.();
    return t;
  });
  const clearTimer = opts.clearTimer
    ?? ((handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>); });

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  /** null 이면 **조용한 상태** — 다음 청크는 기다리지 않고 나간다. */
  let timer: unknown = null;

  const flushPending = (): void => {
    if (pendingBytes === 0) return;
    // 여기의 concat 은 **한 창 분량**이라 ring 의 옛 concat 과 성질이 다르다.
    const merged = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    opts.emit(merged);
  };

  const onWindowEnd = (): void => {
    if (pendingBytes > 0) {
      flushPending();
      // 계속 쏟아지는 중이다 — 다음 창을 연다(창당 프레임 1개).
      timer = setTimer(onWindowEnd, opts.windowMs);
      return;
    }
    timer = null;
  };

  return {
    push(chunk) {
      if (chunk.length === 0) return;
      if (timer === null) {
        opts.emit(chunk);
        timer = setTimer(onWindowEnd, opts.windowMs);
        return;
      }
      pending.push(chunk);
      pendingBytes += chunk.length;
    },
    stop() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      flushPending();
    },
  };
}

/**
 * tail 을 문자열로 뜰 때만 쓴다(ring 은 위 클래스 주석대로 raw 로 둔다). RingBuffer 가 자르는
 * 지점은 UTF-8 문자 경계와 무관해서, 잘린 문자의 뒷조각만 버퍼 맨 앞에 남을 수 있다 —
 * `Buffer#toString('utf8')` 은 그 조각을 U+FFFD 로 바꿔버려 "�라마" 같은 잡음이 로그에 낀다
 * (실측: cap=8, 한글 5자). 잘린 조각은 정보가 아니라 잡음이므로 버린다: 앞쪽 continuation
 * 바이트(`0b10xxxxxx`, UTF-8 문자 하나가 최대 4바이트=continuation 3개라 최대 3개까지만
 * 있을 수 있다)를 건너뛰고 다음 문자 시작 지점부터 디코드한다.
 */
function decodeTailText(buf: Buffer): string {
  let start = 0;
  while (start < buf.length && start < 3 && ((buf.at(start) ?? 0) & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString('utf8');
}

/**
 * PTY stdin 에 바이트를 넣는 통로(#315). 사람이 attach 해서 친 것이 여기로 들어간다.
 *
 * **던지지 않는다.** 프로세스가 이미 끝난 뒤에 쓰면 node-pty 가 EIO 로 던지는데, 그것은
 * 사람이 마지막 화면을 보며 엔터를 한 번 더 친 정상 상황이다 — 관찰·개입 하나가 러너
 * 프로세스를 죽이지 않도록 여기서 삼킨다(`onData` 쪽 규율의 반대 방향 절반).
 */
export interface PtyWriter {
  write(chunk: Buffer): void;
  /**
   * PTY 창 크기를 바꾼다(#335). **새 프로세스를 띄우지 않는다** — node-pty 의 `resize`
   * 가 살아 있는 PTY 에 ioctl(TIOCSWINSZ)을 걸고 SIGWINCH 를 보내므로, 하네스는 자기가
   * 그리던 화면을 유지한 채 폭만 다시 계산한다.
   *
   * `write` 와 **같은 이유로 던지지 않는다**: 프로세스가 끝난 뒤의 resize 도 사람이 아직
   * 마지막 화면을 보며 창을 끄는 정상 상황이다.
   */
  resize(cols: number, rows: number): void;
}

/**
 * PTY 조작 손잡이(#337) — `PtyWriter`(입력·크기)에 **종료**를 더한 것. 인터랙티브 턴의
 * 고아 회수(viewer 0 → 유예 → SIGTERM→SIGKILL)와 러너 SIGTERM 회수가 `kill` 을 쓴다.
 * 전부 **exit 후에는 no-op** — 이미 끝난 PTY 를 조작하는 것은 사람이 마지막 화면에서
 * 한 번 더 움직였거나 회수 타이머가 자연 종료와 경합한 정상 상황이지 오류가 아니다.
 *
 * **`kill('SIGTERM')` 은 승격을 포함한다**: 유예(`killGraceMs`, 기본 5초) 안에 안 죽으면
 * `runPtyTurn` 이 SIGKILL 로 올린다(아래 `terminate`). 그러니 호출자는 자기 승격 타이머를
 * 세울 필요가 없다 — `interactiveTurn` 의 것은 이 승격이 없던 시절의 것이고, 같은 유예로
 * 겹쳐 무해하다(그 턴의 회귀선이 그 타이머를 직접 재고 있어 여기서 걷어내지 않았다).
 */
export interface PtyControls extends PtyWriter {
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

export interface TurnResult {
  exitCode: number;
  timedOut: boolean;
  /** 내부 tail 버퍼(끝 2KB, ring 과 무관하게 항상 채워진다)를 문자열로 뜬 것. 로그용. */
  tail: string;
}

export interface RunPtyTurnOptions {
  cwd: string;
  /**
   * 턴 시간 한도. **`0` 은 무기한이다**(#337 — 인터랙티브 전용): 사람이 앉아 있는 턴에는
   * 시계가 없고, 그 턴의 끝은 exit(사람이 하네스를 닫음) 또는 고아 회수(viewer 0 → 유예 →
   * SIGTERM, interactiveTurn.ts)다. 0 을 그냥 setTimeout 에 넣으면 타이머가 **즉시** 발화해
   * 인터랙티브 턴이 뜨자마자 SIGTERM 을 맞는다 — 그래서 0 이면 타이머 자체를 걸지 않는다.
   */
  timeoutMs: number;
  /**
   * TUI 에 넣을 프롬프트(2026-09-08 실행 모델 교체). 있으면 spawn 뒤 **준비 신호를 기다렸다가**
   * bracketed paste 로 감싸 쓰고 `\r` 로 보낸다.
   *
   * **bracketed paste 로 감싸는 이유**: 그냥 쓰면 첫 개행에서 조기 전송돼 여러 줄 프롬프트가
   * 여러 메시지로 갈라진다(스펙 §5-4 실측).
   *
   * **준비 대기가 조건 기반인 이유**: 고정 슬립은 두 방향으로 틀린다 — 짧으면 프롬프트를
   * 잃고(준비 전 바이트는 사라진다), 길면 매 턴을 그만큼 늦춘다.
   *
   * 없으면 아무것도 쓰지 않는다 — codex 의 `stdinFile` 경로가 그대로 산다.
   */
  injectPrompt?: {
    text: string;
    /** 준비로 볼 패턴. 생략하면 claude TUI 의 입력 프롬프트. */
    readyPattern?: RegExp;
    /** 준비 상한. 넘기면 `PromptNotDeliveredError`. 생략하면 60초. */
    readyTimeoutMs?: number;
    /**
     * 관문으로 볼 패턴. 생략하면 기본. **주입 직전에** 이것으로 화면을 한 번 더 보고,
     * 물음이면 넣지 않고 사람을 부른다(`DEFAULT_GATE_PATTERN` 주석의 사고).
     */
    gatePattern?: RegExp;
    /**
     * 준비 신호를 본 뒤 **화면이 이만큼 잠잠해지면** 넣는다(2026-09-09). 생략하면 300ms.
     *
     * 준비 판정은 최근 바이트에 표시가 **있는가**만 본다. 되살린 턴(`claude -r`)은 앞
     * 대화를 화면에 되그리므로 그 재생 중에도 표시가 스칠 수 있고, 그때 넣은 붙여넣기는
     * 아직 그려지지 않은 입력창 밖으로 사라진다. 표시를 본 뒤 흐름이 멈추기를 기다리면
     * "지금 그려진 것이 입력창"이라는 사실에 훨씬 가까워진다.
     */
    readyQuietMs?: number;
    /**
     * 정적 대기의 상한(2026-09-09). 생략하면 2초.
     *
     * 스피너처럼 **쉬지 않고 그리는** 화면에서 정적이 영영 오지 않을 수 있다. 그때는
     * 지금까지의 동작(표시를 보면 곧바로 넣는다)으로 되돌아간다 — 기다리다 아예 못 넣는
     * 것이 제일 나쁘다.
     */
    readyQuietMaxMs?: number;
    /**
     * 준비 상한을 넘겼을 때 **죽이는 대신 부른다**(2026-09-08).
     *
     * 여기까지 온 화면은 사람 손이 필요한 것이다 — 첫 실행 승인 관문이 대표적이고, 그
     * 목록은 우리 계약이 아니라 하네스의 것이라 열거로 끝나지 않는다. 알려진 관문은
     * `workspaceTrust.ts` 가 미리 없애지만, 다음 버전이 관문을 하나 더 만들 수 있다.
     *
     * **그 화면을 죽이면 사람이 열어 볼 대상 자체가 없어진다.** 이것이 있으면 PTY 를
     * 유지하고 `readyProbe` 도 살려 둔다: 사람이 관문을 지나 입력 프롬프트가 그려지는
     * 순간 패턴이 맞아 프롬프트가 그대로 주입된다. 그래서 **사람의 개입이 턴을 대체하지
     * 않고 통과시킨다.**
     *
     * 없으면 지금 동작 그대로다(SIGKILL + `PromptNotDeliveredError`) — 사람이 붙을 수
     * 없는 호출자(비대화형 프로브, 테스트)의 경로다. 콜백 유무가 두 정책을 가르고,
     * 그래서 플래그를 따로 두지 않는다.
     *
     * **이 콜백이 불려도 프라미스는 정착하지 않는다.** 이 턴의 끝은 exit 이거나 고아
     * 회수다 — 인터랙티브 턴과 같은 규칙이다(#337).
     */
    onAttention?: (screen: string, kind: AttentionKind) => void;
    /**
     * 턴 도중 관문을 확인하는 주기(기본 3초). **두 번 연속** 관문으로 보여야 부른다 —
     * 판정 하나로 재면 스크롤을 지나가는 글자에 걸린다(모델이 관문 문장을 그대로 인용해
     * 출력할 수 있다). `onAttention` 이 없으면 이 창도 돌지 않는다.
     */
    gateProbeMs?: number;
    /**
     * 주입이 **먹혔는지** 재는 확인 창(2026-09-08, 스펙 §2-5).
     *
     * 준비 신호는 "화면이 입력을 받을 모양이다"까지만 말한다. 프로덕션에서 프롬프트를
     * 넣은 뒤 대화가 시작되지 않는 상태가 12~30분 실재했고, 무발화 한도가 끝낼 때까지
     * 아무도 몰랐다 — 준비 상한도 조립도 판정도 정상이었으므로 **원인은 미확정이다.**
     * 이 창은 원인이 무엇이든 그 상태를 잡는다.
     *
     * `probe` 는 "대화가 실제로 시작됐다"를 판정한다. 러너는 세션 기록 파일이 **턴 시작
     * 이후에 자랐는가**를 쓴다 — 화면 문자열로 재면 하네스 버전에 묶이지만, 파일이 자란
     * 것은 사실 자체다(존재로 재면 되살린 턴에서 무조건 통과한다, 2026-09-09).
     * **던지면 "증거 없음"으로 읽는다**: 사람을 부르는 쪽이 조용히 태우는 것보다 낫다.
     *
     * 증거가 없으면 **개행 하나를 더 보낸 뒤** 한 창(`resendGraceMs`) 더 기다리고, 그래도
     * 없으면 부른다 — "붙여넣기는 들어갔고 전송만 삼켜졌다"가 그 한 바이트로 낫는다.
     *
     * `onAttention` 이 없으면 부를 곳이 없으므로 이 창도 돌지 않는다.
     * 생략하면 확인 창 자체가 없다(기존 호출자 그대로).
     */
    confirmDelivery?: {
      probe: () => boolean | Promise<boolean>;
      /** 주입부터 증거까지 허용할 시간. 생략하면 15초. */
      withinMs?: number;
      /**
       * 재전송 뒤 증거를 다시 기다릴 시간(2026-09-09). 생략하면 `withinMs` 의 1/3.
       *
       * 첫 창보다 짧게 두는 이유: 여기까지 왔다는 것은 이미 한 창을 기다렸다는 뜻이고,
       * 재전송이 먹히면 하네스는 곧바로 기록을 쓴다 — 안 먹히는 경우에 사람을 부르는
       * 것을 그만큼 늦추지 않는다.
       */
      resendGraceMs?: number;
    };
  };
  /** PTY 초기 크기. 생략하면 비대화형 기본 120x40(스펙 §5)이다. */
  cols?: number;
  rows?: number;
  /**
   * 출력 프레임 합치기 창(ms). 기본 `OUTPUT_COALESCE_MS`. 0 을 주면 창을 열지 않는
   * 것이 아니라 **즉시 만료되는 창**이 되므로, 합치기를 끄려면 그냥 기본값을 쓰지 말고
   * 이 값을 아주 작게 두라 — 테스트는 `createOutputCoalescer` 를 직접 쓴다.
   */
  coalesceMs?: number;

  /** Phase 2 가 onData 로 확장해 라이브 중계에 쓴다. 없어도 tail 계약에는 영향 없다. */
  ring?: RingBuffer;
  /**
   * PTY 가 뱉은 **raw 바이트**를 청크마다 그대로 넘긴다(#141 Phase 2 라이브 중계).
   *
   * `ring` 과 나란히 있는 이유: ring 은 attach 시 재생할 **과거**이고 이것은 지금 붙어
   * 있는 사람에게 흘릴 **현재**다. 하나로 합칠 수 없다 — ring 하나만 두면 뷰어가 폴링을
   * 해야 하고, 이것만 두면 attach 시점 이전 화면이 없다.
   *
   * 문자열이 아니라 `Buffer` 를 넘긴다. 이 청크는 xterm 까지 **한 번도 디코드되지 않고**
   * 가야 한다 — 청크 경계에서 잘린 UTF-8 을 문자열로 뜨면 U+FFFD 로 치환돼 되돌릴 수
   * 없고, ANSI 이스케이프가 조각나 화면이 깨진다(위 `RingBuffer` 주석과 같은 규율).
   *
   * **던지지 않는 것은 호출자의 책임이다.** 여기서 감싸지 않는 이유: 이 콜백이 던지면
   * node-pty 의 data 리스너 안에서 터지고, 그것은 턴 전체를 죽인다. 관찰 하나가 사람이
   * 기다리는 답을 죽이지 않도록 넘기는 쪽(`relay.ts`)이 스스로 삼킨다.
   */
  onData?: (chunk: Buffer) => void;
  /**
   * spawn 직후 **PTY stdin 으로 가는 통로**를 넘긴다(#315 — attach 한 사람의 타이핑).
   *
   * `onData` 의 정확한 반대 방향이라 나란히 둔다. 콜백으로 넘기는 이유: 세션은 spawn
   * **전에** 열려야 하고(그래야 첫 바이트를 안 놓친다 — `mentionTurn.ts` 의 순서 주석),
   * 그 시점에는 아직 쓸 대상이 없다. 그래서 세션이 통로를 미리 만들어 두고, spawn 되는
   * 순간 여기서 이어 붙인다.
   *
   * **turn 의 권한과 무관하다.** 이 통로는 PTY 에 바이트를 넣을 뿐이고, `plan`(모드·권한
   * 프리셋)은 이 함수에 들어오기 전에 이미 조립돼 있다 — 입력을 여는 것이 턴 모드를
   * 바꾸는 것이 아니라는 사실이 이 순서로 성립한다(스펙 §6, #141 회귀선의 새 형태).
   */
  onSpawn?: (controls: PtyControls) => void;
  /**
   * SIGTERM → SIGKILL 유예(ms). 생략하면 프로덕션 기본값(SIGKILL_GRACE_MS, 5초)을 그대로
   * 쓴다 — 테스트가 SIGKILL 승격 경로를 확인하려고 5초를 통째로 기다리지 않게 여는 구멍이지,
   * 운영 판단을 호출자에게 넘기는 옵션이 아니다.
   */
  killGraceMs?: number;
}

/**
 * `plan.command` 를 `plan.env.PATH` 로 풀어 실행 가능한 절대경로를 돌려준다. 못 찾으면 null.
 *
 * **왜 spawn 예외를 기다리지 않고 미리 재는가.** 실측(macOS, node-pty 1.2.0-beta.15):
 * 없는 실행 파일로 `pty.spawn` 을 불러도 **던지지 않는다** — forkpty 는 성공하고 자식의
 * execvp 가 실패해, 출력 한 바이트 없이 `exitCode 1` 로 끝난다. 게다가 프로덕션 턴은
 * `stdinFile` 때문에 `sh -c 'exec <하네스> ... < 파일'` 로 감싸여 spawn 대상이 `sh` 라,
 * 하네스가 없어도 spawn 은 언제나 성공하고 sh 가 127 로 죽을 뿐이다. 즉 "spawn 이 ENOENT 를
 * 던진다"에만 기대면 이 결함은 **프로덕션 경로에서 한 번도 잡히지 않는다**.
 *
 * 그래서 spawn 전에 직접 잰다. 종료 코드(1 이나 127)로 뒤늦게 추론하지 않는 이유: 하네스가
 * 자기 사정으로 1 이나 127 로 죽는 것과 구별할 수 없고, 그 혼동의 대가가 "러너를 죽인다"라
 * 너무 비싸다.
 *
 * PATH 검색은 `execvp` 규칙을 따른다: 이름에 `/` 가 있으면 PATH 를 안 뒤지고 그 경로만 본다.
 */
export function resolveExecutable(command: string, path: string | undefined): string | null {
  const executable = (candidate: string): boolean => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes('/')) return executable(command) ? command : null;

  // PATH 가 비었으면 execvp 는 아무 데도 안 뒤진다 — 여기서도 그렇게 취급한다(빈 PATH 로
  // 뜬 러너가 바로 이 결함의 원인이므로, 이 경우를 "못 찾았다"로 보는 것이 정답이다).
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return null;
}

/**
 * PTY 안에서 plan 을 한 턴 실행하고 종료를 기다린다. 하네스가 **어떻게 죽든**(정상, 비정상,
 * 타임아웃) reject 하지 않는다 — 그건 exitCode/timedOut/tail 로 표현 가능한 결과이지, 호출자가
 * catch 를 따로 준비해야 하는 예외 상황이 아니다.
 *
 * **단 하나의 예외가 실행 파일 부재다**(#340, 스펙 §8 1행). 그때는 `ExecutableNotFoundError`
 * 로 reject 한다 — 턴이 실패한 것이 아니라 **러너가 잘못 세워진 것**이고, 재시도로 낫지 않아
 * 결과값으로 돌려주면 일반 실패와 섞여 멘션 3건을 태운 뒤에야 흔적을 남긴다. 러너는 이걸 받아
 * 즉시 물러난다(`main.ts` → `exit.ts::runnerExitPlan`).
 *
 * stdinFile 이 있으면 `sh -c 'exec ... < 파일'` 로 감싸서 PTY 안에서 stdin 리다이렉션한다.
 * `exec` 가 없으면 최종 프로세스가 sh 가 되어 시그널이 하네스에 닿지 않는다.
 * stdinFile 이 null 이면 PTY stdin 을 그대로 쓴다(인터랙티브·resume 턴용).
 */
export function runPtyTurn(plan: TurnPlan, opts: RunPtyTurnOptions): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const tail = new RingBuffer(TAIL_CAP_BYTES);

    // **감싸기 전에** 하네스 자체를 본다. `composeSpawn` 이 `sh` 로 감싸고 나면 "없는 것은
    // 하네스"라는 사실이 sh 의 종료 코드 뒤로 숨는다(위 `resolveExecutable` 주석).
    if (resolveExecutable(plan.command, plan.env.PATH) === null) {
      reject(new ExecutableNotFoundError(plan.command, plan.env.PATH));
      return;
    }

    const { command, args } = composeSpawn(plan);

    let proc: NodePty.IPty;
    try {
      proc = nodePty().spawn(command, args, {
        cwd: opts.cwd,
        env: plan.env,
        // 기본 120x40 은 **아무도 안 붙었을 때의 값**이다(스펙 §5). 인터랙티브 턴(#337)은
        // 여는 사람의 패널 크기를 받아 그 크기로 뜨고, attach 뒤에는 writer 의 resize 가
        // 이어서 덮는다 — 처음부터 맞는 크기로 뜨면 첫 화면이 한 번 접혔다 펴지지 않는다.
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 40,
      });
    } catch (spawnErr) {
      // 위의 사전 검사를 통과하고도 spawn 이 ENOENT 를 던지는 경우가 남는다: 검사와 spawn
      // 사이에 파일이 사라졌거나(경쟁), node-pty 가 던지는 플랫폼이거나, `sh` 자체가 없거나.
      // 결론은 같으므로 같은 타입으로 승격한다 — 판정은 문구가 아니라 `code` 로 한다.
      const err = spawnErr as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        reject(new ExecutableNotFoundError(plan.command, plan.env.PATH));
        return;
      }
      reject(spawnErr);
      return;
    }

    // exit 리스너를 spawn 직후, 다른 어떤 준비 작업보다도 먼저 건다 — 그 사이에 무언가 던지면
    // 이미 fork 된 자식이 아무도 안 지켜보는 채로 남아 좀비가 된다(spec §10 축소판). 이
    // 리스너가 유일하게 dispose 를 보장하는 경로이므로, 등록을 늦출 이유가 없다.
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // 턴 도중 관문을 지켜보는 창(2026-09-09). 주입이 성공한 뒤에만 선다 — 아래 설치 자리의
    // 주석이 왜인지 말한다. unref 되어 있어 프로세스를 붙잡지는 않지만, 정착 경로에서
    // 함께 걷어 낸다: 끝난 PTY 의 화면으로 사람을 부를 이유가 없다.
    let gateProbe: ReturnType<typeof setInterval> | null = null;
    let timedOut = false;

    /**
     * 이 PTY 를 끝내는 **유일한 길**. SIGTERM 은 부탁이므로 유예 뒤 SIGKILL 로 승격한다.
     *
     * **왜 승격이 여기 있나(2026-09-09 회귀).** 승격은 아래 시간 한도 경로 안에만 있었고,
     * 밖으로 내준 `PtyControls.kill` 은 시그널 한 발이 전부였다. 그런데 claude TUI 는
     * SIGTERM 을 받고도 죽지 않는다 — 실측: pty 에서 SIGTERM 뒤 10초를 살아 있고 SIGKILL
     * 에만 죽었다. 게다가 멘션 턴은 TUI 에서 `timeoutMs: 0`(무기한)이라 그 시간 한도 경로가
     * **아예 걸리지 않는다.** 그래서 이 손잡이로 죽이려던 세 길 — 사람의 [중단](#686) ·
     * 고아 회수 · 무발화 회수 — 이 전부 무력했고, 그 턴 생애에 SIGKILL 이 한 줄도 없었다.
     *
     * 호출자마다 자기 타이머를 세우게 하지 않고 여기 두는 이유: 손잡이를 쥔 쪽이 이미
     * 셋이고 더 늘어난다 — 한 곳이라도 빠뜨리면 **그 길만** 조용히 안 듣는다. 그리고
     * 그 빠뜨림은 화면에 아무 흔적도 남기지 않는다(끝나야 실패 카드가 뜬다).
     *
     * 승격 타이머는 **한 번만** 세운다: SIGTERM 이 두 번 오면(사람이 두 번 눌렀거나 회수와
     * 시간 한도가 겹쳤다) 다시 세워 유예가 늘어나는 것을 막는다.
     */
    const terminate = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      if (settled) return;
      try { proc.kill(signal); } catch { /* 이미 끝났으면 회수할 것도 없다 */ }
      if (signal !== 'SIGTERM' || killTimer) return;
      // 하네스가 모델 요청 중일 수 있다 — SIGKILL 을 먼저 쏘면 정리할 기회를 뺏는다.
      // SIGTERM 으로 먼저 부탁하고, grace 안에 안 죽으면 그때 확실히 끝낸다.
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* 이미 죽었으면 회수할 것도 없다 */ }
      }, opts.killGraceMs ?? SIGKILL_GRACE_MS);
    };

    const exitListener = proc.onExit(({ exitCode }) => {
      // node-pty 가 exit 이벤트를 중복 발화하는 것을 실측으로 확인한 적은 없지만, 여기서
      // 두 번 처리하면 resolve 를 두 번 부르게 된다(두 번째는 무시되긴 해도 타이머
      // 정리·리스너 해제를 건너뛸 이유는 없다) — settled 가드로 정리 경로를 한 번만 태운다.
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (gateProbe) clearInterval(gateProbe);
      dataListener.dispose();
      exitListener.dispose();
      // **턴의 마지막 화면이 창 안에 남아 있을 수 있다.** 여기서 안 내보내면 사람이 보는
      // 마지막 프레임이 통째로 사라진다(정확히 그 프레임에 결과가 적혀 있다).
      relay.stop();
      resolve({ exitCode, timedOut, tail: decodeTailText(tail.snapshot()) });
    });

    // 사람이 attach 해서 친 바이트가 들어오는 통로(#315). spawn 직후에 건네는 이유는
    // 위 `onSpawn` 주석에 있다.
    //
    // **여기서 처음으로 디코드한다.** 러너 → 서버 → 데스크탑 → 서버 → 여기까지 base64
    // 로만 오는 규율(shared 의 릴레이 절 주석)은 **중계 구간**의 규칙이고, 여기는 중계가
    // 아니라 파이프의 끝이다. node-pty 의 `write` 는 문자열만 받아 utf8 로 인코딩하므로
    // 이 왕복은 무손실이다 — 제어 바이트(Ctrl-C, 화살표)는 ASCII 라 그대로이고, 붙여 넣은
    // 멀티바이트는 온전한 UTF-8 로 왔다(데스크탑이 `TextEncoder` 로 인코딩한다).
    opts.onSpawn?.({
      write(chunk) {
        // 프로세스가 끝난 뒤의 쓰기는 EIO 로 던진다 — 사람이 마지막 화면에서 엔터를 한 번
        // 더 친 정상 상황이므로, 그것으로 러너를 죽이지 않는다(`PtyWriter` 주석).
        if (settled) return;
        try { proc.write(chunk.toString('utf8')); } catch { /* 이미 끝난 PTY 는 조용히 버린다 */ }
      },
      resize(cols, rows) {
        // 위 spawn 크기(기본 120x40)는 **아무도 안 붙었을 때의 값**이고, writer 패널이
        // 붙으면 그 크기가 이것으로 덮어쓴다(#335 — 자식에 SIGWINCH 로 닿는다, 스파이크
        // 실측: 계획 문서 "스파이크 결과" §3).
        if (settled) return;
        try { proc.resize(cols, rows); } catch { /* 끝난 PTY 의 크기는 의미가 없다 */ }
      },
      kill(signal) {
        // 고아 회수(#337)·사람의 중단(#686)의 손잡이다. exit 후 no-op — 회수 타이머와 자연
        // 종료가 경합해도 이미 끝난 프로세스에 시그널을 또 쏘지 않는다(`terminate`).
        terminate(signal ?? 'SIGTERM');
      },
    });

    /**
     * ring·`onData` 로 가는 길만 합친다. **tail 은 청크마다 그대로 채운다** — 자격증명
     * 실패 판정(`policy.ts::isCredentialFailure`)과 관문 화면이 그것을 읽고, 그 판정은
     * 프레임 수와 무관하게 항상 최신이어야 한다.
     */
    const relay = createOutputCoalescer({
      windowMs: opts.coalesceMs ?? OUTPUT_COALESCE_MS,
      emit: (buf) => {
        opts.ring?.push(buf);
        opts.onData?.(buf);
      },
    });

    const dataListener = proc.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      tail.push(buf);
      relay.push(buf);
    });

    // ── 프롬프트 주입(2026-09-08). **준비 신호를 본 뒤에만** 쓴다.
    if (opts.injectPrompt) {
      const { text, readyPattern = DEFAULT_READY_PATTERN, readyTimeoutMs = 60_000,
              readyQuietMs = 300, readyQuietMaxMs = 2_000, gatePattern = DEFAULT_GATE_PATTERN,
              onAttention } = opts.injectPrompt;
      let injected = false;
      /**
       * **관문 때문에 주입을 미루고 있는가**(2026-09-11).
       *
       * 이 상태가 필요한 이유는 아래 `readyTimer` 의 이른 반환 때문이다 — 준비를 본 뒤에는
       * 그 시계가 남의 일이라고 보고 물러나는데, 관문에 막혀 영영 못 넣는 턴은 그 시계마저
       * 물러나면 **아무도 끝내지 않는다**. 막혀 있는 동안에는 그 시계가 다시 제 일을 한다.
       */
      let gateBlocked = false;
      /** 이 부팅에서 관문으로 사람을 이미 불렀나. 한 관문에 한 번만 부른다. */
      let gateCalled = false;
      const startedAt = Date.now();
      let readyProbe: NodePty.IDisposable | null = null;
      /** 준비 표시를 **처음** 본 시각. 정적 대기의 상한을 여기서 잰다. */
      let readySeenAt: number | null = null;
      let quietTimer: ReturnType<typeof setTimeout> | null = null;
      const readyTimer = setTimeout(() => {
        // **준비를 이미 본 뒤라면 이 상한은 남의 일이다**: 정적 대기가 돌고 있고, 그것은
        // 반드시 주입으로 끝난다(정적이 오거나 상한에 닿는다). 여기서 부르거나 죽이면
        // 준비를 본 화면을 관문으로 오진한다.
        // `gateBlocked` 면 준비를 봤더라도 이 시계가 제 일을 한다 — 관문에 막힌 턴은
        // 정적 대기가 주입으로 끝나지 않으므로, 물러나면 아무도 이 턴을 끝내지 않는다.
        if (injected || settled || (readySeenAt !== null && !gateBlocked)) return;
        const screen = decodeTailText(tail.snapshot());
        if (onAttention) {
          // **여기서 아무것도 정착시키지 않는다.** `readyProbe` 를 그대로 살려 두므로,
          // 사람이 관문을 지나면 아래 주입이 일어나고 턴이 이어진다.
          onAttention(screen, 'startup');
          return;
        }
        // 준비를 못 봤고 부를 사람도 없다 — 이 턴은 프롬프트 없이 도는 것이 아니라 실패다.
        readyProbe?.dispose();
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (gateProbe) clearInterval(gateProbe);
        dataListener.dispose();
        exitListener.dispose();
        relay.stop();
        try { proc.kill('SIGKILL'); } catch { /* 이미 죽었으면 회수할 것도 없다 */ }
        reject(new PromptNotDeliveredError(Date.now() - startedAt, screen));
      }, readyTimeoutMs);
      readyTimer.unref?.();
      /**
       * 실제 주입. 준비 표시를 본 **뒤** 화면이 잠잠해지면(또는 정적 상한에 닿으면) 온다.
       * 두 경로가 한 곳으로 모여야 한다 — 갈라 두면 한쪽만 `injected` 를 세우거나 타이머를
       * 정리하지 않는 모양이 생긴다.
       */
      const inject = (): void => {
        if (injected || settled) return;

        /**
         * **관문 위에는 쓰지 않는다(2026-09-11 실측).**
         *
         * 준비 표시를 본 것만으로는 부족하다 — 그 표시는 모달이 덮기 **전**의 자리표시자일
         * 수 있고, 실제로 그랬다: codex 가 부팅 직후 업데이트 선택 화면을 띄웠는데 우리는
         * 0.2초에 본 `Ask … to do anything` 을 근거로 붙여넣고 `\r` 를 쳤다. 그 Enter 가
         * 기본 선택지 **"Update now (runs `curl … | sh`)"** 를 눌러 설치를 실행했다.
         *
         * 그러니 재는 시점이 **쓰기 직전**이어야 한다. 화면이 물음이면 넣지 않고 사람을
         * 부르며, PTY 는 그대로 살려 둔다 — 사람이 지나면 화면이 준비로 돌아오고 그때
         * 넣는다. 끝내 안 지나면 `readyTimeoutMs` 가 이 턴을 실패로 접는다(위 시계).
         */
        const beforeWrite = decodeTailText(tail.snapshot());
        if (looksLikeGate(beforeWrite, gatePattern, readyPattern)) {
          gateBlocked = true;
          if (onAttention && !gateCalled) { gateCalled = true; onAttention(beforeWrite, 'startup'); }
          // 화면이 멈춰 있으면 새 데이터가 안 와서 `readyProbe` 가 다시 안 깨운다 —
          // 그래서 여기서 직접 다시 볼 시각을 잡는다. 상한은 위 `readyTimer` 가 쥔다.
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(inject, readyQuietMs);
          quietTimer.unref?.();
          return;
        }
        gateBlocked = false;

        injected = true;
        clearTimeout(readyTimer);
        if (quietTimer) clearTimeout(quietTimer);
        readyProbe?.dispose();
        // 감싼 본문과 전송을 나눠 쓴다: 붙여 쓰면 일부 TUI 가 끝 표식과 개행을 한 덩어리로
        // 읽어 전송을 건너뛴다.
        try {
          proc.write(`\u001b[200~${text}\u001b[201~`);
          proc.write('\r');
        } catch { /* 그 사이에 죽었으면 exit 리스너가 결과를 정한다 */ }

        // ── 턴 **도중**의 관문을 계속 지켜본다(2026-09-09 실측).
        //
        // **왜 주입 뒤에만 서는가.** 그 앞의 관문은 위 두 창(`readyTimer`·`confirmDelivery`)이
        // 이미 맡고 있고, 그 자리의 관문은 계정 단위라 원장으로 묶어야 한다(`AttentionKind`).
        // 여기서 함께 잡으면 startup 관문이 `'gate'` 로 새어 나가 사람을 스레드마다 부른다.
        //
        // **왜 이 창이 필요한가.** 이 자리는 지금까지 비어 있었고, 그래서 대화가 시작된 뒤에
        // 뜬 관문은 아무 신호도 남기지 않았다 — 화면 바이트는 릴레이로 흐르는데 아무도 그것을
        // "물음이다"라고 읽지 않았다. 유일하게 반응하는 시계가 `mentionTurn` 의 정지 판정이라
        // 사람을 기다리는 턴이 **고장으로 오진돼** SIGTERM 을 맞고, 같은 관문에 다시 걸릴 뿐인
        // 재시도가 3회를 태웠다(실측: 30분).
        //
        // **끝을 정하지 않는다.** 위 두 창과 같은 규율이다 — PTY 는 그대로 살아 있고, 사람이
        // 관문을 지나면 하네스가 그 자리에서 일을 이어 간다. 이 창이 하는 일은 부르는 것뿐이다.
        if (onAttention) {
          const gateMs = opts.injectPrompt?.gateProbeMs ?? 3_000;
          // 지난 주기에도 관문으로 보였나 / 이 관문으로 이미 불렀나. 둘을 갈라야 한 관문에
          // 한 번만 부르면서도 **다음 관문은 다시** 부를 수 있다 — 한 턴에 관문이 여럿 뜨고
          // (명령마다 묻는다), 두 번째를 안 부르면 그 턴은 다시 조용히 선다.
          let seenOnce = false;
          let called = false;
          gateProbe = setInterval(() => {
            if (settled) return;
            if (!looksLikeGate(decodeTailText(tail.snapshot()))) {
              // 관문이 화면에서 내려갔다 — 사람이 지났거나 오인이었다. 어느 쪽이든 다음
              // 관문은 처음부터 다시 센다.
              seenOnce = false;
              called = false;
              return;
            }
            if (!seenOnce) { seenOnce = true; return; }
            if (called) return;
            called = true;
            onAttention(decodeTailText(tail.snapshot()), 'gate');
          }, gateMs);
          gateProbe.unref?.();
        }

        // 주입이 **먹혔는지** 확인한다(스펙 §2-5). 여기서도 아무것도 정착시키지 않는다 —
        // 사람을 부를 뿐이고, `readyProbe` 는 이미 소임을 다해 dispose 됐다.
        const confirm = opts.injectPrompt?.confirmDelivery;
        if (confirm && onAttention) {
          /** 증거가 있는가. 던지면 **없음**으로 읽는다 — 부르는 쪽이 조용히 태우는 것보다 낫다. */
          const 증거 = async (): Promise<boolean> => {
            try { return await confirm.probe(); } catch { return false; }
          };
          const withinMs = confirm.withinMs ?? 15_000;
          const graceMs = confirm.resendGraceMs ?? Math.max(50, Math.round(withinMs / 3));
          const confirmTimer = setTimeout(() => {
            if (settled) return;
            void (async () => {
              if (await 증거() || settled) return;
              /*
                **사람을 부르기 전에 개행 하나를 더 쏜다**(2026-09-09).

                여기까지 온 상태는 두 갈래다 — 붙여넣기가 입력창에 들어갔는데 전송만
                삼켜졌거나, 붙여넣기 자체가 아무 데도 안 갔거나. 앞쪽이면 개행 하나로
                턴이 그대로 살아나고, 뒤쪽이면 빈 입력창에 개행이 들어가 아무 일도
                일어나지 않는다(그다음 이 창이 사람을 부른다).

                **본문은 다시 보내지 않는다.** 첫 붙여넣기가 실은 들어갔던 경우에 같은
                프롬프트가 두 번 서고, 그러면 하네스가 같은 일을 두 번 한다 — 사람을
                한 창 늦게 부르는 것보다 그쪽이 비싸다.
              */
              try { proc.write('\r'); } catch { /* 그 사이에 죽었으면 exit 리스너가 정한다 */ }
              const graceTimer = setTimeout(() => {
                if (settled) return;
                void (async () => {
                  if (await 증거() || settled) return;
                  onAttention(decodeTailText(tail.snapshot()), 'startup');
                })();
              }, graceMs);
              graceTimer.unref?.();
            })();
          }, withinMs);
          // 이 타이머만으로 러너를 살려 두지 않는다 — 턴의 수명은 PTY 가 정한다.
          confirmTimer.unref?.();
        }
      };

      readyProbe = proc.onData(() => {
        if (injected || settled) return;
        if (!readyPattern.test(stripAnsi(decodeTailText(tail.snapshot())))) return;
        if (readySeenAt === null) readySeenAt = Date.now();
        // 쉬지 않고 그리는 화면에서 정적이 영영 안 올 수 있다 — 상한에 닿으면 지금까지의
        // 동작(표시를 보면 곧바로 넣는다)으로 되돌아간다.
        if (Date.now() - readySeenAt >= readyQuietMaxMs) { inject(); return; }
        // 바이트가 또 왔다 = 아직 그리는 중이다. 시계를 다시 세운다.
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(inject, readyQuietMs);
        quietTimer.unref?.();
      });
    }

    // **시계는 `onSpawn` 이 돌아온 뒤에야 흐르기 시작한다**(#391). 스폰 직후에 하네스가
    // 뜨기를 확인해야 하는 호출자(테스트가 SIGKILL 승격 경로를 태우려면 하네스가 이미
    // SIGTERM 을 무시하고 있어야 한다)는 `onSpawn` 안에서 **동기적으로** 그 상태를 기다려
    // 시계를 늦출 수 있다. 실측(#391): 이 대기가 없으면 부하 아래에서 하네스가 부팅을
    // 마치기 전에 SIGTERM 을 맞아 기본 처분으로 죽고, 승격 경로는 한 번도 안 탄다.
    //
    // **성립시키는 것은 등록 순서가 아니라 그 대기가 동기라는 사실이다.** `setTimeout` 의
    // 콜백은 이 스레드가 이벤트 루프로 돌아와야 발화하므로, `onSpawn` 이 `Atomics.wait`
    // 로 스레드를 막고 있는 동안에는 타이머를 **먼저** 걸어 두었더라도 시계가 못 간다.
    // 통제 실험(#391 회수): 타이머 등록을 이 콜백보다 위로 옮겨도 부하(버너 16개 + server·
    // desktop 동시 실행) 아래 4/4 초록이었다 — 그래서 순서는 계약이 아니다. 진짜 계약은
    // **호출자 쪽**에 있다: 이 대기를 `await`(비동기)로 바꾸면 그 순간 시계가 흘러 대기가
    // 조용히 무력해진다.
    //
    // `timeoutMs: 0` 은 무기한이다(인터랙티브 턴, #337) — 타이머를 아예 걸지 않는다.
    // 0 을 setTimeout 에 그대로 넣으면 즉시 발화해, 인터랙티브 턴이 뜨자마자 SIGTERM 을
    // 맞는다(옵션 주석). 그 턴의 끝은 exit 또는 고아 회수(interactiveTurn.ts)다.
    const timeoutTimer = opts.timeoutMs === 0 ? null : setTimeout(() => {
      timedOut = true;
      // 승격까지 `terminate` 가 갖는다 — 끝내는 길이 둘이면 한쪽만 고쳐지고, 실제로 그렇게
      // 갈라져 있었다(`terminate` 주석의 회귀).
      terminate('SIGTERM');
    }, opts.timeoutMs);
  });
}
