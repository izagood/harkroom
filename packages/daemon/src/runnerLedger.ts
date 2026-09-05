/**
 * 고아 러너를 다시 알아보기 위한 **장부** — `#431` 2단계-c(D5).
 *
 * ## 무엇을 푸는가
 *
 * daemon 은 자기 인메모리 표(`RunnerRegistry.byAgent`)에 없는 러너의 존재를 모른다.
 * 그런데 러너는 `setsid` 로 분리돼 있어 **daemon 이 죽어도 산다**(1단계의 결과이자 목적).
 * 그래서 이런 순서가 실제로 관측됐다(`#430` 코멘트):
 *
 * ```
 * daemon 이 죽는다 → 러너가 고아로 남는다(ppid=1) → 새 daemon 이 뜬다 → 그 러너를 모른다
 *                                                    → spawnRunner 가 중복 러너를 만든다
 * ```
 *
 * 이 장부는 그 사이를 잇는다. **디스크에 있고, daemon 재시작을 넘어 산다.**
 *
 * ## 무엇으로 고아를 찾는가 — 이 파일이고, 왜 이것인가
 *
 * 세 안을 놓고 골랐다.
 *
 * | 안 | 쓰는 주체 | 왜 아닌가 / 왜 이것인가 |
 * |---|---|---|
 * | presence(서버 `liveAccountIds`) | 서버 | **pid 를 모른다.** "어느 에이전트가 온라인인가"는 알아도 "이 머신의 어느 프로세스인가"를 모르니 `killRunner` 를 걸 수 없다. 그리고 실측에서 **러너 0개인데 online** 이 나왔다(`#430`) — 서버 왕복이라 창이 있다 |
 * | 프로세스 목록 훑기 | (없음) | 러너 argv 는 사이드카 경로 하나뿐이라 **어느 에이전트의 러너인지 알 수 없다.** `agentId` 는 env 에만 있고, macOS 는 남의 프로세스 env 를 `ps -E` 로 못 읽는다(실측 2026-09-06: 같은 uid 자식에도 안 나온다). 즉 이 경로만으로는 표를 복원할 수 없다 |
 * | **pid 기록 파일(이 모듈)** | **daemon 하나** | pid 와 `agentId` 를 함께 남기는 유일한 방법이고, **쓰는 주체가 하나**라 D5 의 단일 writer 원칙을 안 깬다 |
 *
 * ## 왜 러너가 아니라 daemon 이 쓰는가 (D5 의 단일 writer)
 *
 * 스펙(D5)은 "러너가 `~/.murmur-agent/<agent>-<instance>/` 에 자기 pid 를 남긴다"를
 * 제안했다. **채택하지 않았다.** 근거 셋:
 *
 * 1. **러너는 자기 `agentId` 를 늦게 안다.** `murmur.me()` 라는 네트워크 왕복이 끝나야
 *    안다(`packages/agent/src/main.ts`). 그 전에 죽으면 기록이 아예 없고, 그 창은
 *    서버가 느릴수록 넓어진다 — 정확히 고아가 잘 생기는 상황이다
 * 2. **daemon 은 spawn 하는 순간 다 안다** — `agentId`(앱이 줬다)·pid(커널이 줬다)·
 *    `incarnationId`. 늦게 아는 것이 없다
 * 3. **디렉터리의 writer 를 늘리지 않는다.** `~/.murmur-agent/<…>/` 는 러너의 영역이고
 *    `sessions.json` 이 거기 산다. daemon 이 그 트리에 파일을 만들면 "daemon 은 러너의
 *    상태 디렉터리를 건드리지 않는다"는 경계가 흐려지고, 다음 사람이 `sessions.json` 을
 *    읽는 것도 같은 정도의 일로 본다. **경계는 파일 단위가 아니라 디렉터리 단위로
 *    지켜야 지켜진다**
 *
 * 대신 받아들이는 한계: **daemon 이 죽은 뒤의 변화는 장부에 안 적힌다.** 러너가 daemon
 * 사후에 스스로 종료해도 장부에는 살아 있는 것으로 남는다. 그것을 `kill(pid, 0)` 과
 * 신원 확인이 걸러 낸다 — 장부는 *"이 pid 였다"* 만 말하고 *"지금 살아 있다"* 는 말하지
 * 않는다. **장부는 후보 목록이지 사실이 아니다.**
 *
 * ## `sessions.json` 은 여기 없다 (D5)
 *
 * 이 모듈이 읽고 쓰는 파일은 `<appDataDir>/daemon/runners-v1.json` 하나다. 세션 상태를
 * 담지 않고, 러너의 상태 디렉터리를 열지 않는다. 그 원자성은 "쓰는 주체가 하나(러너)"에서
 * 나오고 daemon 이 두 번째 writer 가 되면 lost update 가 **조용히** 난다.
 *
 * ## 왜 daemon 이 둘이어도 안전한가
 *
 * 장부는 `<appDataDir>/daemon/` 에 있고 그 자리의 소켓은 **하나의 daemon 만** 가진다
 * (2-a 의 `claimDaemonEndpoint`). 즉 이 파일에 쓰는 daemon 도 언제나 하나다 — 진 daemon 은
 * 서비스를 시작하지 못하고 물러난다. 그럼에도 쓰기는 **임시 파일 + rename** 으로 한다:
 * 쓰다가 죽으면 반쯤 쓰인 JSON 이 남고, 그러면 다음 daemon 이 장부 전체를 잃는다.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IncarnationId } from '@murmur/shared/daemonProtocol';

/**
 * 장부 파일 이름 — **버전이 박혀 있다.**
 *
 * 소켓(`daemon-v1.sock`)과 같은 이유다: 항목의 모양이 바뀌면 이름을 올리고, 그 순간
 * 신·구 daemon 은 서로의 장부를 **아예 보지 못한다.** 마이그레이션 코드가 한 줄도
 * 필요 없고, 옛 daemon 이 새 형식을 오해해 남의 러너를 채택하는 일도 없다.
 *
 * 소켓 버전과 따로 두는 이유: 프로토콜이 그대로여도 장부 항목만 바뀔 수 있고 그 반대도
 * 마찬가지다. 하나로 묶으면 한쪽 변경이 다른 쪽의 세대를 이유 없이 끊는다.
 */
export const RUNNER_LEDGER_VERSION = 1;

export function runnerLedgerPath(appDataDir: string): string {
  return join(appDataDir, 'daemon', `runners-v${RUNNER_LEDGER_VERSION}.json`);
}

/**
 * 장부 한 줄 — **spawn 순간의 사실만** 담는다.
 *
 * 여기 "지금 살아 있다" 류의 필드가 없는 것이 요점이다. 그런 필드를 두면 daemon 이 죽은
 * 뒤 그 값이 낡는데, 낡았다는 것을 아무도 모른다. 대신 생사는 읽는 쪽이 `kill(pid, 0)`
 * 으로 그 자리에서 커널에게 묻는다.
 */
export interface RunnerLedgerEntry {
  agentId: string;
  pid: number;
  incarnationId: IncarnationId;
  /**
   * 러너를 spawn 한 시각(daemon 의 시계).
   *
   * **pid 재사용을 가르는 축이 아니다** — 그것은 아래 `bootTimeSec` 이다. 이 값은
   * `spawn` 을 *호출한* 시각이라 커널의 시작 시각과 어긋나고, 그 오차를 허용하려면
   * 창을 둬야 하는데 창을 두는 순간 그 안에 뜬 무관한 프로세스가 통과한다
   * (`adopt.ts` 모듈 주석). 여기서는 **같은 에이전트의 낡은 줄과 최신 줄을 가르는 데**
   * 쓴다(`planAdoption`).
   */
  startedAtMs: number;
  /**
   * 러너 프로세스의 **커널 시작 시각**(초 단위 epoch). `ps -o lstart` 를 읽어 담는다.
   *
   * **이것이 pid 재사용 방어의 실체다.** `startedAtMs` 는 daemon 의 시계이고 spawn 호출
   * 시점이라 커널의 것과 몇 ms 어긋나지만, 이 값은 **그 pid 를 가진 프로세스 자신의
   * 사실**이다. 무관한 프로세스가 같은 pid 를 물려받았다면 시작 시각이 다르다.
   *
   * 읽지 못했으면 `null` — 그러면 채택하지 않는다(`adopt.ts` 의 `judgeCandidate` 참조). 확인할 수 없는
   * 것을 채택하는 것보다 안 하는 쪽이 복구 가능하다: 안 채택하면 중복 러너가 생기지만
   * 잘못 채택하면 **무관한 프로세스에 SIGTERM 을 보낸다.**
   */
  bootTimeSec: number | null;
  /** 이 러너를 띄운 daemon 의 `launchNonce`. 사람이 장부를 읽을 때의 출처 표시다. */
  spawnedByNonce: string;
}

interface LedgerFile {
  version: number;
  runners: RunnerLedgerEntry[];
}

/**
 * 장부를 읽는다. **없거나 깨졌으면 빈 목록이다 — 던지지 않는다.**
 *
 * 던지면 장부 하나가 깨졌다는 이유로 daemon 이 아예 안 뜬다. 그런데 장부가 없는 것은
 * 정상 상태이기도 하다(첫 기동). 두 경우를 같게 다루는 대가는 "고아를 못 찾는다" 하나이고,
 * 그것은 2-c 이전의 동작으로 돌아가는 것뿐이다 — 안 뜨는 것보다 훨씬 낫다.
 *
 * 버전이 다르면 **읽지 않는다.** 항목의 모양을 모르는 채 pid 를 꺼내 쓰면 무관한
 * 프로세스를 채택할 수 있다.
 */
export async function readRunnerLedger(appDataDir: string): Promise<RunnerLedgerEntry[]> {
  let text: string;
  try {
    text = await readFile(runnerLedgerPath(appDataDir), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const file = parsed as Partial<LedgerFile>;
    if (file.version !== RUNNER_LEDGER_VERSION) return [];
    if (!Array.isArray(file.runners)) return [];
    return file.runners.filter(isEntry);
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is RunnerLedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Partial<RunnerLedgerEntry>;
  return (
    typeof e.agentId === 'string' &&
    e.agentId.length > 0 &&
    typeof e.pid === 'number' &&
    Number.isInteger(e.pid) &&
    e.pid > 0 &&
    typeof e.incarnationId === 'string' &&
    typeof e.startedAtMs === 'number' &&
    (e.bootTimeSec === null || typeof e.bootTimeSec === 'number')
  );
}

/**
 * 장부를 통째로 다시 쓴다 — **임시 파일 + rename** 이다.
 *
 * 제자리에 쓰면 쓰는 중에 daemon 이 죽었을 때 반쯤 쓰인 JSON 이 남고, 다음 daemon 은
 * 파싱에 실패해 **장부 전체를 잃는다**(위 `readRunnerLedger` 의 관대한 처리 때문에
 * 조용히 잃는다). rename 은 원자적이라 그 창이 없다.
 *
 * 여기서 `rename` 을 쓰는 것이 `daemonEndpoint` 가 `link` 를 고집하는 것과 모순되지
 * 않는다: 거기서 막으려던 것은 **살아 있는 남의 소켓을 덮어쓰는 것**이었고, 여기서는
 * 덮어쓰는 것이 정확히 의도다 — 이 파일의 writer 는 지금 서비스 중인 daemon 하나뿐이다
 * (모듈 주석의 "왜 daemon 이 둘이어도 안전한가").
 *
 * **실패해도 던지지 않는다.** 장부를 못 쓰는 것은 다음 daemon 이 고아를 못 찾는다는
 * 뜻이지 지금 러너가 잘못됐다는 뜻이 아니다. 여기서 던지면 `spawnRunner` 가 실패하고,
 * 그러면 **실제로 뜬 러너를 앱이 못 뜬 것으로 본다** — 그것이 훨씬 나쁘다. 사유는
 * 로그로 올린다(`#368`).
 *
 * ## 임시 이름에 난수를 붙이는 이유 — 실물 검증이 잡았다 (2026-09-06)
 *
 * 처음에는 `.tmp-<pid>` 였다. **같은 프로세스 안에서 두 쓰기가 겹치면 이름이 같다.**
 * 이 함수의 호출은 fire-and-forget(`run.ts` 의 `ledgerSink`)이라 겹치는 것이 정상이고,
 * 실물 검증 B(러너 둘을 잇달아 채택)에서 실제로 겹쳐 이렇게 났다:
 *
 * ```
 * 러너 장부를 쓰지 못했다: ENOENT: rename 'runners-v1.json.tmp-5499' -> 'runners-v1.json'
 * ```
 *
 * 두 번째 쓰기가 첫 번째의 임시 파일에 쓰는 사이 첫 번째가 그것을 `rename` 으로
 * 가져갔다. **더 나쁜 것은 이것이 조용한 실패라는 점이다** — 던지지 않으므로 daemon 은
 * 계속 돌고, 장부만 낡은 채로 남는다. 그 장부는 다음 daemon 을 잘못된 후보로 이끈다.
 *
 * 난수를 붙이면 두 쓰기가 서로의 임시 파일을 못 본다. 마지막 `rename` 이 이기는 것은
 * 그대로이고(스냅샷을 통째로 쓰므로 부분 상태가 없다), 그것이 의도다.
 */
export async function writeRunnerLedger(
  appDataDir: string,
  entries: readonly RunnerLedgerEntry[],
  log: (line: string) => void = () => undefined,
): Promise<void> {
  const path = runnerLedgerPath(appDataDir);
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const body: LedgerFile = { version: RUNNER_LEDGER_VERSION, runners: [...entries] };
  try {
    await mkdir(join(appDataDir, 'daemon'), { recursive: true });
    // 0600 — 장부에는 pid 와 agentId 가 있다. 비밀은 아니지만 소켓·토큰과 같은
    // 디렉터리에 있고, 같은 자리의 파일이 서로 다른 권한을 갖는 것 자체가 사고의 씨앗이다.
    await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    log(`러너 장부를 쓰지 못했다: ${err instanceof Error ? err.message : String(err)}`);
  }
}
