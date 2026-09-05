/**
 * `#431` 2단계-a — 원자적 엔드포인트 획득의 회귀선.
 *
 * 이 파일이 지키는 것은 **성능도 편의도 아니라 소유권의 유일성**이다. 여기가 깨지면
 * daemon 이 둘 뜨고, 러너 소유권이 갈리고, 그 사실이 며칠 뒤 "에이전트가 같은 멘션에
 * 두 번 답한다" 같은 무관해 보이는 증상으로 나타난다.
 *
 * 다섯 회귀선 중 **"link 를 쓴다"(맨 아래)가 가장 중요하다.** 나머지 넷이 전부
 * 통과하는 상태에서도 `link` 를 `rename` 으로 바꾸면 조용히 참사가 나기 때문이다 —
 * 그 변경은 경쟁을 없애는 것이 아니라 **경쟁의 패자가 승자를 덮게** 만든다.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimDaemonEndpoint,
  daemonEndpointPaths,
  isReclaimableSocketDebris,
  probeSocket,
  releaseDaemonEndpoint,
  renameVerifyUnlink,
  DAEMON_PROTOCOL_VERSION,
} from '../src/daemonEndpoint.js';

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  // 소켓 경로 길이 제한(sun_path, macOS 는 104바이트)에 걸리지 않게 짧은 뿌리를 쓴다.
  const dir = await mkdtemp(join(tmpdir(), 'de-'));
  dirs.push(dir);
  return dir;
}

/** 실제로 듣는 소켓을 만든다 — connect 프로브가 `connected` 를 받아야 하는 자리에 쓴다. */
function listenAt(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once('error', reject);
    server.listen(path, () => resolve(server));
  });
}

/**
 * **소켓 잔해를 실제로 만든다** — 이것이 orca 실측(`daemon-v33.sock`·`daemon-v34.sock`)의
 * 재현이다.
 *
 * `server.close()` 로는 잔해가 안 생긴다. Node 가 닫으면서 소켓 파일까지 unlink 하기
 * 때문이다 — 그것은 "정상 종료한 daemon"이고, 정상 종료한 daemon 은 애초에 문제가
 * 아니다. 문제는 **SIGKILL 로 죽어 정리할 기회를 못 얻은 daemon** 이고, 그때만 파일이
 * 남는다(별도 실측으로 확인: SIGKILL 뒤 `existsSync === true`, `isSocket() === true`).
 *
 * 그래서 자식 프로세스에 bind 시키고 SIGKILL 한다. 그 pid 는 죽어 있으므로 pid 레코드
 * 검사도 함께 성립한다.
 */
async function killedSocketDebris(path: string): Promise<number> {
  const code = `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up')); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      if (String(d).includes('up')) resolve();
    });
    child.once('error', reject);
  });
  const pid = child.pid!;
  child.kill('SIGKILL');
  await new Promise<void>((r) => child.once('exit', () => r()));
  return pid;
}

function deps(bind: (p: string) => Promise<Server | void>) {
  return { bindTemporary: bind, appVersion: '1.2.3', entryPath: '/opt/murmur/daemon.js' };
}

/** 실제 unix 소켓을 임시 이름에 bind 하는 기본 주입. */
const realBind = async (p: string): Promise<Server> => await listenAt(p);

describe('daemonEndpointPaths — 프로토콜 버전이 파일명에 박힌다', () => {
  // 세대 격리가 파일명에서 나온다. 프로토콜이 다르면 신·구 daemon 이 서로의 파일을
  // **아예 보지 못한다** — EEXIST 도 안 나고 잔해 회수 대상도 안 된다.
  it('버전이 다르면 소켓·pid·토큰 경로가 전부 다르다', () => {
    const a = daemonEndpointPaths('/data', 1);
    const b = daemonEndpointPaths('/data', 2);
    expect(a.socketPath).not.toBe(b.socketPath);
    expect(a.pidPath).not.toBe(b.pidPath);
    expect(a.tokenPath).not.toBe(b.tokenPath);
    expect(a.socketPath).toContain('daemon-v1.sock');
    expect(b.socketPath).toContain('daemon-v2.sock');
  });

  // 앱 버전이 아니라 프로토콜 버전이 기본값이어야 한다. 앱 버전을 쓰면 릴리스마다
  // 멀쩡히 통하던 daemon 들이 세대로 갈린다.
  it('기본값은 하드코딩된 프로토콜 버전 상수다', () => {
    expect(daemonEndpointPaths('/data').socketPath).toContain(
      `daemon-v${DAEMON_PROTOCOL_VERSION}.sock`,
    );
  });
});

describe('회귀선 1 — 경쟁에서 승자가 하나뿐이다', () => {
  // 이 이슈의 근본 요구다. 두 daemon 이 동시에 같은 정규 이름을 노리면 커널이
  // 한쪽만 통과시킨다(link 의 EEXIST). 진 쪽은 예외가 아니라 occupied 를 값으로 받는다.
  it('두 시도가 동시에 같은 이름을 노리면 하나만 claimed 다', async () => {
    const dir = await tempDir();
    const [a, b] = await Promise.all([
      claimDaemonEndpoint(dir, deps(realBind)),
      claimDaemonEndpoint(dir, deps(realBind)),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['claimed', 'occupied']);
  });

  // 승자가 여럿 나오지 않는지 더 넓게 확인한다. 하나만 이기는 것이지 "보통 하나"가
  // 아니다 — 커널 보장이라 횟수를 늘려도 성질이 유지돼야 한다.
  it('다섯이 동시에 달려들어도 claimed 는 정확히 하나다', async () => {
    const dir = await tempDir();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimDaemonEndpoint(dir, deps(realBind))),
    );
    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    expect(results.every((r) => r.kind === 'claimed' || r.kind === 'occupied')).toBe(true);
  });

  // 이긴 쪽만 토큰을 안다. 진 쪽이 토큰을 받았다면 그 값으로 이긴 쪽을 사칭할 수 있다
  // — 토큰을 daemon 이(경쟁에서 이긴 뒤에) 만드는 이유가 이것이다.
  it('진 쪽은 토큰을 받지 못한다', async () => {
    const dir = await tempDir();
    const [a, b] = await Promise.all([
      claimDaemonEndpoint(dir, deps(realBind)),
      claimDaemonEndpoint(dir, deps(realBind)),
    ]);
    const loser = a.kind === 'occupied' ? a : b;
    expect(loser).not.toHaveProperty('token');
  });
});

describe('회귀선 2 — 살아 있는 소켓을 강탈하지 않는다', () => {
  // connect 가 성공하는 소켓이 정규 이름에 있으면 그것으로 끝이다. pid 파일이 없어도,
  // 내용을 못 읽어도 물러난다 — 듣고 있다는 것보다 강한 증거는 없다.
  it('정규 이름에 듣는 소켓이 있으면 occupied 를 돌려준다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await listenAt(paths.socketPath);

    const out = await claimDaemonEndpoint(dir, deps(realBind));
    expect(out.kind).toBe('occupied');
  });

  // 물러나는 것으로 끝이 아니다 — 물러나면서 자기가 bind 한 임시 소켓을 남기면
  // 그것이 곧 잔해가 된다(orca 가 겪은 문제의 씨앗).
  it('물러날 때 자기 임시 소켓을 남기지 않는다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await listenAt(paths.socketPath);

    await claimDaemonEndpoint(dir, deps(realBind));
    const { readdir } = await import('node:fs/promises');
    const left = (await readdir(paths.dir)).filter((n) => n.startsWith('.p'));
    expect(left).toEqual([]);
  });

  // pid 레코드가 살아 있는 프로세스를 가리켜도 물러난다. 이 테스트는 pid 증거만으로도
  // 강탈이 막히는지를 본다 — connect 증거와 pid 증거는 서로를 대체하지 않고 함께 선다.
  it('듣는 소켓 + 살아 있는 pid 레코드면 강탈하지 않는다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await listenAt(paths.socketPath);
    await writeFile(
      paths.pidPath,
      JSON.stringify({ pid: process.pid, startedAtMs: Date.now(), entryPath: '/x', appVersion: '1', launchNonce: 'n' }),
    );

    expect((await claimDaemonEndpoint(dir, deps(realBind))).kind).toBe('occupied');
  });
});

describe('회귀선 3 — 죽은 소켓은 3중 증거 후 회수한다', () => {
  // SIGKILL 로 죽은 daemon 의 소켓 파일은 그대로 남는다(orca 실측: daemon-v33/v34.sock).
  // 그것까지 존중하면 daemon 이 영영 못 뜬다. 아무도 안 듣고 pid 도 죽었으면 회수한다.
  it('아무도 듣지 않는 소켓 파일 + pid 레코드 없음이면 획득에 성공한다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await killedSocketDebris(paths.socketPath);

    // 잔해의 정의 그 자체 — 파일은 있는데 아무도 안 듣는다.
    expect(await probeSocket(paths.socketPath)).toBe('refused');
    const out = await claimDaemonEndpoint(dir, deps(realBind));
    expect(out.kind).toBe('claimed');
  });

  // pid 레코드가 있어도 그 프로세스가 죽었으면 잔해다. 죽은 daemon 이 남긴 pid 를
  // 그대로 써서 "레코드는 있는데 프로세스는 없다"를 실제 상황과 같게 만든다.
  it('듣지 않는 소켓 + 죽은 pid 레코드면 잔해로 판정한다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    const deadPid = await killedSocketDebris(paths.socketPath);
    await writeFile(paths.pidPath, JSON.stringify({ pid: deadPid, launchNonce: 'gone' }));

    expect(await isReclaimableSocketDebris(paths)).toBe(true);
    expect((await claimDaemonEndpoint(dir, deps(realBind))).kind).toBe('claimed');
  });

  // 회수 조건은 **둘 다** 서야 한다. connect 가 되면(살아 있으면) pid 가 뭐든 잔해가 아니다.
  it('듣고 있으면 pid 레코드가 없어도 잔해가 아니다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await listenAt(paths.socketPath);
    expect(await isReclaimableSocketDebris(paths)).toBe(false);
  });

  // 회수 조건은 **둘 다** 서야 한다 — 반대 방향. pid 가 살아 있으면 듣지 않아도
  // 잔해가 아니다(소켓 bind 직후·listen 전, 또는 pid 기록 직후의 창에 걸린 것일 수 있다).
  it('pid 가 살아 있으면 듣지 않아도 잔해가 아니다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await killedSocketDebris(paths.socketPath);
    // 소켓은 죽었지만 pid 는 살아 있다(이 테스트 프로세스 자신) — bind 는 했는데 아직
    // listen 전이거나, pid 기록 직후의 창에 걸린 daemon 이 이렇게 보인다.
    await writeFile(paths.pidPath, JSON.stringify({ pid: process.pid, launchNonce: 'live' }));

    expect(await isReclaimableSocketDebris(paths)).toBe(false);
  });

  // 회수 후 획득이 끝나면 세 파일이 **소켓 → pid → 토큰 순으로 전부** 놓여 있어야 한다.
  // 토큰의 존재가 곧 "서비스 중"이라는 단정이 여기서 성립한다.
  it('획득에 성공하면 소켓·pid·토큰 세 파일이 모두 놓인다', async () => {
    const dir = await tempDir();
    const out = await claimDaemonEndpoint(dir, deps(realBind));
    expect(out.kind).toBe('claimed');
    if (out.kind !== 'claimed') return;

    expect((await stat(out.paths.socketPath)).isSocket()).toBe(true);
    const rec: unknown = JSON.parse(await readFile(out.paths.pidPath, 'utf8'));
    expect(rec).toMatchObject({ pid: process.pid, appVersion: '1.2.3', entryPath: '/opt/murmur/daemon.js' });
    expect((await readFile(out.paths.tokenPath, 'utf8')).trim()).toBe(out.token);
  });

  // 토큰·소켓은 0600 이다. 같은 머신의 다른 프로세스가 daemon 에 붙어 러너를 조종하면
  // 안 된다(#431 D6) — 토큰 인증에 앞선 첫 번째 경계가 파일 권한이다.
  it('소켓과 토큰 파일은 0600 이다', async () => {
    const dir = await tempDir();
    const out = await claimDaemonEndpoint(dir, deps(realBind));
    if (out.kind !== 'claimed') throw new Error('획득 실패');
    expect((await stat(out.paths.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(out.paths.tokenPath)).mode & 0o777).toBe(0o600);
  });
});

describe('회귀선 4 — 남의 파일을 안 지운다 (rename-verify-unlink)', () => {
  // 곧장 unlink 하면 그 사이에 다른 daemon 이 같은 이름으로 올린 파일을 지운다.
  // 내용이 내 것이 아니면 지우지 않는다.
  it('토큰 내용이 다르면 unlink 하지 않는다', async () => {
    const dir = await tempDir();
    const path = join(dir, 'daemon-v1.token');
    await writeFile(path, '남의-토큰');

    expect(await renameVerifyUnlink(path, (c) => c.trim() === '내-토큰')).toBe(false);
    // 지우지 않는 것으로 끝이 아니다 — 격리 rename 이 이미 이름을 빼앗았으므로
    // **원래 이름으로 되돌아와 있어야** 한다. 되돌리지 않으면 "안 지웠다"고 말하면서
    // 실제로는 없앤 것이 된다.
    expect(await readFile(path, 'utf8')).toBe('남의-토큰');
  });

  it('토큰 내용이 내 것이면 unlink 한다', async () => {
    const dir = await tempDir();
    const path = join(dir, 'daemon-v1.token');
    await writeFile(path, '내-토큰');

    expect(await renameVerifyUnlink(path, (c) => c.trim() === '내-토큰')).toBe(true);
    await expect(readFile(path, 'utf8')).rejects.toThrow();
  });

  // 격리 파일(.hold-…)을 남기면 그것 자체가 새로운 잔해다.
  it('되돌린 뒤 격리 파일(.hold-)을 남기지 않는다', async () => {
    const dir = await tempDir();
    const path = join(dir, 'daemon-v1.token');
    await writeFile(path, '남의-토큰');
    await renameVerifyUnlink(path, () => false);

    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).filter((n) => n.includes('.hold-'))).toEqual([]);
  });

  // pid 파일은 pid 만으로 판정하면 안 된다 — pid 는 OS 가 돌려 쓰는 값이라, 내가 죽은 뒤
  // 같은 pid 를 물려받은 daemon 의 레코드가 내 것으로 보인다. launchNonce 가 기동을 가른다.
  it('pid 가 같아도 launchNonce 가 다르면 남의 것으로 보고 되돌린다', async () => {
    const dir = await tempDir();
    const out = await claimDaemonEndpoint(dir, deps(realBind));
    if (out.kind !== 'claimed') throw new Error('획득 실패');

    // 같은 pid, 다른 기동(nonce) — 즉 pid 를 물려받은 후임자의 레코드다.
    await releaseDaemonEndpoint(out.paths, { token: out.token, launchNonce: '다른-기동' });
    expect(JSON.parse(await readFile(out.paths.pidPath, 'utf8'))).toMatchObject({
      launchNonce: out.pidRecord.launchNonce,
    });
  });

  // 정상 경로 — 내 토큰·내 nonce 면 세 파일이 전부 사라진다.
  it('내 토큰·내 launchNonce 면 세 파일을 모두 정리한다', async () => {
    const dir = await tempDir();
    const out = await claimDaemonEndpoint(dir, deps(realBind));
    if (out.kind !== 'claimed') throw new Error('획득 실패');

    await releaseDaemonEndpoint(out.paths, {
      token: out.token,
      launchNonce: out.pidRecord.launchNonce,
    });
    for (const p of [out.paths.tokenPath, out.paths.pidPath, out.paths.socketPath]) {
      await expect(stat(p)).rejects.toThrow();
    }
  });
});

describe('회귀선 5 — `rename` 이 아니라 `link` 를 쓴다', () => {
  /**
   * **이 저장소에서 가장 조용한 참사를 막는 회귀선이다.**
   *
   * 위 네 회귀선이 전부 통과하는 상태에서도 `link(tmp, canonical)` 을
   * `rename(tmp, canonical)` 로 바꾸면 무슨 일이 나는가:
   *
   * - 경쟁 테스트(회귀선 1)는 **여전히 통과할 수 있다** — 나중에 도착한 쪽이 앞선 쪽을
   *   덮고도 자기는 "이겼다"고 보고하니 claimed 가 하나로 보인다
   * - occupied 테스트(회귀선 2)도 검사 순서에 따라 통과할 수 있다
   *
   * 그러나 운영에서는 **살아 있는 daemon 의 소켓이 사라진다.** 앞선 daemon 은 밀려난
   * 것을 알 방법조차 없다 — 자기 fd 는 여전히 유효해 accept 를 기다리지만, 그 이름으로
   * 오는 새 접속은 전부 나중 daemon 에게 간다. 러너 소유권이 조용히 둘로 갈린다.
   *
   * 그래서 이 테스트는 결과 값(claimed/occupied)이 아니라 **정규 이름에 있던 소켓이
   * 파괴되지 않았는가**를 직접 잰다. 살아 있는 소켓을 미리 두고, 획득 시도 뒤에
   * 그 소켓이 **여전히 같은 inode 이고 여전히 붙을 수 있는지**를 확인한다.
   *
   * `link` 는 EEXIST 로 실패해 소켓을 건드리지 않는다. `rename` 은 덮어써서 inode 가
   * 바뀐다 — 그 차이를 inode 비교가 잡는다.
   */
  it('정규 이름에 살아 있는 소켓이 있으면 그것을 파괴하지 않는다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await listenAt(paths.socketPath);

    const before = await stat(paths.socketPath);

    // 이 시도는 반드시 물러나야 한다.
    const out = await claimDaemonEndpoint(dir, deps(realBind));
    expect(out.kind).toBe('occupied');

    // 그리고 **원래 소켓이 그대로 살아 있어야** 한다. rename 으로 바뀌면 여기가 깨진다:
    // 파일은 여전히 존재하지만 다른 inode 이고, 원래 daemon 은 아무도 못 붙는 fd 를
    // 붙들고 있게 된다.
    const after = await stat(paths.socketPath);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(await probeSocket(paths.socketPath)).toBe('connected');
  });

  // 경쟁의 승자가 계속 서비스 가능한지를 값이 아니라 **실제 접속**으로 잰다.
  // rename 으로 바꾸면 진 쪽이 이긴 쪽의 소켓을 덮으므로, 승자로 보고된 쪽의 소켓에
  // 붙을 수 없게 된다(승자의 서버는 이제 아무도 안 보는 이름에 매여 있다).
  it('동시 경쟁 뒤 승자의 소켓에 실제로 붙을 수 있다', async () => {
    const dir = await tempDir();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => claimDaemonEndpoint(dir, deps(realBind))),
    );
    const winner = results.find((r) => r.kind === 'claimed');
    expect(winner).toBeDefined();
    if (winner?.kind !== 'claimed') return;
    expect(await probeSocket(winner.paths.socketPath)).toBe('connected');
  });

  // 하드링크 미지원 파일시스템 폴백. `rename` 을 쓰긴 하지만 **3중 증거를 거친 뒤에만**
  // 이다 — 살아 있는 소켓 앞에서는 폴백도 물러난다. 폴백에서 증거 검사를 빼면 이
  // 테스트가 빨개진다(그것이 곧 살아 있는 daemon 의 소켓을 날리는 변경이다).
  it('하드링크 미지원 폴백도 살아 있는 소켓 앞에서는 물러난다', async () => {
    const dir = await tempDir();
    const paths = daemonEndpointPaths(dir);
    await mkdirp(paths.dir);
    await listenAt(paths.socketPath);

    const before = await stat(paths.socketPath);
    // link 가 EPERM 을 내는 파일시스템(네트워크 볼륨 등)을 흉내 낸다.
    const out = await claimDaemonEndpoint(dir, {
      ...deps(realBind),
      link: async () => {
        const err: NodeJS.ErrnoException = new Error('EPERM: hardlinks unsupported');
        err.code = 'EPERM';
        throw err;
      },
    });
    expect(out.kind).toBe('occupied');

    const after = await stat(paths.socketPath);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(await probeSocket(paths.socketPath)).toBe('connected');
  });

  // 폴백이 **작동은 한다** — 하드링크가 안 되는 곳에서도 잔해뿐인 이름은 획득된다.
  // 위 테스트와 짝이다: 폴백을 "항상 거절"로 만들어 위 테스트를 통과시키는 것을 막는다.
  it('하드링크 미지원 폴백은 잔해뿐인 이름은 획득한다', async () => {
    const dir = await tempDir();
    const out = await claimDaemonEndpoint(dir, {
      ...deps(realBind),
      link: async () => {
        const err: NodeJS.ErrnoException = new Error('EOPNOTSUPP');
        err.code = 'EOPNOTSUPP';
        throw err;
      },
    });
    expect(out.kind).toBe('claimed');
  });
});

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}
