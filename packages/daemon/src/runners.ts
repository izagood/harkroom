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
 * 그래서 이 표는 **프로세스 사실만** 담는다. daemon 이 죽으면 표는 사라지지만 러너는
 * 산다 — 그 러너를 다시 알아보는 것이 2-c(고아 재발견)이고, 그것도 세션 파일이 아니라
 * **별도 장부**(`runnerLedger.ts`)로 푼다. 그 장부의 writer 도 daemon 하나뿐이다.
 *
 * ## 2-c 가 더한 것 — 표에 두 종류의 러너가 있다
 *
 * | | 내가 띄운 것 | **채택한 것**(2-c) |
 * |---|---|---|
 * | `child` | 있다 | **`null`** — 내 자식이 아니다 |
 * | 종료를 어떻게 아나 | `child.on('exit')` | **`kill(pid, 0)` 폴링** |
 * | `killRunner` | 된다 | **된다** (pid 만 있으면 SIGTERM 은 보낸다) |
 *
 * `child` 가 `null` 인 경로를 두는 것이 이 표의 유일한 구조 변경이다. 그 자리에 가짜
 * 핸들을 세우지 않는 이유: 가짜는 `exit` 을 영영 안 보내므로 "핸들이 있다"는 사실이
 * **거짓말**이 되고, 종료 통지 경로가 조용히 끊긴다. `null` 이면 타입이 그 갈래를
 * 강제로 다루게 만든다.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import {
  newIncarnationId,
  type IncarnationId,
  type RunnerInfo,
} from '@murmur/shared/daemonProtocol';

import { psIdentityProbe } from './adopt.js';

/** 러너 하나에 대해 daemon 이 들고 있는 사실. **전부 프로세스 수준이다.** */
export interface RunnerRecord {
  agentId: string;
  pid: number;
  incarnationId: IncarnationId;
  startedAtMs: number;
  /** SIGTERM 을 보낸 때. 안 보냈으면 `null`. **관측이지 판단이 아니다.** */
  termSentAtMs: number | null;
  /**
   * 자식 핸들. 종료 통지의 출처다.
   *
   * **채택한 러너는 `null` 이다** — 앞선 daemon 의 자식이었으므로 이 프로세스에는
   * 핸들이 없다. 그 러너의 종료는 `pollAdopted()` 가 `kill(pid, 0)` 으로 관측한다.
   */
  child: ChildProcess | null;
  /** 종료를 이미 관측했는가. 늦은 이벤트를 두 번 보내지 않기 위한 것. */
  exited: boolean;
  /** 이 세대의 커널 시작 시각(초). 장부에 실려 pid 재사용 방어의 축이 된다(`adopt.ts`). */
  bootTimeSec: number | null;
  /** 채택된 러너인가. `child === null` 과 같은 뜻이지만 **뜻이 다르므로** 따로 둔다. */
  adopted: boolean;
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
  /**
   * 그 pid 의 **커널 시작 시각**(초 단위 epoch). 못 읽으면 `null`.
   *
   * 장부에 실려 다음 daemon 의 pid 재사용 방어가 된다(`adopt.ts` 모듈 주석).
   * 여기 있는 이유는 회귀선이 이 값을 마음대로 세워 "pid 는 살아 있는데 시작 시각이
   * 다르다"는 상황을 실제로 만들 수 있어야 하기 때문이다 — 그 상황은 실물로는 pid 가
   * 한 바퀴 돌아야 나온다.
   */
  bootTimeSec(pid: number): Promise<number | null>;
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
  // `ps -o lstart` 한 줄. 구현과 그 한계는 `adopt.ts` 의 `psIdentityProbe` 가 갖는다 —
  // 두 곳에 두면 한쪽만 고쳐지는 날이 온다.
  bootTimeSec: (pid) => psIdentityProbe.bootTimeSec(pid),
};

/** 러너를 띄울 때 쓸 고정값. **웹뷰나 클라이언트가 프로그램·인자를 고르지 못한다.** */
export interface RunnerLaunchSpec {
  /** 러너 사이드카의 절대 경로. daemon 이 자기 위치에서 스스로 찾는다. */
  command: string;
  /** 인자. **리터럴로 못박는다**(`#250` 의 경계) — 지금은 비어 있다. */
  args: readonly string[];
}

/**
 * 장부를 잇는 자리(`#431` 2-c). **주입으로 받는다** — 표가 파일 경로를 직접 알면
 * 회귀선이 이 로직을 재려고 매번 디스크를 마련해야 하고, 더 나쁘게는 표가
 * "어디에 쓰는가"까지 정하게 되어 D5 의 writer 경계가 두 곳으로 흩어진다.
 */
export interface LedgerSink {
  /** 표가 바뀔 때마다 불린다. 지금 표 전체가 실려 온다 — 증분이 아니라 스냅샷이다. */
  save(records: readonly RunnerRecord[]): void;
}

export class RunnerRegistry {
  /** `agentId` → 지금 세대. **에이전트당 하나**다 — 둘이면 멘션을 나눠 집어 간다. */
  private readonly byAgent = new Map<string, RunnerRecord>();

  constructor(
    private readonly launch: RunnerLaunchSpec,
    private readonly host: RunnerHost = nodeRunnerHost,
    /** 러너가 끝났을 때 불린다. `incarnationId` 가 실려 나간다. */
    private readonly onExit: (notice: RunnerExitNotice) => void = () => undefined,
    /** 장부에 흘려 보낼 자리. 없으면 안 쓴다 — 회귀선 대부분은 장부가 필요 없다. */
    private readonly ledger: LedgerSink | null = null,
  ) {}

  /** 지금 표 전체. 장부에 쓰기 위해서만 쓰인다. */
  private records(): RunnerRecord[] {
    return [...this.byAgent.values()];
  }

  private saveLedger(): void {
    this.ledger?.save(this.records());
  }

  /**
   * 러너를 띄운다.
   *
   * 같은 에이전트에 **살아 있는 러너가 이미 있으면 새로 띄우지 않고 그것을 돌려준다** —
   * 같은 에이전트에 러너가 둘이면 서버의 멘션을 나눠 집어 가고, 그러면 답이 반쪽씩
   * 갈린다(`#431` D5 의 중복 러너 금지와 같은 자리).
   */
  async spawnRunner(agentId: string, env: Record<string, string>): Promise<RunnerRecord> {
    const existing = this.byAgent.get(agentId);
    if (existing && !existing.exited && this.host.kill(existing.pid, 0)) {
      // ── 중복을 안 띄운다 — **채택한 러너도 여기서 걸린다**(`#431` 2-c) ──────────
      // 이 판정이 보는 것은 `byAgent` 하나뿐이고, 채택된 러너도 거기 있다. 그래서
      // "daemon 이 재시작한 뒤 앱이 spawnRunner 를 불렀다"는 경로에서 중복이 안 생긴다.
      // 그 전에는 표가 비어 있어 매번 새로 떴고, 그것이 `#430` 이 관측한 중복이다.
      //
      // 회귀선: `test/adopt.test.ts` 의 "채택한 에이전트에 spawnRunner 가 와도 새로
      // 띄우지 않는다".
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
      // 아래에서 커널에게 물어 채운다. 못 채우면 `null` 이고, 그러면 다음 daemon 이
      // 이 러너를 **채택하지 않는다**(`adopt.ts` 의 `unverifiable`).
      bootTimeSec: null,
      adopted: false,
    };
    this.byAgent.set(agentId, record);

    child.on('exit', (code, signal) => {
      if (record.exited) return;
      record.exited = true;
      // **표에서 지금 세대일 때만 뺀다.** 늦게 온 exit 이 그 사이 새로 뜬 러너의 자리를
      // 비우면, 앱은 살아 있는 러너를 죽은 것으로 보고 또 하나를 띄운다.
      if (this.byAgent.get(agentId) === record) this.byAgent.delete(agentId);
      // 장부도 함께 줄인다 — 안 그러면 정상 종료한 러너가 다음 daemon 의 후보로 남는다.
      // 그 후보는 `kill(pid, 0)` 에 걸려 `dead` 로 버려지므로 위험하진 않지만, pid 가
      // 재사용되면 그때는 `pid-reused` 판정에 의존하게 된다 — 방어를 하나 더 쌓는 것보다
      // 후보에서 지우는 것이 싸다.
      this.saveLedger();
      this.onExit({
        agentId,
        incarnationId: record.incarnationId,
        code: code ?? null,
        signal: signal ?? null,
      });
    });
    // `unref` 는 하지 않는다 — daemon 이 이 자식의 종료를 관측해야 `runnerExit` 을 보낼
    // 수 있고, 그것이 이 표의 존재 이유다. 프로세스 그룹 분리는 `detached` 가 이미 했다.

    // ── 커널 시작 시각을 **여기서** 읽는다 — 장부에 적기 전에 ────────────────────
    // 나중에 읽으면 그 사이에 러너가 죽고 pid 가 재사용될 수 있고, 그러면 **무관한
    // 프로세스의 시작 시각을 우리 러너의 것으로 장부에 적는다.** 그 장부는 다음 daemon 을
    // 정확히 잘못된 채택으로 이끈다. spawn 직후가 그 창이 가장 좁은 자리다.
    record.bootTimeSec = await this.host.bootTimeSec(pid);
    if (record.exited) {
      // 읽는 사이에 끝났다 — exit 핸들러가 이미 표와 장부를 정리했다. 여기서 다시 쓰면
      // 방금 지운 줄을 되살린다.
      return record;
    }
    this.saveLedger();
    return record;
  }

  /**
   * 앞선 daemon 이 남긴 고아 러너를 **표에 올린다** — `#431` 2-c 의 핵심 한 걸음.
   *
   * 신원 확인은 여기서 하지 않는다. `adopt.ts` 의 `planAdoption` 이 이미 했고, 이 함수는
   * 그 판정을 믿는다 — 판정을 두 곳에 두면 한쪽만 강화되는 날이 온다.
   *
   * **`incarnationId` 를 새로 만들지 않는다.** 장부의 것을 그대로 쓴다. 새로 만들면
   * 앱이 알고 있는 세대와 daemon 의 것이 갈리고, 그 러너에 대한 `killRunner` 가
   * "세대가 어긋난 kill" 로 조용히 거절된다 — 앱은 종료 명령을 보냈는데 아무 일도 안
   * 일어나는 상태가 된다.
   *
   * 이미 그 `agentId` 에 살아 있는 표가 있으면 **채택하지 않는다.** 채택이 지금 도는
   * 러너를 표에서 밀어내면 그 러너가 아무도 모르는 고아가 된다 — 고아를 없애려는 함수가
   * 고아를 만드는 셈이다.
   */
  adopt(entry: {
    agentId: string;
    pid: number;
    incarnationId: IncarnationId;
    startedAtMs: number;
    bootTimeSec: number | null;
  }): RunnerRecord | null {
    const existing = this.byAgent.get(entry.agentId);
    if (existing && !existing.exited && this.host.kill(existing.pid, 0)) return null;

    const record: RunnerRecord = {
      agentId: entry.agentId,
      pid: entry.pid,
      incarnationId: entry.incarnationId,
      startedAtMs: entry.startedAtMs,
      // **`null` 이다** — 이 daemon 은 그 러너에 SIGTERM 을 보낸 적이 없다. 앞선 daemon 이
      // 보냈을 수는 있지만 그 사실은 어디에도 안 남는다(장부는 spawn 순간만 담는다).
      // 여기에 추측으로 값을 넣으면 화면이 "N초 전에 보냈다"고 거짓말한다.
      termSentAtMs: null,
      child: null, // 내 자식이 아니다 — 위 `RunnerRecord.child` 주석 참조.
      exited: false,
      bootTimeSec: entry.bootTimeSec,
      adopted: true,
    };
    this.byAgent.set(entry.agentId, record);
    this.saveLedger();
    return record;
  }

  /**
   * 채택한 러너들의 생사를 **폴링해서** 확인하고, 끝난 것을 표에서 뺀다.
   *
   * ## 왜 폴링인가 — 다른 방법이 없다
   *
   * 내가 띄운 자식은 커널이 `SIGCHLD` 로 알려 준다. **채택한 러너는 내 자식이 아니라
   * 그 통지가 오지 않는다.** POSIX 에 "남의 프로세스가 죽으면 알려 달라"는 표면이 없다
   * (Linux 의 `pidfd`, macOS 의 `kqueue EVFILT_PROC` 이 있지만 Node 가 노출하지 않는다).
   * 그래서 물어보는 수밖에 없고, 이 함수가 그 자리다.
   *
   * **주기를 여기서 정하지 않는다** — 부르는 쪽이 정한다. 이 함수가 타이머를 들면
   * 회귀선이 실제 시간을 기다려야 하고, 무엇보다 `killRunner` 에 타이머를 걸지 않는다는
   * 이 모듈의 성질이 "여기엔 타이머가 있다"와 나란히 놓여 다음 사람을 헷갈리게 한다.
   *
   * 죽은 것을 발견하면 `onExit` 을 부른다 — **코드도 시그널도 모른다**(`null`). 지어내지
   * 않는다(`#368`): 우리가 아는 것은 "그 pid 가 이제 없다"뿐이다.
   */
  pollAdopted(): void {
    let changed = false;
    for (const record of [...this.byAgent.values()]) {
      if (!record.adopted || record.exited) continue;
      if (this.host.kill(record.pid, 0)) continue;
      record.exited = true;
      if (this.byAgent.get(record.agentId) === record) this.byAgent.delete(record.agentId);
      changed = true;
      this.onExit({
        agentId: record.agentId,
        incarnationId: record.incarnationId,
        // 채택한 러너의 종료 코드는 **알 수 없다** — 내 자식이 아니라 wait 할 수 없다.
        code: null,
        signal: null,
      });
    }
    if (changed) this.saveLedger();
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
   * 플래그만 끄고, 진행 중인 배치를 마친 뒤에 루프를 벗어난다).
   *
   * **얼마나 걸리는지는 정해져 있지 않다.** 실측 5회가 0초·12초·15~35초·23초·60초 이상으로
   * 갈렸다(`#431`). 러너는 `pollInbox(timeoutMs)` 안에 park 되어 있고 그 `timeoutMs` 는
   * **서버에 넘기는 파라미터이지 클라이언트 상한이 아니다** — 서버가 늦으면 러너는 계속
   * 기다린다. 즉 **상한이 코드에 없다.**
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
        adopted: record.adopted,
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
