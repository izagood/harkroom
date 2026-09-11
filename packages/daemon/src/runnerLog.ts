/**
 * 러너의 stdout·stderr 를 받는 **파일** — `#434`.
 *
 * ## 무엇이 문제였나
 *
 * daemon 이 러너를 띄울 때 `stdio: 'ignore'` 였다. 즉 러너가 죽으며 남긴 말이 전부
 * `/dev/null` 로 갔다. `#433`(사이드카가 `node-pty` 를 못 찾는다) 진단에서 화면이 준
 * 정보는 `종료 (기타: 코드 1)` 뿐이었고, 원인(`ERR_MODULE_NOT_FOUND`)은 사이드카를
 * 손으로 실행해서야 나왔다 — 저장소를 체크아웃할 수 있는 사람만 원인을 안다는 뜻이다.
 *
 * ## 왜 파이프가 아니라 파일인가 — **이것이 이 모듈의 존재 이유다**
 *
 * `stdio: 'ignore'` 옆의 주석이 이미 옳은 근거를 적어 뒀다:
 *
 * > 러너의 stdio 는 daemon 에 매달지 않는다. 매달면 daemon 이 죽을 때 파이프가 닫혀
 * > 러너가 EPIPE 로 죽을 수 있다 — "daemon 이 죽어도 러너는 산다"가 깨진다.
 *
 * **그 근거는 그대로 유효하다.** `#431` 전체가 "daemon 이 죽어도 러너는 산다"를 세우려고
 * 있는데, 파이프를 매다는 순간 daemon 의 수명이 러너의 수명에 다시 붙는다. 파이프의
 * 읽는 끝은 daemon 프로세스 안에 있고, daemon 이 죽으면 그 끝이 닫히며, 그 뒤 러너가
 * stdout 에 한 줄이라도 쓰면 `SIGPIPE`/`EPIPE` 를 받는다. Node 는 stdout 의 `EPIPE` 를
 * 기본으로 치명적으로 다루므로 러너가 그 자리에서 죽는다.
 *
 * 게다가 파이프에는 두 번째 함정이 있다: **daemon 이 살아 있어도 안 읽으면 막힌다.**
 * 파이프 버퍼(리눅스 64KiB, macOS 는 더 작다)가 차면 러너의 `write` 가 블록되고, 러너는
 * 로그 한 줄 때문에 턴 중간에 멈춘다.
 *
 * **파일에는 둘 다 없다.** 파일 디스크립터는 `spawn` 순간 자식에게 복제되고 그 뒤로
 * daemon 과 아무 관계도 없다 — daemon 이 SIGKILL 로 죽어도 그 fd 는 러너 안에서 그대로
 * 유효하고, 커널은 파일 쓰기를 블록하지 않는다.
 *
 * 앱이 이미 daemon 자신에게 같은 것을 하고 있다(`daemon_client.rs::daemon_command` 의
 * `Stdio::from(file)`) — 이 모듈은 그 한 단계를 러너에게 적용한다.
 *
 * ## 왜 러너마다 파일을 나누는가 (하나로 합치지 않는다)
 *
 * `#473` 이 이 판단의 근거다. 러너는 두 실패를 **로그의 마지막 줄**로 가른다:
 *
 * ```
 * harkroom-agent: credential rejected (revoked or rotated); exiting   ← PAT 를 재발급해라
 * harkroom-agent: harness executable not found; exiting               ← 하네스를 설치해라
 * ```
 *
 * 둘 다 종료 코드 78 이므로(`packages/agent/src/exit.ts`) **그 줄이 유일한 구분자**다.
 *
 * 파일 하나에 러너 전부를 합치면 그 구분자가 무너진다. 에이전트가 여럿이면 러너도
 * 여럿이고, 그것들이 동시에 쓴다 — 에이전트 A 가 78 로 죽는 순간 에이전트 B 가 평범한
 * 진행 줄을 쓰면, "A 의 마지막 줄"이 B 의 줄이 된다. 그리고 그 뒤섞임은 조용하다:
 * 앱은 엉뚱한 줄을 읽고 확신에 차서 틀린 안내를 한다 — 정확히 `#473` 이 고치려는 증상을
 * 다른 방식으로 재현하는 셈이다.
 *
 * 한 줄에 `agentId` 를 붙여 나중에 가르는 안도 있다. 채택하지 않았다: 그러려면 daemon 이
 * 러너의 출력을 **읽어서 가공**해야 하고, 그 순간 파이프가 필요해진다 — 위에서 파일을
 * 고른 이유가 통째로 사라진다.
 *
 * 대가는 파일 개수다. 에이전트 수만큼 생긴다. 그 대가를 받아들이는 이유는 사람이 로그를
 * 볼 때도 **"이 에이전트가 무슨 말을 했나"**로 보기 때문이다 — 합쳐 두면 사람도 매번
 * 갈라야 한다.
 *
 * ## 회전 — **넣는다. 다만 타이머 없이, spawn 순간에 한 번만 본다**
 *
 * 러너는 오래 산다(그것이 `#431` 의 목적이다). 오래 사는 프로세스의 append-only 로그는
 * 상한이 없으면 디스크를 채우고, 디스크가 차면 러너가 아니라 **기계 전체가** 망가진다.
 * 그래서 상한이 필요하다.
 *
 * 그런데 회전 방식이 이 구조와 맞아야 한다:
 *
 * | 안 | 왜 아닌가 |
 * |---|---|
 * | 도는 중에 파일을 잘라 낸다(`truncate`) | 러너가 들고 있는 fd 의 **오프셋은 안 줄어든다.** 다음 쓰기가 그 오프셋에 떨어져 파일 앞부분이 널(`\0`)로 찬 sparse 파일이 된다 |
 * | 도는 중에 `rename` 하고 새로 연다 | 러너의 fd 는 **inode 를 붙들고 있다.** 이름만 바뀌고 러너는 계속 옛 파일에 쓴다 — 새 파일은 영영 비어 있다. 러너에게 다시 열게 하려면 `SIGHUP` 같은 신호와 러너 쪽 처리가 필요하고, 그것은 `#431` 이 안 만들기로 한 러너↔daemon 채널이다 |
 * | **spawn 직전에만 본다(이 모듈)** | 러너가 그 파일을 아직 안 열었으므로 위 둘이 성립하지 않는다. 이름을 바꾸든 지우든 안전하다 |
 *
 * 그래서 **회전 시점은 `spawnRunner` 직전 한 번**이다. 타이머도, 감시도 없다 —
 * `killRunner` 에 타이머를 두지 않는다는 이 패키지의 성질(`runners.ts` 주석)과 같은 결이다.
 *
 * 이 방식이 **막지 못하는 것을 분명히 적는다**: 한 번 뜬 러너가 몇 달을 살며 자기 파일을
 * 무한히 키우는 경우다. 그 창을 막으려면 위 표의 두 안 중 하나가 필요하고 둘 다 러너를
 * 건드려야 한다. 지금 받아들이는 이유: 러너는 앱을 켜고 끌 때마다, PAT 를 회전할 때마다,
 * daemon 이 바뀔 때마다 다시 뜨므로 실제로는 회전 지점을 자주 지난다. 이 가정이 깨지면
 * (러너가 진짜로 몇 달을 산다면) 그때는 러너 쪽에 로그 상한을 두는 것이 옳다 —
 * 자기 파일의 크기를 아는 것은 러너 자신이다.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 러너 로그 하나의 크기 상한. 넘으면 spawn 직전에 `.1` 로 밀린다.
 *
 * 8MiB 는 "사람이 꼬리를 읽기에 충분하고, 에이전트 수십 개여도 디스크에 부담이 아닌"
 * 자리에서 고른 값이다. 러너 한 턴의 출력은 보통 수 KB 이므로 이 상한에 닿으려면
 * 수천 턴이 필요하다 — 즉 정상 사용에서 회전은 거의 안 일어나고, 일어난다면 그것 자체가
 * "이 러너가 아주 오래 살았다"는 사실이다.
 */
export const RUNNER_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 남겨 두는 옛 세대의 수. **1 이다** — `.1` 하나만 남기고 그 앞은 버린다.
 *
 * 여러 세대를 남기지 않는 이유: 이 로그의 쓰임은 *"방금 죽은 러너가 뭐라고 했나"*이고
 * 그 답은 언제나 현재 파일이나 바로 직전 파일에 있다. 세대를 늘리면 상한이 세대 수만큼
 * 곱해지는데, 얻는 것은 아무도 안 보는 과거다.
 */
export const RUNNER_LOG_KEEP = 1;

/**
 * exit 통지에 실어 보낼 꼬리의 줄 수(`#473`).
 *
 * 러너가 78 로 물러날 때 찍는 블록이 6줄이다(`exit.ts::runnerExitPlan` 의
 * `lines`) — 그 블록이 통째로 들어가야 사람이 "실행 파일: …", "자식에게 넘긴 PATH: …"
 * 까지 읽는다. 20 은 그 위에 여유를 둔 값이다.
 *
 * **상한이 있는 것이 요점이다.** 없으면 폭주한 러너의 로그 전체가 소켓 한 줄에 실려
 * `MAX_LINE_BYTES`(1MiB)를 넘기고, 그러면 daemon 은 exit 통지 자체를 못 보낸다 —
 * 로그를 보이려다 종료 통지를 잃는 것이 가장 나쁘다.
 */
export const RUNNER_EXIT_TAIL_LINES = 20;

/**
 * 꼬리를 읽을 때 파일 끝에서 되짚는 바이트 수.
 *
 * 파일 전체를 읽지 않는 이유: 상한이 8MiB 다. 마지막 몇 줄을 얻으려고 8MiB 를 메모리에
 * 올리면 daemon 이 그 순간 그만큼 부푼다 — 그리고 이 읽기는 러너가 죽을 때마다 일어난다.
 */
export const RUNNER_TAIL_READ_BYTES = 64 * 1024;

/**
 * `agentId` 를 파일 이름에 쓸 수 있는 꼴로 바꾼다.
 *
 * ## 왜 그대로 쓰지 않는가 — 경로 주입이다
 *
 * `agentId` 는 **소켓 너머에서 온다**(`spawnRunner` 의 payload). 그것을 그대로 이어
 * 붙이면 `../../../etc/x` 같은 값이 `<appDataDir>/daemon/` 밖의 파일을 daemon 권한으로
 * 열게 만든다. 그 파일은 append 로 열려 러너의 출력이 쏟아지고, 회전 경로에서는
 * `renameSync`·`unlinkSync` 까지 닿는다 — 즉 **임의 파일 파괴**다.
 *
 * `#431` 이 러너 실행 경로를 클라이언트에게 안 열어 둔 것과 같은 경계다(`#250`).
 * 여기서는 실행이 아니라 파일 경로이지만 성질은 같다: **소켓에서 온 문자열이 경로의
 * 일부가 되면 안 된다.**
 *
 * 그래서 `[A-Za-z0-9_-]` 밖의 문자를 전부 `_` 로 바꾼다. 실제 `agentId` 는 UUID 라
 * 운영에서는 한 글자도 안 바뀐다 — 이 함수가 일하는 것은 오직 비정상 입력에서다.
 *
 * 길이도 자른다. 파일 이름 상한(대부분의 파일시스템에서 255바이트)을 넘으면
 * `ENAMETOOLONG` 이 나고, 그 실패는 "로그가 안 남는다"로 늦게 드러난다.
 */
export function runnerLogFileName(agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  // 전부 걸러져 빈 문자열이 되면 이름이 `runner-.log` 가 된다 — 그것도 유효한 이름이지만
  // 어느 에이전트의 것인지 아무 말도 안 하므로, 그런 입력이 있었다는 사실을 이름에 남긴다.
  return `runner-${safe.length > 0 ? safe : 'unnamed'}.log`;
}

/** `<appDataDir>/daemon/runner-<agentId>.log`. **경로 규칙은 여기 하나뿐이다.** */
export function runnerLogPath(appDataDir: string, agentId: string): string {
  return join(appDataDir, 'daemon', runnerLogFileName(agentId));
}

/**
 * 러너에게 물려줄 로그 fd 하나. **열지 못하면 `null` 이다 — 던지지 않는다.**
 *
 * ## 왜 실패가 기동을 막지 않는가
 *
 * 로그는 **진단 수단이지 기동 조건이 아니다.** 로그 파일을 못 열었다고 러너를 안 띄우면
 * 이 진단 장치가 오히려 사고를 만든다 — 디스크가 찼거나 권한이 꼬였을 때 러너가 통째로
 * 안 뜨고, 그 사유는 (로그가 없으므로) 더 안 보인다.
 *
 * 앱이 daemon 로그에 대해 이미 같은 판단을 했다(`daemon_client.rs::daemon_command`:
 * *"여기서 실패해도 daemon 기동 자체는 막지 않는다"*). 같은 규율을 러너에 적용한다.
 *
 * **다만 못 열었다는 사실 자체는 남긴다** — `log` 로 올라가고, 그 줄은 daemon 자신의
 * 로그 파일(`daemon-v1.log`)에 떨어진다. 조용히 버리면 사람은 "로그가 0바이트인데
 * 실패가 없었던 것인지 안 찍힌 것인지" 를 또 못 가린다(`#434` 가 인용한 그 상황이다).
 */
export interface RunnerLogHandle {
  /** 자식의 stdout·stderr 로 넘길 파일 디스크립터. */
  fd: number;
  path: string;
  /** daemon 쪽 사본을 닫는다. **자식 fd 는 이미 복제됐으므로 영향받지 않는다.** */
  close(): void;
}

export interface OpenRunnerLogOptions {
  /** 회전 상한. 회귀선이 작은 값으로 실제 회전을 밟게 하려고 열어 둔다. */
  maxBytes?: number;
  log?: (line: string) => void;
}

/**
 * 러너 로그를 append 로 연다 — **필요하면 먼저 회전한다.**
 *
 * 순서가 중요하다: 회전이 **여는 것보다 먼저**다. 열고 나서 밀면 방금 연 fd 가 밀려난
 * 파일을 가리켜, 러너의 출력이 `.1` 에 떨어지고 현재 파일은 영영 비어 있다.
 */
export function openRunnerLog(
  appDataDir: string,
  agentId: string,
  options: OpenRunnerLogOptions = {},
): RunnerLogHandle | null {
  const log = options.log ?? (() => undefined);
  const path = runnerLogPath(appDataDir, agentId);
  try {
    mkdirSync(join(appDataDir, 'daemon'), { recursive: true });
    rotateIfLarge(path, options.maxBytes ?? RUNNER_LOG_MAX_BYTES, log);
    // 0600 — 러너 로그에는 하네스가 뱉은 것이 그대로 들어간다(경로·환경·오류 원문).
    // 소켓·토큰·장부와 같은 디렉터리이고, 같은 자리의 파일이 서로 다른 권한을 갖는 것
    // 자체가 사고의 씨앗이다(`runnerLedger.ts` 의 같은 판단).
    const fd = openSync(path, 'a', 0o600);
    return {
      fd,
      path,
      close() {
        try {
          closeSync(fd);
        } catch {
          /* 이미 닫혔다 — 닫기 실패로 spawn 을 되돌릴 것은 없다 */
        }
      },
    };
  } catch (err) {
    log(`러너 로그 파일을 열지 못했다 — 출력을 버린다: \`${path}\`: ${errText(err)}`);
    return null;
  }
}

/**
 * 파일이 상한을 넘었으면 `.1` 로 민다. **spawn 직전에만 불린다**(모듈 주석의 표).
 *
 * 실패는 삼킨다 — 회전에 실패했다고 러너를 안 띄울 이유가 없다. 다만 사유는 남긴다.
 */
function rotateIfLarge(path: string, maxBytes: number, log: (line: string) => void): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    // 아직 없다 — 첫 기동이다. 정상이므로 아무 말도 하지 않는다.
    return;
  }
  if (size <= maxBytes) return;
  const rotated = `${path}.${RUNNER_LOG_KEEP}`;
  try {
    // 옛 `.1` 은 버린다. `rename` 이 덮어쓰므로 이 줄이 없어도 되지만, 지우는 것을
    // 명시해 두면 `RUNNER_LOG_KEEP` 을 2 이상으로 올릴 때 여기가 고칠 자리임이 드러난다.
    unlinkSync(rotated);
  } catch {
    /* 없으면 지울 것도 없다 */
  }
  try {
    renameSync(path, rotated);
    log(`러너 로그가 ${size}바이트로 상한 ${maxBytes}바이트를 넘어 밀었다: \`${rotated}\``);
  } catch (err) {
    log(`러너 로그를 밀지 못했다 — 계속 이어 쓴다: \`${path}\`: ${errText(err)}`);
  }
}

/**
 * 로그의 **마지막 몇 줄을 그대로** 읽는다 — `#473` 의 재료다.
 *
 * ## daemon 이 이 줄들을 해석하지 않는다
 *
 * `#431` 의 성질은 *"daemon 은 판단하지 않는다. 관측을 노출한다"* 이다. 그래서 이 함수는
 * `EXECUTABLE_NOT_FOUND_LINE` 도 `CREDENTIAL_REJECTED_LINE` 도 모른다 — 그 상수를
 * import 조차 하지 않는다. **꼬리를 그대로 옮길 뿐이다.**
 *
 * 그 구분을 하는 것은 앱이다(`runnerLauncher.ts::handleExit`). 그것이 옳은 자리인 이유:
 * 판정의 결과가 **화면 문구**이고, 화면 문구는 daemon 이 아는 것이 아니다. daemon 이
 * `reason: 'harness-missing'` 같은 값을 만들어 보내는 순간, 러너의 로그 문구가 바뀌면
 * daemon 을 고쳐야 하고 daemon 은 러너의 배포 주기와 다르다 — 그때 앱은 daemon 이 지어낸
 * 낡은 판정을 믿는다.
 *
 * ## 왜 파일 전체를 안 읽는가
 *
 * 상한이 8MiB 다. 마지막 몇 줄을 얻자고 그것을 통째로 올리면 러너가 죽을 때마다 daemon 이
 * 그만큼 부푼다. 끝에서 `RUNNER_TAIL_READ_BYTES` 만 되짚는다.
 *
 * 되짚은 창의 **첫 줄은 버린다** — 그 줄은 반쪽일 수 있다(창의 시작이 줄 한가운데다).
 * 반쪽 줄을 그대로 올리면 사람이 잘린 문장을 원문으로 읽는다.
 *
 * 못 읽으면 **빈 배열**이다. 지어내지 않는다(`#368`) — "로그가 없다"와 "로그에 아무
 * 말도 없다"를 여기서 가르지 않고, 둘 다 *"실을 것이 없다"* 로 같게 다룬다. 앱은 꼬리가
 * 비면 코드만 보여 준다.
 */
export async function readRunnerLogTail(
  path: string,
  maxLines: number = RUNNER_EXIT_TAIL_LINES,
): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - RUNNER_TAIL_READ_BYTES);
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    // 창이 파일 중간에서 시작했다면 첫 줄은 반쪽이다 — 버린다.
    if (start > 0) lines.shift();
    return lines
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.trim().length > 0)
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
