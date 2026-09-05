/**
 * 고아 러너를 **다시 소유한다** — `#431` 2단계-c(D5).
 *
 * 장부(`runnerLedger.ts`)가 후보를 준다. 이 모듈은 그 후보 하나하나에 대해
 * **"정말 그 러너인가"** 를 묻고, 답이 확실할 때만 채택한다.
 *
 * ## 채택한다는 것은 죽일 권한을 갖는다는 뜻이다
 *
 * 채택된 러너는 `killRunner` 의 대상이 된다. 즉 잘못 채택하면 **무관한 프로세스에
 * SIGTERM 을 보낸다.** 그래서 이 모듈의 모든 판정은 한쪽으로 기운다:
 *
 * > 확실하지 않으면 채택하지 않는다.
 *
 * 안 채택하면 중복 러너가 생긴다 — 나쁘지만 사람이 보고 정리할 수 있다.
 * 잘못 채택하면 남의 프로세스를 죽인다 — 되돌릴 수 없다.
 *
 * ## "남의 러너를 채택할 수 있는가" — 이 설계의 안전 경계
 *
 * **없다. 그리고 그 이유가 이 설계를 고른 이유이기도 하다.**
 *
 * 후보의 출처가 **이 daemon 의 `appDataDir` 아래 장부 하나**다. 그 장부에는
 * **이 daemon 계보가 자기 손으로 spawn 한 pid** 만 적힌다. 프로세스 목록을 훑지 않으므로
 * 훑기가 안고 있는 세 결함이 원리적으로 없다(실측 2026-09-06, 이 기계에 실재하는 상황):
 *
 * | 훑기의 결함 | 실측 | 이 설계에서는 |
 * |---|---|---|
 * | `ppid` 로 못 거른다 | 고아 러너 6개가 전부 `ppid=1` — 고아는 정의상 그렇다 | `ppid` 를 안 본다 |
 * | 경로가 같다 | 다른 워크트리(permit)의 러너 6개가 **완전히 같은 실행 경로** | 경로를 안 본다 |
 * | 어느 에이전트의 것인지 모른다 | `agentId` 는 env 에만 있고 macOS 는 남의 env 를 못 읽는다 | 장부가 `agentId` 를 함께 적어 뒀다 |
 *
 * 다른 워크트리·다른 빌드의 러너는 **다른 `appDataDir`** 를 쓰므로 이 장부에 이름이
 * 오르지 않는다. 오를 방법 자체가 없다 — 장부에 쓰는 것은 `RunnerRegistry.spawnRunner`
 * 뿐이고 그것은 자기가 띄운 자식의 pid 만 안다.
 *
 * 회귀선: `test/adopt.test.ts` 의 **"장부에 없는 남의 러너는 채택하지 않는다"** 가
 * 같은 실행 경로의 프로세스를 여럿 띄워 놓고 장부에 적힌 하나만 채택되는지를 잰다.
 *
 * ## pid 재사용 — 어떻게 다뤘는가
 *
 * `kill(pid, 0)` 이 성공해도 그것이 **내가 아는 그 프로세스**라는 보장이 없다. pid 는
 * OS 가 돌려 쓴다. 장부의 pid 가 죽고 무관한 프로세스가 그 번호를 물려받았다면,
 * `kill(pid, 0)` 만 보고 채택하는 daemon 은 **남의 프로세스를 자기 러너로 표에 올리고
 * 나중에 SIGTERM 을 보낸다.**
 *
 * 그래서 **커널이 아는 프로세스 시작 시각**을 대조한다(`ps -o lstart`). 이 값은 우리가
 * 쓴 것이 아니라 그 pid 를 가진 프로세스 자신의 사실이므로, pid 가 재사용됐으면
 * 반드시 달라진다.
 *
 * **`startedAtMs`(daemon 의 시계)를 그 축으로 쓰지 않는 이유**: 그것은 spawn 을 *호출한*
 * 시각이라 커널의 시작 시각과 몇 ms~수백 ms 어긋난다. 그 오차를 허용하려면 창을 둬야
 * 하고, 창을 두는 순간 "그 창 안에 뜬 무관한 프로세스"가 통과한다. 커널 값끼리 비교하면
 * 창이 필요 없다.
 *
 * **남는 한계 — 명시한다:**
 *
 * - `ps -o lstart` 의 해상도는 **1초**다(실측 2026-09-06, macOS). 즉 *같은 초에* 죽은
 *   러너의 pid 를 물려받은 프로세스는 구분되지 않는다. pid 가 한 바퀴(macOS 기본
 *   99998)를 도는 데 걸리는 시간에 비하면 극히 좁은 창이지만 **0 은 아니다**
 * - Windows 에는 `ps` 가 없다. 지금 `bootTime` 은 `null` 이 되고, `null` 은 **채택하지
 *   않는다**로 흐른다 — 즉 Windows 에서 이 기능은 "안전하게 아무것도 안 한다". 그
 *   플랫폼의 대응(`CreateToolhelp32Snapshot` 등)은 이 단계 밖이다
 * - **launch nonce 로는 못 가린다.** nonce 를 러너의 env 에 넣어도 macOS 에서 남의
 *   프로세스 env 를 읽을 수 없고(실측: `ps -Eww` 가 같은 uid 자식에도 안 보여 준다),
 *   러너가 그것을 파일에 적게 하면 D5 의 단일 writer 가 깨진다(러너가 두 번째 writer 가
 *   된다). 그래서 nonce 는 **출처 표시**로만 장부에 남기고 판정에는 안 쓴다
 */
import { execFile } from 'node:child_process';

import type { RunnerLedgerEntry } from './runnerLedger.js';

/** 프로세스 신원을 묻는 표면. 회귀선이 실물 없이 판정 로직을 밟게 한다. */
export interface ProcessIdentityProbe {
  /**
   * 그 pid 의 **커널 시작 시각**(초 단위 epoch). 프로세스가 없으면 `null`.
   *
   * 이 값을 못 얻는 것과 프로세스가 없는 것을 **같게 다룬다** — 둘 다 "신원을 확인할 수
   * 없다"이고, 이 모듈은 확인 못 한 것을 채택하지 않는다.
   */
  bootTimeSec(pid: number): Promise<number | null>;
  /** `kill(pid, 0)`. 존재만 확인한다. */
  alive(pid: number): boolean;
}

/**
 * `ps -o lstart=` 로 시작 시각을 읽는다.
 *
 * `etime`(경과 시간)이 아니라 `lstart`(시작 시각)인 이유: `etime` 은 *지금* 을 기준으로
 * 한 상대값이라 두 시점에 재면 값이 달라진다. 장부에 적은 값과 나중에 읽은 값을 대조하는
 * 것이 이 판정의 전부이므로 **절대값이어야 한다.**
 *
 * `-p <pid>` 한 건만 묻는다. 목록을 훑지 않는다 — 훑는 순간 "남의 러너가 후보에 오를 수
 * 있는가"라는 질문이 다시 생긴다(모듈 주석의 안전 경계).
 */
export const psIdentityProbe: ProcessIdentityProbe = {
  async bootTimeSec(pid) {
    if (process.platform === 'win32') return null; // 위 "남는 한계" 참조.
    return await new Promise<number | null>((resolve) => {
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 3000 }, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const text = stdout.trim();
        if (text.length === 0) {
          resolve(null);
          return;
        }
        const ms = Date.parse(text);
        // `lstart` 는 1초 해상도라 초 단위로 자른다 — 남은 ms 는 의미가 없고, 남겨 두면
        // 파싱 구현 차이가 대조 실패로 나타난다.
        resolve(Number.isNaN(ms) ? null : Math.floor(ms / 1000));
      });
    });
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
};

/** 후보 하나에 대한 판정. **사유가 값으로 흐른다** — 로그가 "왜 안 채택했나"를 말한다. */
export type AdoptionVerdict =
  /** 살아 있고 신원이 맞다. 표에 올린다. */
  | { kind: 'adopt' }
  /** `kill(pid, 0)` 이 실패했다 — 그 pid 는 없다. */
  | { kind: 'dead' }
  /** 장부에 커널 시작 시각이 없다. 대조할 축이 없으니 채택하지 않는다. */
  | { kind: 'unverifiable'; reason: string }
  /** 살아는 있는데 시작 시각이 다르다 — **pid 가 재사용됐다.** */
  | { kind: 'pid-reused'; expected: number; actual: number | null };

/**
 * 후보 하나를 판정한다.
 *
 * 순서가 의미를 갖는다: **생사를 먼저 묻는다.** 죽은 pid 에 `ps` 를 부르는 것은 낭비이고,
 * 더 중요하게는 `dead`(정상적으로 끝난 러너)와 `pid-reused`(위험한 상황)를 로그에서
 * 가를 수 있어야 한다 — 둘을 뭉치면 pid 재사용이 실제로 일어나도 아무도 모른다.
 */
export async function judgeCandidate(
  entry: RunnerLedgerEntry,
  probe: ProcessIdentityProbe,
): Promise<AdoptionVerdict> {
  if (!probe.alive(entry.pid)) return { kind: 'dead' };
  if (entry.bootTimeSec === null) {
    return {
      kind: 'unverifiable',
      reason: 'spawn 당시 커널 시작 시각을 기록하지 못했다 — pid 재사용을 가릴 축이 없다',
    };
  }
  const actual = await probe.bootTimeSec(entry.pid);
  if (actual === null) {
    // 살아 있다고 했는데 시작 시각을 못 읽었다 — 그 사이 죽었거나 `ps` 가 막혔다.
    // 어느 쪽이든 **확인 못 한 것**이고, 확인 못 한 것은 채택하지 않는다.
    return { kind: 'pid-reused', expected: entry.bootTimeSec, actual: null };
  }
  if (actual !== entry.bootTimeSec) {
    return { kind: 'pid-reused', expected: entry.bootTimeSec, actual };
  }
  return { kind: 'adopt' };
}

/** 장부 전체를 판정한 결과. 채택할 것과 버릴 것이 함께 온다. */
export interface AdoptionPlan {
  adopt: RunnerLedgerEntry[];
  /** 채택하지 않은 것들. **사유를 달고 온다** — 로그가 그대로 사람에게 간다(`#368`). */
  rejected: { entry: RunnerLedgerEntry; verdict: Exclude<AdoptionVerdict, { kind: 'adopt' }> }[];
}

/**
 * 장부의 모든 후보를 판정해 계획을 만든다.
 *
 * **한 `agentId` 에 항목이 둘 이상이면 최신 것만 채택한다.** 장부는 정상 흐름에서
 * 에이전트당 한 줄이지만, daemon 이 장부를 쓰다 죽는 등으로 낡은 줄이 남을 수 있다.
 * 둘 다 채택하면 표가 에이전트당 하나라는 성질(`RunnerRegistry.byAgent`)이 조용히
 * 깨진다 — 나중에 들어온 것이 앞의 것을 덮어 **앞의 러너가 아무도 모르는 고아**가 된다.
 * 그럴 바에는 여기서 명시적으로 최신 하나만 고르고, 나머지는 사유를 달아 로그에 남긴다.
 */
export async function planAdoption(
  entries: readonly RunnerLedgerEntry[],
  probe: ProcessIdentityProbe,
): Promise<AdoptionPlan> {
  const plan: AdoptionPlan = { adopt: [], rejected: [] };
  const 최신: Map<string, RunnerLedgerEntry> = new Map();
  for (const entry of entries) {
    const seen = 최신.get(entry.agentId);
    if (!seen || entry.startedAtMs > seen.startedAtMs) 최신.set(entry.agentId, entry);
  }
  for (const entry of entries) {
    if (최신.get(entry.agentId) !== entry) {
      plan.rejected.push({
        entry,
        verdict: {
          kind: 'unverifiable',
          reason: `같은 에이전트에 더 최신 항목이 있다 — 표는 에이전트당 하나다`,
        },
      });
      continue;
    }
    const verdict = await judgeCandidate(entry, probe);
    if (verdict.kind === 'adopt') plan.adopt.push(entry);
    else plan.rejected.push({ entry, verdict });
  }
  return plan;
}

/** 로그 한 줄. 사람이 "왜 안 채택했나"를 읽는 자리다. */
export function describeVerdict(
  entry: RunnerLedgerEntry,
  verdict: Exclude<AdoptionVerdict, { kind: 'adopt' }>,
): string {
  const head = `채택 안 함: agent=${entry.agentId} pid=${entry.pid}`;
  switch (verdict.kind) {
    case 'dead':
      return `${head} — 그 pid 가 없다(정상적으로 끝난 러너다)`;
    case 'unverifiable':
      return `${head} — ${verdict.reason}`;
    case 'pid-reused':
      return (
        `${head} — **pid 가 재사용됐다.** 장부의 시작 시각 ${verdict.expected}, ` +
        `지금 그 pid 의 시작 시각 ${verdict.actual ?? '(못 읽음)'} — 무관한 프로세스다`
      );
  }
}
