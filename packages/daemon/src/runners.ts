/**
 * daemon 이 소유하는 러너들 — **프로세스 수준의 소유**다(`#431` 2단계-b, D5).
 *
 * ## 이 모듈이 아는 것과 모르는 것
 *
 * 아는 것: 어떤 pid 를 내가 띄웠는가, 그 pid 가 지금 살아 있는가, 그것에 SIGTERM 을
 * 언제 보냈는가. 전부 **관측**이다.
 *
 * 모르는 것: 그 러너가 지금 턴을 돌고 있는가, 저장을 마쳤는가, 죽여도 되는가.
 * 전부 **세션 상태**이고 그것을 알려면 `sessions.json` 을 읽어야 한다 — D5 가 금지한
 * 바로 그것이다. 그래서 이 모듈은 그 질문에 답하지 않고, **답하려 들지도 않는다.**
 *
 * > daemon 은 판단하지 않는다. 관측을 노출한다.
 *
 * ## `sessions.json` 이 아니라 이 인메모리 표인 이유 (`#431` D5)
 *
 * "daemon 이 자기가 띄운 러너를 기록해야 하지 않나"는 자연스러운 생각이고, 그 기록을
 * 둘 자리로 `sessions.json` 이 눈에 띈다 — 이미 있고, 이미 러너별로 나뉘어 있다.
 * **그 파일에 daemon 이 쓰면 안 된다.** 그 파일의 원자성은 "쓰는 주체가 하나(러너)"에서
 * 나오고, 두 번째 writer 가 생기면 각자의 쓰기는 원자적인데 합쳐서 lost update 가 난다.
 * 그리고 조용히 난다 — 에러도 크래시도 없이 중복 답변·누락으로 나타나 daemon 과 무관해
 * 보인다.
 *
 * 그래서 이 표는 **프로세스 사실만** 담고 메모리에만 있다. daemon 이 죽으면 표는
 * 사라지지만 러너는 산다 — 그 러너를 다시 알아보는 것은 2-c(고아 재발견)의 일이고,
 * 그 단계도 세션 파일이 아니라 별도 기록/presence 로 푼다.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import {
  newIncarnationId,
  type IncarnationId,
  type RunnerInfo,
} from '@murmur/shared/daemonProtocol';

/** 러너 하나에 대해 daemon 이 들고 있는 사실. **전부 프로세스 수준이다.** */
export interface RunnerRecord {
  agentId: string;
  pid: number;
  incarnationId: IncarnationId;
  startedAtMs: number;
  /** SIGTERM 을 보낸 때. 안 보냈으면 `null`. **관측이지 판단이 아니다.** */
  termSentAtMs: number | null;
  /** 자식 핸들. 종료 통지의 출처다. */
  child: ChildProcess;
  /** 종료를 이미 관측했는가. 늦은 이벤트를 두 번 보내지 않기 위한 것. */
  exited: boolean;
}

export interface RunnerExitNotice {
  agentId: string;
  incarnationId: IncarnationId;
  code: number | null;
  signal: string | null;
}

/** 프로세스 표면 주입 — 회귀선이 진짜 러너 바이너리 없이 이 로직을 밟게 한다. */
export interface RunnerHost {
  /**
   * 러너를 띄운다. **`detached: true` 가 이 함수의 존재 이유다** — 아래 `spawnRunner`
   * 주석의 "왜 setsid 인가" 참조.
   */
  spawn(command: string, args: readonly string[], env: Record<string, string>): ChildProcess;
  /**
   * `kill(pid, sig)`. `sig` 가 `0` 이면 시그널을 안 보내고 **존재만 확인**한다 —
   * `alive` 가 추측이 아니라 커널에게 물은 답인 이유다.
   */
  kill(pid: number, signal: NodeJS.Signals | 0): boolean;
  now(): number;
}

export const nodeRunnerHost: RunnerHost = {
  spawn(command, args, env) {
    return spawn(command, [...args], {
      env,
      // ── 왜 `detached: true` 인가 (= `setsid`) ────────────────────────────
      // Node 의 `detached` 는 POSIX 에서 정확히 `setsid(2)` 다: 자식이 **새 세션과 새
      // 프로세스 그룹의 리더**가 되고 그 그룹의 PGID 가 자기 pid 로 선다.
      //
      // 이것이 `#431` 전체의 핵심 메커니즘이다. 실측(2026-09-05)이 근거다: 앱을 죽여도
      // 러너는 살아남았지만 **PGID 가 앱 그룹 그대로**였고, `kill -TERM -<그 그룹>`
      // 한 번에 전부 죽었다. 즉 "러너가 앱 종료에 무관하다"는 것은 성질이 아니라
      // **아무도 그 시그널을 안 보냈다는 우연**이었다.
      //
      // daemon 이 러너를 소유하게 되어도 같은 위험이 그대로 옮겨온다 — daemon 이 죽을 때
      // 누군가 daemon 의 프로세스 그룹에 시그널을 보내면(셸의 세션 종료, 상위 런처의
      // 정리, 사람의 `kill -TERM -<pgid>`) 러너가 전부 딸려 간다. `setsid` 한 단계가
      // 그 경로 전부를 막는다.
      //
      // 회귀선: `test/runners.test.ts` 의 "spawn 한 러너는 자기 프로세스 그룹을 갖는다"
      // 가 실제 프로세스를 띄워 `pgid === pid` 를 확인한다. `detached` 를 빼면 빨개진다.
      detached: true,
      // 러너의 stdio 는 daemon 에 매달지 않는다. 매달면 daemon 이 죽을 때 파이프가 닫혀
      // 러너가 EPIPE 로 죽을 수 있다 — "daemon 이 죽어도 러너는 산다"가 깨진다.
      stdio: 'ignore',
    });
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal as NodeJS.Signals);
      return true;
    } catch {
      // ESRCH(없다) 든 EPERM(남의 것) 이든 **내가 신호를 못 보냈다**는 사실은 같다.
      // `alive` 판정에서 이 둘을 가르지 않는 이유는, daemon 이 자기가 띄운 것만 표에
      // 담기 때문이다 — 표에 있는 pid 에 EPERM 이 날 상황은 이미 그 pid 가 남의 것으로
      // 재사용됐다는 뜻이고, 그것은 "내 러너는 없다"와 같다.
      return false;
    }
  },
  now() {
    return Date.now();
  },
};

/** 러너를 띄울 때 쓸 고정값. **웹뷰나 클라이언트가 프로그램·인자를 고르지 못한다.** */
export interface RunnerLaunchSpec {
  /** 러너 사이드카의 절대 경로. daemon 이 자기 위치에서 스스로 찾는다. */
  command: string;
  /** 인자. **리터럴로 못박는다**(`#250` 의 경계) — 지금은 비어 있다. */
  args: readonly string[];
}

export class RunnerRegistry {
  /** `agentId` → 지금 세대. **에이전트당 하나**다 — 둘이면 멘션을 나눠 집어 간다. */
  private readonly byAgent = new Map<string, RunnerRecord>();

  constructor(
    private readonly launch: RunnerLaunchSpec,
    private readonly host: RunnerHost = nodeRunnerHost,
    /** 러너가 끝났을 때 불린다. `incarnationId` 가 실려 나간다. */
    private readonly onExit: (notice: RunnerExitNotice) => void = () => undefined,
  ) {}

  /**
   * 러너를 띄운다.
   *
   * 같은 에이전트에 **살아 있는 러너가 이미 있으면 새로 띄우지 않고 그것을 돌려준다** —
   * 같은 에이전트에 러너가 둘이면 서버의 멘션을 나눠 집어 가고, 그러면 답이 반쪽씩
   * 갈린다(`#431` D5 의 중복 러너 금지와 같은 자리).
   */
  spawnRunner(agentId: string, env: Record<string, string>): RunnerRecord {
    const existing = this.byAgent.get(agentId);
    if (existing && !existing.exited && this.host.kill(existing.pid, 0)) {
      return existing;
    }

    const child = this.host.spawn(this.launch.command, this.launch.args, env);
    const pid = child.pid;
    if (typeof pid !== 'number') {
      throw new Error('러너를 띄웠는데 pid 가 없다');
    }
    const record: RunnerRecord = {
      agentId,
      pid,
      incarnationId: newIncarnationId(),
      startedAtMs: this.host.now(),
      termSentAtMs: null,
      child,
      exited: false,
    };
    this.byAgent.set(agentId, record);

    child.on('exit', (code, signal) => {
      if (record.exited) return;
      record.exited = true;
      // **표에서 지금 세대일 때만 뺀다.** 늦게 온 exit 이 그 사이 새로 뜬 러너의 자리를
      // 비우면, 앱은 살아 있는 러너를 죽은 것으로 보고 또 하나를 띄운다.
      if (this.byAgent.get(agentId) === record) this.byAgent.delete(agentId);
      this.onExit({
        agentId,
        incarnationId: record.incarnationId,
        code: code ?? null,
        signal: signal ?? null,
      });
    });
    // `unref` 는 하지 않는다 — daemon 이 이 자식의 종료를 관측해야 `runnerExit` 을 보낼
    // 수 있고, 그것이 이 표의 존재 이유다. 프로세스 그룹 분리는 `detached` 가 이미 했다.

    return record;
  }

  /**
   * 러너를 종료시킨다 — **SIGTERM 을 보내고 기다린다. 그것이 전부다.**
   *
   * ## 이것은 회수가 아니다 (`#337` 과 무엇이 다른가)
   *
   * 이 저장소에는 프로세스를 유예 뒤 SIGKILL 로 승격시키는 경로가 이미 있다 —
   * `#337` 의 고아 PTY 회수(`interactiveTurn.ts`):
   *
   * ```ts
   * state.cancelKill = schedule(
   *   () => { if (!state.exited) state.controls?.kill('SIGKILL'); },
   *   killGraceMs,
   * );
   * ```
   *
   * **겉모습이 같고 목적이 반대다.**
   *
   * | | `#337` 고아 회수 | 여기(러너 종료) |
   * |---|---|---|
   * | 대상 | **볼 사람이 없는** PTY (viewer 0) | **사람이 답을 기다리는** 턴을 도는 러너 |
   * | 목표 | 빨리 끝낸다 | **끝까지 기다린다** |
   * | SIGKILL 승격 | **있다**(유예 뒤) | **없다** |
   * | 잃는 것 | 없다 — 세션은 디스크에 있다 | **사람이 기다리던 답** |
   *
   * `interactiveTurn.ts` 가 그 자리에 근거를 적어 뒀다 — *"세션은 디스크라 kill 로
   * 잃는 것이 없다"*. 그 근거가 **여기서는 성립하지 않는다.** 진행 중인 멘션 턴에서
   * 잃는 것은 세션이 아니라 아직 어디에도 없는 답이다.
   *
   * ## 왜 타임아웃을 걸지 않는가 — daemon 은 답할 자격이 없다
   *
   * "이 정도면 됐다"를 정하려면 *"지금 이 러너가 되찾을 수 없는 것을 들고 있는가"* 를
   * 알아야 한다. 그 답은 턴 경계에서 뒤집히고(`mentionTurn.ts` 의 `put()` 전후), 그것을
   * 알려면 `sessions.json` 을 읽어야 한다 — **D5 가 금지한 바로 그것이다.**
   *
   * 즉 daemon 에게 그 질문은 **답을 얻는 유일한 경로가 금지된 질문**이다. 그래서 답이
   * 하나로 정해진다: **모르니까 기다린다.** 러너만이 자기 턴이 끝났는지 안다 —
   * 그리고 러너는 이미 그렇게 만들어져 있다(`packages/agent/src/main.ts`: SIGTERM 이
   * 플래그만 끄고, 진행 중인 배치를 마친 뒤에 루프를 벗어난다. 실측에서 12초쯤 걸렸다).
   *
   * **여기에 타이머를 넣지 마라.** 넣는 순간 사람이 기다리던 답이 조용히 사라지고,
   * `#428` 이 만든 세 상태 표시(요청 전 / 요청했으나 미수령 / 수령함)도 의미를 잃는다.
   * 그 대신 daemon 은 `termSentAtMs` 와 `alive` 를 노출한다 — *"보낸 지 N초 지났는데
   * 아직 살아 있다"* 를 **사람이** 읽고, 승격 여부도 **사람이** 정한다.
   *
   * 회귀선: `test/killRunner.test.ts` 의 "SIGTERM 뒤 아무리 기다려도 SIGKILL 을 보내지
   * 않는다" 가 이 성질 자체를 고정한다. 누가 승격 타이머를 넣으면 빨개진다.
   */
  killRunner(agentId: string, incarnationId?: IncarnationId): RunnerRecord | null {
    const record = this.byAgent.get(agentId);
    if (!record) return null;
    if (incarnationId !== undefined && record.incarnationId !== incarnationId) {
      // 세대가 어긋난 kill 이다 — 앱이 옛 세대를 죽이라고 보낸 명령이 그 사이 새로 뜬
      // 러너를 데려가면 안 된다. 없는 러너와 같이 취급한다.
      return null;
    }
    if (record.termSentAtMs === null) record.termSentAtMs = this.host.now();
    // **SIGTERM 하나. 여기서 끝이다.** 위 주석 참조 — 승격 타이머를 걸지 마라.
    this.host.kill(record.pid, 'SIGTERM');
    return record;
  }

  /**
   * 지금 아는 러너들. **`alive` 는 `kill(pid, 0)` 으로 커널에게 직접 묻는다.**
   *
   * 자식 핸들의 `exitCode` 를 보지 않는 이유: 그것은 Node 가 `SIGCHLD` 를 처리한 뒤에야
   * 채워지고, 그 사이 창에서 "아직 살아 있다"고 말한다. 커널에 직접 물으면 그 창이 없다.
   * 서버가 못 하는 말(`#428` 의 *"실제로 종료했는지는 murmur 가 알 수 없다"*)을 daemon 이
   * 할 수 있는 이유가 이 한 줄이다 — 자기가 spawn 했으므로 pid 를 안다.
   */
  listRunners(): RunnerInfo[] {
    const out: RunnerInfo[] = [];
    for (const record of this.byAgent.values()) {
      out.push({
        agentId: record.agentId,
        pid: record.pid,
        incarnationId: record.incarnationId,
        startedAtMs: record.startedAtMs,
        alive: this.host.kill(record.pid, 0),
        termSentAtMs: record.termSentAtMs,
      });
    }
    return out;
  }

  /** 표에 있는 세대. 회귀선이 "늦은 exit 이 새 세대를 안 지웠다"를 재는 자리다. */
  currentIncarnation(agentId: string): IncarnationId | null {
    return this.byAgent.get(agentId)?.incarnationId ?? null;
  }

  size(): number {
    return this.byAgent.size;
  }
}
