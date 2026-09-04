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
import pty from 'node-pty';
import type { TurnPlan } from './turn.js';

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
 */
export function composeSpawn(plan: TurnPlan): { command: string; args: string[] } {
  if (!plan.stdinFile) return { command: plan.command, args: plan.args };
  const parts = [plan.command, ...plan.args].map(shellQuote).join(' ');
  return { command: 'sh', args: ['-c', `exec ${parts} < ${shellQuote(plan.stdinFile)}`] };
}

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
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly capBytes: number) {}

  push(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    if (this.buf.length > this.capBytes) {
      this.buf = this.buf.subarray(this.buf.length - this.capBytes);
    }
  }

  snapshot(): Buffer {
    // 호출자가 반환값을 변형해도 내부 버퍼가 오염되지 않도록 복사본을 준다.
    return Buffer.from(this.buf);
  }
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
  /** PTY 초기 크기. 생략하면 비대화형 기본 120x40(스펙 §5)이다. */
  cols?: number;
  rows?: number;
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
 * PTY 안에서 plan 을 한 턴 실행하고 종료를 기다린다. 이 함수는 절대 reject 하지 않는다 —
 * 하네스가 어떻게 죽든(정상, 비정상, 타임아웃) exitCode/timedOut/tail 로 표현 가능한 결과이지,
 * 호출자가 catch 를 따로 준비해야 하는 예외 상황이 아니다.
 *
 * stdinFile 이 있으면 `sh -c 'exec ... < 파일'` 로 감싸서 PTY 안에서 stdin 리다이렉션한다.
 * `exec` 가 없으면 최종 프로세스가 sh 가 되어 시그널이 하네스에 닿지 않는다.
 * stdinFile 이 null 이면 PTY stdin 을 그대로 쓴다(인터랙티브·resume 턴용).
 */
export function runPtyTurn(plan: TurnPlan, opts: RunPtyTurnOptions): Promise<TurnResult> {
  return new Promise((resolve) => {
    const tail = new RingBuffer(TAIL_CAP_BYTES);

    const { command, args } = composeSpawn(plan);

    const proc = pty.spawn(command, args, {
      cwd: opts.cwd,
      env: plan.env,
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 40,
    });

    // exit 리스너를 spawn 직후, 다른 어떤 준비 작업보다도 먼저 건다 — 그 사이에 무언가 던지면
    // 이미 fork 된 자식이 아무도 안 지켜보는 채로 남아 좀비가 된다(spec §10 축소판). 이
    // 리스너가 유일하게 dispose 를 보장하는 경로이므로, 등록을 늦출 이유가 없다.
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const exitListener = proc.onExit(({ exitCode }) => {
      // node-pty 가 exit 이벤트를 중복 발화하는 것을 실측으로 확인한 적은 없지만, 여기서
      // 두 번 처리하면 resolve 를 두 번 부르게 된다(두 번째는 무시되긴 해도 타이머
      // 정리·리스너 해제를 건너뛸 이유는 없다) — settled 가드로 정리 경로를 한 번만 태운다.
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      dataListener.dispose();
      exitListener.dispose();
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
        // 고아 회수(#337)의 손잡이다. exit 후 no-op — 회수 타이머와 자연 종료가 경합해도
        // 이미 끝난 프로세스에 시그널을 또 쏘지 않는다.
        if (settled) return;
        try { proc.kill(signal ?? 'SIGTERM'); } catch { /* 이미 끝났으면 회수할 것도 없다 */ }
      },
    });

    const dataListener = proc.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      tail.push(buf);
      opts.ring?.push(buf);
      opts.onData?.(buf);
    });

    // `timeoutMs: 0` 은 무기한이다(인터랙티브 턴, #337) — 타이머를 아예 걸지 않는다.
    // 0 을 setTimeout 에 그대로 넣으면 즉시 발화해, 인터랙티브 턴이 뜨자마자 SIGTERM 을
    // 맞는다(옵션 주석). 그 턴의 끝은 exit 또는 고아 회수(interactiveTurn.ts)다.
    const timeoutTimer = opts.timeoutMs === 0 ? null : setTimeout(() => {
      timedOut = true;
      // 하네스가 모델 요청 중일 수 있다 — SIGKILL 을 먼저 쏘면 정리할 기회를 뺏는다.
      // SIGTERM 으로 먼저 부탁하고, grace 안에 안 죽으면 그때 확실히 끝낸다.
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, opts.killGraceMs ?? SIGKILL_GRACE_MS);
    }, opts.timeoutMs);
  });
}
