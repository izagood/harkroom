/**
 * daemon 엔드포인트(소켓·pid·토큰)를 **원자적으로 획득**한다 — `#431` 2단계-a.
 *
 * ## 이 모듈이 푸는 문제
 *
 * 2단계는 러너의 소유권을 앱에서 daemon 으로 옮긴다(`#431` D1). daemon 은 앱이 띄우는데,
 * **앱 인스턴스가 여럿이면 daemon 을 띄우려는 시도도 여럿**이 된다. 그중 하나만 이겨야
 * 한다 — 둘이 같은 이름의 소켓을 들고 있으면 앱이 어느 쪽에 붙는지가 타이밍에 달리고,
 * 러너 소유권이 두 daemon 으로 갈린다.
 *
 * "하나만 이긴다"를 **락 파일이나 합의 프로토콜 없이** 커널이 보장하게 만드는 것이
 * 이 모듈의 전부다.
 *
 * ## 왜 `rename` 이 아니라 `link` 인가 — 이 모듈에서 가장 중요한 한 줄
 *
 * 임시 이름으로 bind 한 소켓을 정규 이름으로 올리는 방법이 두 가지 있다:
 *
 * - `rename(tmp, canonical)` — 대상이 이미 있으면 **말없이 덮어쓴다.** POSIX 가 그렇게
 *   정의한다. 즉 살아 있는 daemon 이 서비스 중인 소켓 위로 내 소켓을 얹어 버린다.
 *   앞선 daemon 은 자기가 밀려난 것을 **알 방법조차 없다** — 그쪽 파일 디스크립터는
 *   여전히 유효해서 accept 를 계속 기다리지만, 그 이름으로 오는 새 접속은 전부 나에게
 *   온다. 러너 소유권이 조용히 두 곳으로 갈린다.
 * - `link(tmp, canonical)` — 대상이 이미 있으면 `EEXIST` 로 **원자적으로 실패한다.**
 *   "먼저 도착한 놈이 이긴다"를 커널이 보장한다. 진 쪽은 실패를 값으로 받아 물러난다.
 *
 * 그래서 이 모듈은 `link` 를 쓴다. **이것을 `rename` 으로 바꾸면 테스트가 아니라 운영이
 * 깨진다** — 그것도 조용히. `daemonEndpoint.test.ts` 의 "살아 있는 소켓을 파괴하지
 * 않는다" 회귀선이 그 변경을 잡으려고 있다.
 *
 * ## 왜 3중 증거인가 — ABA 문제
 *
 * `EEXIST` 를 받았다고 무조건 물러날 수는 없다. SIGKILL 로 죽은 daemon 의 소켓 파일은
 * 그대로 남기 때문이다(orca 실측: `daemon-v33.sock`·`daemon-v34.sock` 이 듣는 프로세스
 * 없이 남아 있었다). 그것까지 존중하면 daemon 이 영영 못 뜬다.
 *
 * 그렇다고 "connect 해 보고 안 되면 지운다"도 안 된다. **두 번의 관측 사이에 세상이
 * 바뀔 수 있기 때문이다:**
 *
 * ```
 * 나:   connect → ECONNREFUSED (죽었네)
 *                                  다른 daemon: 잔해를 회수하고 자기 소켓을 올린다
 * 나:   unlink                  ← 방금 올라온 **살아 있는** 소켓을 지웠다
 * ```
 *
 * 파일 이름은 처음부터 끝까지 존재했다. 관측만으로는 "계속 그 파일"인지 "죽었다 다른
 * 것이 들어왔는지"를 구분할 수 없다 — 이것이 ABA 다.
 *
 * `(dev, ino)` 가 그 구분자다. 소켓 파일이 교체되면 inode 가 반드시 바뀐다. 그래서:
 *
 * 1. 스냅샷 1 — `(dev, ino)` 를 찍는다
 * 2. connect 프로브 — 붙으면 **물러난다**(점유 중이다)
 * 3. 스냅샷 2 — 스냅샷 1 과 다르면 **전부 무효화하고 재시도**한다
 * 4. connect 프로브 재확인 — 여전히 죽었으면 그때만 강탈한다
 *
 * 세 증거(inode 불변 + 두 번의 connect 실패)가 모두 서야 잔해로 판정한다. 재시도가
 * 한도를 넘으면 예외가 아니라 `inconclusive` **상태**로 돌려준다 — 경쟁이 격렬하다는
 * 것은 정상적인 관측 결과이지 오류가 아니고, 호출자는 그냥 나중에 다시 시도하면 된다.
 *
 * ## 왜 프로토콜 버전이 앱 버전과 별개인가
 *
 * 파일명이 `daemon-v1.sock` 인 것은 **무협상 세대 격리**다. 프로토콜이 바뀌면 상수를
 * 올리고, 그 순간 신·구 daemon 은 서로의 파일을 **아예 보지 못한다** — 이름이 다르니
 * `EEXIST` 도 안 나고 잔해 회수 대상도 안 된다. 버전 협상 코드가 한 줄도 필요 없다.
 *
 * 앱 버전을 여기 쓰면 그 성질이 무너진다. 앱은 프로토콜과 무관하게 자주 오르고
 * (`1.4.197` → `1.4.198`), 그때마다 멀쩡히 말이 통하는 daemon 이 서로를 못 보게 된다.
 * 반대로 프로토콜이 바뀌었는데 앱 버전이 그대로면 말이 안 통하는 둘이 같은 소켓에서
 * 만난다. **앱 버전은 pid 레코드의 필드로 실어** "낡은 번들이 띄운 daemon 인가"를
 * 판정하는 데만 쓴다 — 그것은 격리가 아니라 정보다.
 *
 * ## 왜 기록 순서가 소켓 → pid → 토큰인가
 *
 * 세 파일이 한꺼번에 놓이지 않는다. 순서가 곧 **부분 상태의 의미**를 정한다:
 *
 * | 디스크에 있는 것 | 뜻 |
 * |---|---|
 * | 소켓만 | 이름은 잡았지만 아직 서비스 준비 안 됨 |
 * | 소켓 + pid | 누가 잡았는지는 알지만 아직 접속하면 안 됨 |
 * | 소켓 + pid + 토큰 | **접속해도 된다** |
 *
 * 토큰이 마지막이라 **토큰 파일의 존재가 곧 "그 소켓을 소유한 daemon 이 서비스 중"**을
 * 뜻한다. 클라이언트는 토큰을 읽을 수 있으면 붙어도 된다고 단정할 수 있다 — 세 파일의
 * 조합을 따져 볼 필요가 없다.
 *
 * 순서를 뒤집으면 이 단정이 사라진다. 토큰이 먼저 놓이면 소켓이 아직 없는데 토큰이
 * 읽히는 창이 생기고, 클라이언트는 붙을 수 있다고 믿고 `ENOENT` 를 맞는다. 그래서
 * **어느 단계가 실패하면 앞 단계를 되감는다** — 반쯤 놓인 상태를 남기지 않는다.
 *
 * ## 왜 토큰을 daemon 이 만드는가
 *
 * 앱이 토큰을 만들어 넘기면, 경쟁에서 **진** daemon 도 그 토큰을 안다. 진 쪽이 이긴 쪽의
 * 소켓에 그 토큰으로 붙으면 인증을 통과한다 — 토큰이 "이 daemon 의 주인임"을 증명하는
 * 것이 아니라 "앱을 안다"만 증명하게 된다. 소유권 경계가 사라진다.
 * 그래서 **이긴 daemon 이 이긴 뒤에 만든다.** 진 쪽은 그 값을 알 길이 없다.
 *
 * ## 범위 — 여기 없는 것
 *
 * daemon 프로세스 자체(2-b) · IPC 프로토콜(2-b) · 고아 재발견(2-c) · 수명 관리(2-d) 는
 * 이 모듈 밖이다. 여기는 **이름을 잡고 놓는 것**만 한다.
 *
 * 그리고 **`sessions.json` 과 `SessionStore` 는 이 모듈에 등장하지 않는다**(`#431` D5).
 * 세션 상태의 원자성은 "쓰는 주체가 하나"라는 전제에서 나오고, 그 writer 는 러너다.
 * daemon 이 그 파일의 두 번째 writer 가 되면 각각은 원자적인데 합쳐서 lost update 가
 * 난다 — 그리고 **조용히** 난다(에러도 크래시도 없이 중복 답변·누락·세션 고아로 나타나
 * daemon 과 무관해 보인다). 소유는 프로세스 수준이고 세션 상태는 러너의 것이다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { connect, type Server } from 'node:net';
import { join } from 'node:path';

/**
 * 프로토콜 버전 — **앱 버전과 별개인 하드코딩 상수다**(모듈 주석의 "왜 별개인가" 참조).
 *
 * 이 값을 올리는 것은 "이 소켓에서 오가는 말이 바뀌었다"는 선언이고, 올리는 순간 신·구
 * daemon 은 서로를 못 보게 된다. **말이 그대로면 올리지 마라** — 앱 릴리스마다 올리면
 * 멀쩡히 통하던 daemon 들이 세대로 갈려 잔해만 쌓인다.
 */
export const DAEMON_PROTOCOL_VERSION = 1;

/** 3중 증거가 ABA 로 무효화됐을 때 다시 시도하는 횟수의 상한. */
const MAX_CLAIM_ATTEMPTS = 3;

/** connect 프로브가 응답을 기다리는 시간. 로컬 unix 소켓이라 짧아도 된다. */
const PROBE_TIMEOUT_MS = 250;

/**
 * daemon 이 자기를 밝히는 레코드. **소켓 다음, 토큰 앞**에 놓인다.
 *
 * `appVersion` 은 여기 있지 **파일명에 없다** — 세대 격리는 프로토콜 버전이 하고,
 * 앱 버전은 "낡은 번들이 띄운 daemon 인가"를 사람과 앱이 판정하기 위한 정보다.
 *
 * `launchNonce` 는 pid 재사용을 가른다. pid 는 OS 가 돌려 쓰는 값이라 `kill(pid, 0)` 이
 * 성공해도 그것이 **내가 아는 그 프로세스**라는 보장이 없다 — 죽은 daemon 의 pid 를
 * 무관한 프로세스가 물려받았을 수 있다. nonce 가 같아야 같은 기동이다.
 */
export interface DaemonPidRecord {
  pid: number;
  startedAtMs: number;
  /** daemon 진입 스크립트의 절대 경로. 어느 번들이 띄웠는지를 사람이 눈으로 확인하는 값. */
  entryPath: string;
  appVersion: string;
  /** 이 기동을 다른 기동과 구분하는 값. pid 재사용에 속지 않기 위해 있다. */
  launchNonce: string;
}

/** `daemon-v<N>.{sock,pid,token}` 세 경로. 한 자리에서 조립해 흩어진 이어붙이기를 막는다. */
export interface DaemonEndpointPaths {
  /** 세 파일이 사는 디렉터리(`<앱 데이터 디렉터리>/daemon`). */
  dir: string;
  socketPath: string;
  pidPath: string;
  tokenPath: string;
}

/**
 * 엔드포인트 경로를 조립한다.
 *
 * 호출자가 각자 이어 붙이면 하나를 옛 이름으로 두는 실수가 조용히 지나간다 — 그러면
 * 소켓은 v2 인데 pid 는 v1 을 보는 상태가 되어 세대 격리가 무너진다.
 */
export function daemonEndpointPaths(
  appDataDir: string,
  protocolVersion: number = DAEMON_PROTOCOL_VERSION,
): DaemonEndpointPaths {
  const dir = join(appDataDir, 'daemon');
  const base = `daemon-v${protocolVersion}`;
  return {
    dir,
    socketPath: join(dir, `${base}.sock`),
    pidPath: join(dir, `${base}.pid`),
    tokenPath: join(dir, `${base}.token`),
  };
}

/** connect 프로브의 결과. 세 갈래를 구분하는 것이 3중 증거의 재료다. */
export type ProbeResult =
  /** 누가 듣고 있다 — 살아 있는 daemon 이다. 물러나야 한다. */
  | 'connected'
  /** 파일은 있는데 아무도 안 듣는다(`ECONNREFUSED`) — 잔해 후보다. */
  | 'refused'
  /** 파일 자체가 없다(`ENOENT`) — 경쟁자가 방금 치웠거나 애초에 없었다. */
  | 'missing';

/**
 * 소켓에 붙어 보고 세 갈래 중 하나를 돌려준다.
 *
 * **예외를 던지지 않는다.** 여기서 던지면 호출부가 "붙었다/안 붙었다"라는 판정을
 * try/catch 로 표현하게 되고, 그러면 `ECONNREFUSED`(잔해)와 `EACCES`(권한 문제)처럼
 * 뜻이 전혀 다른 것이 한 갈래로 뭉친다. 알 수 없는 에러는 `'connected'` 로 **안전한
 * 쪽에 붙인다** — 모르면 남의 것으로 치고 물러나는 것이 소켓을 날리는 것보다 낫다.
 */
export async function probeSocket(
  socketPath: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    const sock = connect(socketPath);
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      // 타임아웃은 "안 듣는다"가 아니다 — 듣고는 있는데 바쁜 것일 수 있다. 살아 있는
      // 쪽으로 판정한다.
      finish('connected');
    }, timeoutMs);
    timer.unref?.();
    sock.once('connect', () => {
      clearTimeout(timer);
      finish('connected');
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') finish('missing');
      else if (err.code === 'ECONNREFUSED') finish('refused');
      else finish('connected');
    });
  });
}

/** 소켓 파일의 신원. 두 스냅샷이 같아야 "그동안 교체되지 않았다"가 성립한다. */
interface InodeSnapshot {
  dev: number;
  ino: number;
}

/** 파일이 없으면 `null`. 없어진 것도 "바뀌었다"의 한 형태이므로 값으로 표현한다. */
async function snapshotInode(path: string): Promise<InodeSnapshot | null> {
  try {
    const st = await stat(path);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function sameInode(a: InodeSnapshot | null, b: InodeSnapshot | null): boolean {
  if (a === null || b === null) return false;
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * `link` 가 이 에러를 내면 하드링크를 지원하지 않는 파일시스템이다(네트워크 볼륨 등).
 * macOS 기본 APFS 는 지원하지만 소켓이 놓이는 경로가 항상 APFS 라는 보장은 없다.
 *
 * **이 갈래에서만 `rename` 폴백을 허용하되, 3중 증거를 거친 뒤에만 쓴다** — `rename` 은
 * 덮어쓰므로 증거 없이 쓰면 살아 있는 daemon 의 소켓을 날린다. 즉 폴백은 "경쟁 판정을
 * 포기한다"가 아니라 "판정은 그대로 하되 마지막 한 걸음만 다른 시스템콜로 딛는다"다.
 */
function isHardlinkUnsupported(err: NodeJS.ErrnoException): boolean {
  return err.code === 'EPERM' || err.code === 'EOPNOTSUPP' || err.code === 'ENOTSUP' || err.code === 'ENOSYS';
}

/** pid 가 지금 살아 있는지. 신호를 보내지 않는 `kill(pid, 0)` 이 정석이다. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 은 "있는데 내 것이 아니다"이지 "없다"가 아니다 — 살아 있는 쪽으로 판정한다.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readPidRecord(pidPath: string): Promise<DaemonPidRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pidPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Partial<DaemonPidRecord>;
    if (typeof rec.pid !== 'number') return null;
    return rec as DaemonPidRecord;
  } catch {
    // 없거나 깨졌으면 "레코드가 없다"와 같이 다룬다 — 깨진 JSON 을 근거로 남의 소켓을
    // 지키자면 잔해가 영원히 남고, 그렇다고 깨졌다는 이유로 강탈하지도 않는다(잔해
    // 회수는 connect 결과가 함께 서야 성립한다).
    return null;
  }
}

/**
 * 소켓 잔해를 회수해도 되는가 — **orca 에서 고쳐서 가져온 한 단계**.
 *
 * orca 는 "내가 bind 한 소켓만 내가 지운다"는 규칙이라, SIGKILL 로 죽은 daemon 의 소켓을
 * 치울 자격이 아무에게도 없다. 무해하지만 디렉터리가 영원히 자란다(실측: `daemon-v33.sock`·
 * `daemon-v34.sock`).
 *
 * murmur 는 조건을 붙여 허용한다: connect 가 `refused`(파일은 있는데 아무도 안 듣는다)
 * **이고** 동일 버전 pid 레코드가 없거나 그 pid 가 죽었음이 확인되면 회수한다.
 *
 * 두 조건을 **모두** 요구하는 이유: connect 만 보면 daemon 이 bind 는 했는데 아직 listen
 * 전인 창에 걸릴 수 있고, pid 만 보면 pid 파일 기록 전(소켓→pid 순서라 그런 창이 실제로
 * 있다) daemon 을 죽은 것으로 오판한다. 둘이 함께 서야 잔해다.
 */
export async function isReclaimableSocketDebris(
  paths: Pick<DaemonEndpointPaths, 'socketPath' | 'pidPath'>,
): Promise<boolean> {
  if ((await probeSocket(paths.socketPath)) !== 'refused') return false;
  const rec = await readPidRecord(paths.pidPath);
  if (rec === null) return true;
  return !isProcessAlive(rec.pid);
}

/**
 * 3중 증거를 세운다. `true` 면 강탈해도 된다.
 *
 * `null` 은 "판정 불가"다 — 두 스냅샷 사이에 inode 가 바뀌었다는 뜻이고, 호출자는 전부
 * 무효화하고 재시도해야 한다. `false`(점유 중이니 물러나라)와 **구분되어야** 한다.
 */
async function tripleEvidenceSaysDead(
  paths: Pick<DaemonEndpointPaths, 'socketPath' | 'pidPath'>,
): Promise<boolean | null> {
  // 증거 1 — 스냅샷 1.
  const before = await snapshotInode(paths.socketPath);

  // 증거 2 — 첫 connect. 붙으면 여기서 끝이다. 살아 있는 것을 건드리지 않는다.
  const first = await probeSocket(paths.socketPath);
  if (first === 'connected') return false;

  // 증거 3 — 스냅샷 2. 바뀌었으면 두 관측 사이에 다른 daemon 이 들어왔다(ABA). 지금까지
  // 모은 증거는 **이전 파일에 대한 것**이라 전부 무효다.
  const after = await snapshotInode(paths.socketPath);
  if (!sameInode(before, after)) return null;

  // 두 번째 connect — inode 가 그대로임을 확인한 뒤 다시 묻는다. 여전히 죽었으면 잔해다.
  const second = await probeSocket(paths.socketPath);
  if (second === 'connected') return false;

  // 마지막으로 pid 레코드까지 본다(위 `isReclaimableSocketDebris` 의 근거와 같다).
  const rec = await readPidRecord(paths.pidPath);
  if (rec !== null && isProcessAlive(rec.pid)) return false;
  return true;
}

/**
 * 소유권 표시가 붙은 파일을 안전하게 지운다 — **rename-verify-unlink**.
 *
 * 곧장 `unlink` 하면 그 사이에 다른 daemon 이 같은 이름으로 자기 파일을 올렸을 때
 * **남의 파일을 지운다.** 그래서:
 *
 * 1. `.hold-<pid>-<uuid>` 로 격리 rename — 이름을 내 손에 쥔다. 이 이름은 유일하므로
 *    다른 daemon 이 같은 순간 같은 짓을 해도 서로를 밟지 않는다
 * 2. 격리된 파일의 내용이 **내 것인지** 확인한다
 * 3. 맞으면 unlink, 아니면 **원래 이름으로 되돌린다**
 *
 * 3 의 되돌림이 핵심이다 — 남의 파일이었다면 격리 rename 자체가 이미 그 daemon 에게서
 * 파일을 빼앗은 상태다. 되돌리지 않으면 "안 지웠다"고 말하면서 실제로는 없앤 것이 된다.
 *
 * `verify` 가 던지면 남의 것으로 친다 — 모르면 되돌리는 쪽이 안전하다.
 */
export async function renameVerifyUnlink(
  path: string,
  verify: (content: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  const holdPath = `${path}.hold-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, holdPath);
  } catch {
    // 이미 없다 — 지울 것이 없으니 "안 지웠다"다.
    return false;
  }
  let mine = false;
  try {
    mine = await verify(await readFile(holdPath, 'utf8'));
  } catch {
    mine = false;
  }
  if (mine) {
    await rm(holdPath, { force: true });
    return true;
  }
  // 남의 것이었다 — 빼앗은 이름을 돌려준다. 그 사이 원래 이름에 새 파일이 생겼다면
  // 그쪽이 최신이므로 격리본을 버린다(되돌리면 오히려 새것을 덮는다).
  try {
    await rename(holdPath, path);
  } catch {
    await rm(holdPath, { force: true });
  }
  return false;
}

/** 엔드포인트 획득 시도의 결과. **예외가 아니라 상태로 표현한다.** */
export type ClaimOutcome =
  /** 내가 이겼다. 세 파일이 전부 놓였고 서비스해도 된다. */
  | { kind: 'claimed'; paths: DaemonEndpointPaths; token: string; pidRecord: DaemonPidRecord }
  /** 살아 있는 daemon 이 이미 있다. 물러나 그쪽에 붙어라. */
  | { kind: 'occupied'; paths: DaemonEndpointPaths }
  /** 경쟁이 격렬해 판정이 안 섰다. 오류가 아니다 — 잠시 뒤 다시 시도하면 된다. */
  | { kind: 'inconclusive'; paths: DaemonEndpointPaths; attempts: number };

/**
 * 호출자가 넘기는 것 — 실제 bind 는 daemon(2-b)이 하고, 이 모듈은 이름만 다룬다.
 *
 * `bindTemporary` 를 주입으로 받는 이유: 이 모듈이 `net.Server` 를 직접 만들면 회귀선이
 * 진짜 소켓 서버를 띄워야만 경쟁을 재현할 수 있고, 그러면 "link 를 쓰는가"처럼 파일
 * 시스템 수준의 성질을 재는 테스트에 서버 수명 관리가 딸려 온다.
 */
export interface ClaimDeps {
  /**
   * 주어진 임시 경로에 소켓을 bind 한다. 성공하면 그 경로에 소켓 파일이 존재해야 한다.
   *
   * **정규 이름이 아니라 임시 이름에 bind 한다** — 정규 이름에 곧장 bind 하면 그 자체가
   * 덮어쓰기(또는 `EADDRINUSE` 를 피하려는 선제 unlink)를 부르고, 그 순간 "먼저 도착한
   * 놈이 이긴다"가 깨진다.
   */
  bindTemporary: (tempPath: string) => Promise<Server | void>;
  /** pid 레코드에 실을 앱 버전. 세대 격리에 쓰이지 않는다(정보다). */
  appVersion: string;
  /** daemon 진입 스크립트의 절대 경로. */
  entryPath: string;
  /**
   * 하드링크 시스템콜. **기본값이 `fs.link` 이고 운영에서는 항상 그것이다** —
   * 주입 지점을 둔 이유는 오직 하나, **하드링크를 지원하지 않는 파일시스템의 폴백
   * 경로를 회귀선이 실제로 밟게 하기 위해서**다. 네트워크 볼륨을 테스트에서 마련할
   * 방법이 없고, 그렇다고 폴백을 검증 없이 둘 수는 없다 — 그 경로가 `rename` 을 쓰기
   * 때문이다(덮어쓴다). 검증 안 된 `rename` 경로가 코드에 있는 것 자체가 위험이다.
   */
  link?: (existingPath: string, newPath: string) => Promise<void>;
}

/** `.p<random hex>` — orca 실측 형태(`.pcbfbcf902f`)를 그대로 따른다. */
function temporaryName(dir: string): string {
  return join(dir, `.p${randomBytes(5).toString('hex')}`);
}

/**
 * 정규 이름을 원자적으로 획득한다. 성공하면 세 파일이 전부 놓인 상태로 돌아온다.
 *
 * 전체 흐름:
 *
 * ```
 * 임시 이름으로 bind
 *   → link(임시, 정규)
 *       성공  → 임시 unlink(하드링크라 소켓은 살아 있다) → pid 기록 → 토큰 기록 → claimed
 *       EEXIST → 3중 증거
 *                  살아 있다 → occupied (물러난다)
 *                  ABA      → 전부 무효화하고 재시도
 *                  잔해     → 회수하고 재시도
 *       하드링크 미지원 → 3중 증거를 거친 뒤에만 rename 폴백
 * ```
 */
export async function claimDaemonEndpoint(
  appDataDir: string,
  deps: ClaimDeps,
  protocolVersion: number = DAEMON_PROTOCOL_VERSION,
): Promise<ClaimOutcome> {
  const paths = daemonEndpointPaths(appDataDir, protocolVersion);
  await mkdir(paths.dir, { recursive: true });
  // 기본값은 진짜 `fs.link` 다 — 주입은 폴백 경로를 테스트가 밟기 위한 것이지
  // 운영에서 갈아 끼우라고 둔 자리가 아니다(`ClaimDeps.link` 주석 참조).
  const linkFn = deps.link ?? link;

  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const tempPath = temporaryName(paths.dir);
    let server: Server | void;
    try {
      server = await deps.bindTemporary(tempPath);
    } catch (err) {
      await rm(tempPath, { force: true });
      throw err;
    }

    // 임시 이름의 소켓도 0600 으로 좁힌다 — 정규 이름으로 올라가기 전의 짧은 창에도
    // 남이 붙을 수 있다. 링크는 inode 를 공유하므로 여기서 한 chmod 가 정규 이름에도
    // 그대로 적용된다.
    await chmod(tempPath, 0o600).catch(() => undefined);

    const linked = await tryPublishName(tempPath, paths, linkFn);
    if (linked === 'won') {
      // 하드링크라 임시 이름을 지워도 소켓은 정규 이름으로 계속 산다 — 두 이름이 같은
      // inode 를 가리키고, 마지막 이름이 사라질 때만 실제로 없어진다.
      await rm(tempPath, { force: true });
      const published = await publishPidAndToken(paths, deps);
      if (published === null) {
        // pid·토큰 기록이 실패했다. **앞 단계를 되감는다** — 소켓만 남은 정규 이름은
        // "이름은 잡혔는데 아무도 서비스하지 않는다"라서, 되감지 않으면 다음 daemon 이
        // 3중 증거를 다 거쳐야만 치울 수 있는 잔해가 된다.
        await rollbackSocketName(paths, server);
        return { kind: 'inconclusive', paths, attempts: attempt };
      }
      return { kind: 'claimed', paths, ...published };
    }

    // 졌거나 판정이 안 섰다 — 내가 bind 한 임시 소켓부터 치운다. 남기면 그것이 잔해다.
    closeServer(server);
    await rm(tempPath, { force: true });
    if (linked === 'occupied') return { kind: 'occupied', paths };
    // 'retry' — 잔해를 회수했거나 ABA 를 만났다. 다음 회차로 간다.
  }

  return { kind: 'inconclusive', paths, attempts: MAX_CLAIM_ATTEMPTS };
}

type PublishNameResult = 'won' | 'occupied' | 'retry';

/** 임시 이름을 정규 이름으로 올린다 — **`link` 를 쓴다**(모듈 주석 참조). */
async function tryPublishName(
  tempPath: string,
  paths: DaemonEndpointPaths,
  linkFn: (existingPath: string, newPath: string) => Promise<void>,
): Promise<PublishNameResult> {
  try {
    // ── 이 한 줄이 이 모듈의 전부다 ──────────────────────────────────────────
    // `rename` 으로 바꾸지 마라. rename 은 대상이 있어도 **말없이 덮어써서** 살아 있는
    // daemon 의 소켓을 날린다. link 는 대상이 있으면 EEXIST 로 원자적으로 실패해
    // "먼저 도착한 놈이 이긴다"를 커널이 보장한다.
    await linkFn(tempPath, paths.socketPath);
    return 'won';
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') return await resolveExistingName(paths);
    if (isHardlinkUnsupported(e)) return await publishByRenameFallback(tempPath, paths);
    throw err;
  }
}

/** `EEXIST` — 이미 누가 그 이름을 갖고 있다. 3중 증거로 살았는지 죽었는지 가른다. */
async function resolveExistingName(paths: DaemonEndpointPaths): Promise<PublishNameResult> {
  const dead = await tripleEvidenceSaysDead(paths);
  if (dead === false) return 'occupied';
  // `null`(ABA) 이면 회수하지 않고 그대로 재시도한다 — 지금 그 이름에 있는 것은 내가
  // 증거를 모은 그 파일이 아니다.
  if (dead === null) return 'retry';

  // 잔해로 확정됐다. 정규 이름을 rename-verify-unlink 로 치운다 — 곧장 unlink 하면
  // 증거를 세운 뒤 이 줄에 닿기까지의 사이에 들어온 새 소켓을 지울 수 있다.
  await reclaimSocketName(paths);
  return 'retry';
}

/**
 * 잔해로 판정된 정규 소켓 이름을 치운다.
 *
 * 소켓 파일은 내용을 읽어 소유자를 확인할 수 없다(내용이 없다). 그래서 검증 재료를
 * inode 로 삼는다 — 격리 rename 직후의 inode 가 증거를 세울 때 본 것과 같아야 한다.
 */
async function reclaimSocketName(paths: DaemonEndpointPaths): Promise<void> {
  const evidenced = await snapshotInode(paths.socketPath);
  const holdPath = `${paths.socketPath}.hold-${process.pid}-${randomUUID()}`;
  try {
    await rename(paths.socketPath, holdPath);
  } catch {
    return; // 누가 먼저 치웠다.
  }
  const held = await snapshotInode(holdPath);
  if (sameInode(evidenced, held)) {
    await rm(holdPath, { force: true });
    return;
  }
  // 증거를 세운 그 파일이 아니다 — 되돌린다.
  try {
    await rename(holdPath, paths.socketPath);
  } catch {
    await rm(holdPath, { force: true });
  }
}

/**
 * 하드링크 미지원 파일시스템에서만 도는 폴백.
 *
 * **3중 증거를 먼저 거친다.** `rename` 은 덮어쓰므로 증거 없이 쓰면 살아 있는 daemon 의
 * 소켓을 날린다 — 이 함수가 `link` 경로와 다른 점은 마지막 시스템콜뿐이고, 판정은
 * 오히려 더 엄격하다(`link` 는 부재를 커널이 확인해 주지만 여기서는 우리가 확인한다).
 */
async function publishByRenameFallback(
  tempPath: string,
  paths: DaemonEndpointPaths,
): Promise<PublishNameResult> {
  const existing = await snapshotInode(paths.socketPath);
  if (existing !== null) {
    const dead = await tripleEvidenceSaysDead(paths);
    if (dead === false) return 'occupied';
    if (dead === null) return 'retry';
  }
  await rename(tempPath, paths.socketPath);
  return 'won';
}

/**
 * pid → 토큰 순으로 기록한다. **순서가 load-bearing 이다**(모듈 주석 참조).
 *
 * 실패하면 `null` — 호출자가 소켓 이름까지 되감는다.
 */
async function publishPidAndToken(
  paths: DaemonEndpointPaths,
  deps: ClaimDeps,
): Promise<{ token: string; pidRecord: DaemonPidRecord } | null> {
  const pidRecord: DaemonPidRecord = {
    pid: process.pid,
    startedAtMs: Date.now(),
    entryPath: deps.entryPath,
    appVersion: deps.appVersion,
    launchNonce: randomUUID(),
  };
  try {
    await writeFile(paths.pidPath, JSON.stringify(pidRecord), { mode: 0o600 });
  } catch {
    return null;
  }

  // 토큰은 **여기서** 만든다 — 경쟁에서 이긴 뒤다. 앱이 만들어 넘겼다면 진 daemon 도
  // 같은 값을 알아 이긴 쪽을 사칭할 수 있다.
  const token = randomUUID();
  try {
    await writeFile(paths.tokenPath, token, { mode: 0o600 });
  } catch {
    // 토큰이 없으면 클라이언트가 붙을 수 없다 — 앞 단계인 pid 를 되감아 반쯤 놓인
    // 상태를 남기지 않는다.
    await rm(paths.pidPath, { force: true });
    return null;
  }
  return { token, pidRecord };
}

/** 소켓 이름만 잡은 상태에서 뒤로 물린다. */
async function rollbackSocketName(paths: DaemonEndpointPaths, server: Server | void): Promise<void> {
  closeServer(server);
  await unlink(paths.socketPath).catch(() => undefined);
}

function closeServer(server: Server | void): void {
  if (server && typeof (server as Server).close === 'function') {
    (server as Server).close();
  }
}

/**
 * 내가 놓은 엔드포인트를 정리한다 — 종료 경로에서 부른다.
 *
 * 놓을 때의 역순(**토큰 → pid → 소켓**)이다. 토큰을 먼저 지우면 그 순간부터 "붙어도
 * 된다"는 신호가 사라져, 정리하는 중에 새로 붙는 클라이언트가 없다.
 *
 * 세 파일 모두 **내 것임을 확인한 뒤에만** 지운다 — 이 daemon 이 밀려난 뒤(예: 하드링크
 * 미지원 폴백 경로에서 덮인 뒤) 종료하면서 후임자의 파일을 지우는 것을 막는다.
 */
export async function releaseDaemonEndpoint(
  paths: DaemonEndpointPaths,
  owned: { token: string; launchNonce: string },
): Promise<void> {
  await renameVerifyUnlink(paths.tokenPath, (content) => content.trim() === owned.token);
  await renameVerifyUnlink(paths.pidPath, (content) => {
    try {
      const rec: unknown = JSON.parse(content);
      if (typeof rec !== 'object' || rec === null) return false;
      const parsed = rec as Partial<DaemonPidRecord>;
      // pid 만으로는 부족하다 — pid 는 OS 가 돌려 쓰는 값이라, 내가 죽은 뒤 같은 pid 를
      // 물려받은 daemon 의 레코드가 내 것으로 보인다. launchNonce 가 기동을 가른다.
      return parsed.pid === process.pid && parsed.launchNonce === owned.launchNonce;
    } catch {
      return false;
    }
  });
  await unlink(paths.socketPath).catch(() => undefined);
}
