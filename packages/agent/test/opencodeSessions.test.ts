// opencode 세션 **사후 발견** — codex 와 같은 갈래이지만 재료가 다르다(2026-09-22).
//
// codex 는 rollout 파일을 훑는다. opencode 의 세션은 SQLite 안에 있어 파일 경로가 없고,
// 대신 CLI 가 목록을 준다(`session list --format json`). 그래서 이 모듈은 **명령을 부르고
// 그 JSON 을 읽는다** — 그 SQLite 를 우리가 직접 열지 않는 이유는 스키마가 그쪽 내부
// 사정이고 판본이 바뀌면 조용히 틀린 답을 내기 때문이다.
//
// 맞추는 열쇠는 codex 와 같다: **그 턴을 돌린 워크스페이스 경로**.
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findOpencodeSessionId } from '../src/opencodeSessions.js';

/** `opencode` 자리에 세울 가짜. 받은 인자를 확인하고 준비된 JSON 을 뱉는다. */
async function fakeOpencode(rows: unknown, opts: { exitCode?: number; stdout?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-sess-'));
  const bin = join(dir, 'opencode');
  const body = opts.stdout ?? JSON.stringify(rows);
  await writeFile(bin, `#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\nexit ${opts.exitCode ?? 0}\n`);
  await chmod(bin, 0o755);
  return bin;
}

const ENV = {} as Record<string, string>;

describe('findOpencodeSessionId', () => {
  it('그 워크스페이스에서 만들어진 세션을 고른다 — 다른 디렉터리 것은 안 집는다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ws-'));
    const other = await mkdtemp(join(tmpdir(), 'ws-'));
    const command = await fakeOpencode([
      { id: 'ses_other', directory: other, created: 2_000 },
      { id: 'ses_mine', directory: cwd, created: 2_000 },
    ]);

    expect(await findOpencodeSessionId({ command, env: ENV, cwd, sinceMs: 1_000 })).toBe('ses_mine');
  });

  it('턴 시작 **전** 세션은 안 집는다 — 같은 스레드의 옛 세션을 되살리면 안 된다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ws-'));
    const command = await fakeOpencode([{ id: 'ses_old', directory: cwd, created: 1_000 }]);

    expect(await findOpencodeSessionId({ command, env: ENV, cwd, sinceMs: 1_000_000 })).toBeNull();
  });

  it('같은 자리에 여럿이면 **가장 나중 것**이다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ws-'));
    const command = await fakeOpencode([
      { id: 'ses_a', directory: cwd, created: 5_000 },
      { id: 'ses_b', directory: cwd, created: 9_000 },
    ]);

    expect(await findOpencodeSessionId({ command, env: ENV, cwd, sinceMs: 1_000 })).toBe('ses_b');
  });

  it('명령이 실패하거나 JSON 이 아니면 `null` — 발견 실패이지 턴 실패가 아니다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ws-'));
    // 못 찾으면 다음 턴이 새 세션으로 시작할 뿐이다. 여기서 던지면 답을 낸 턴이 실패로 뒤집힌다.
    const broken = await fakeOpencode(null, { stdout: '사람이 읽는 표가 나왔다' });
    expect(await findOpencodeSessionId({ command: broken, env: ENV, cwd, sinceMs: 0 })).toBeNull();

    expect(await findOpencodeSessionId({ command: '/없는/명령', env: ENV, cwd, sinceMs: 0 })).toBeNull();
  });

  it('목록을 **그 워크스페이스에서** 묻는다 — opencode 의 세션 목록은 프로젝트 단위다', async () => {
    // 실측(2026-09-22, 1.18.32): `session list` 는 cwd 의 git 루트를 프로젝트로 잡고 그
    // 프로젝트의 세션만 낸다. 다른 자리에서 물으면 빈 배열이고, 그건 "없다"와 구별되지
    // 않아 발견이 **늘 조용히** 실패한다. 그래서 cwd 를 넘기는 것이 이 함수의 계약이다.
    const cwd = await mkdtemp(join(tmpdir(), 'ws-'));
    const dir = await mkdtemp(join(tmpdir(), 'oc-sess-'));
    const bin = join(dir, 'opencode');
    const rows = JSON.stringify([{ id: 'ses_here', directory: cwd, created: 5_000 }]);
    // 가짜 opencode 도 프로젝트 단위인 척한다 — 자기가 선 자리가 그 워크스페이스일 때만 준다.
    await writeFile(
      bin,
      `#!/bin/sh\nif [ "$(pwd -P)" = "$(cd ${cwd} && pwd -P)" ]; then cat <<'JSON'\n${rows}\nJSON\nelse echo '[]'; fi\n`,
    );
    await chmod(bin, 0o755);

    expect(await findOpencodeSessionId({ command: bin, env: ENV, cwd, sinceMs: 1_000 })).toBe('ses_here');
  });

  it('경로는 realpath 로 맞춘다 — macOS 의 `/var` 와 `/private/var` 는 같은 자리다', async () => {
    // 이 함정에 신뢰 장부에서 한 번 데였다: 문자열로 비교하면 늘 "발견 실패" 가 되고,
    // 증상은 "왜 이 스레드는 매번 새 세션이지" 로만 보인다.
    const cwd = await mkdtemp(join('/tmp', 'ws-'));       // `/tmp` 는 `/private/tmp` 의 링크다
    const command = await fakeOpencode([{ id: 'ses_link', directory: cwd, created: 5_000 }]);

    expect(await findOpencodeSessionId({ command, env: ENV, cwd, sinceMs: 1_000 })).toBe('ses_link');
  });
});
