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
import pty from 'node-pty';
import type { TurnPlan } from './turn.js';

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

export interface TurnResult {
  exitCode: number;
  timedOut: boolean;
  /** 내부 tail 버퍼(끝 2KB, ring 과 무관하게 항상 채워진다)를 문자열로 뜬 것. 로그용. */
  tail: string;
}

export interface RunPtyTurnOptions {
  cwd: string;
  timeoutMs: number;
  /** Phase 2 가 onData 로 확장해 라이브 중계에 쓴다. 없어도 tail 계약에는 영향 없다. */
  ring?: RingBuffer;
}

/**
 * PTY 안에서 plan 을 한 턴 실행하고 종료를 기다린다. 이 함수는 절대 reject 하지 않는다 —
 * 하네스가 어떻게 죽든(정상, 비정상, 타임아웃) exitCode/timedOut/tail 로 표현 가능한 결과이지,
 * 호출자가 catch 를 따로 준비해야 하는 예외 상황이 아니다.
 */
export function runPtyTurn(plan: TurnPlan, opts: RunPtyTurnOptions): Promise<TurnResult> {
  return new Promise((resolve) => {
    const tail = new RingBuffer(TAIL_CAP_BYTES);

    const proc = pty.spawn(plan.command, plan.args, {
      cwd: opts.cwd,
      env: plan.env,
      cols: 120,
      rows: 40,
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
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      dataListener.dispose();
      exitListener.dispose();
      resolve({ exitCode, timedOut, tail: tail.snapshot().toString('utf8') });
    });

    const dataListener = proc.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8');
      tail.push(buf);
      opts.ring?.push(buf);
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      // 하네스가 모델 요청 중일 수 있다 — SIGKILL 을 먼저 쏘면 정리할 기회를 뺏는다.
      // SIGTERM 으로 먼저 부탁하고, grace 안에 안 죽으면 그때 확실히 끝낸다.
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
    }, opts.timeoutMs);
  });
}
