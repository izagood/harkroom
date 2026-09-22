import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureWorkspace, resolveWorkspaceName, workspaceName, type Exec } from '../src/workspace.js';

describe('workspaceName', () => {
  it('같은 스레드라도 에이전트가 다르면 이름이 다르다 (spec §3 다중 에이전트)', () => {
    const a = workspaceName('forge', 'ch1/m9');
    const b = workspaceName('scout', 'ch1/m9');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^harkroom-forge-[0-9a-f]{8}$/);
  });

  // 이름이 호출마다 달라지면 매 턴 새 워크스페이스가 생겨 세션 연속성(sessions.ts 의
  // lastFedSeq 등)이 조용히 무의미해진다 — 같은 입력이면 언제나 같은 이름이어야 한다.
  it('같은 handle·threadKey 는 몇 번을 불러도 같은 이름을 낸다', () => {
    expect(workspaceName('forge', 'ch1/m9')).toBe(workspaceName('forge', 'ch1/m9'));
  });

  /**
   * #846 — **이름이 바뀌어도 같은 워크스페이스로 돌아온다.**
   *
   * 에이전트 이름은 바뀐다(#843). 이 줄이 없으면 이름을 바꾼 에이전트는 스레드마다 새
   * 워크스페이스를 하나씩 더 만들고, 그때까지 하던 일은 옛 디렉터리에 남겨진다 —
   * 커밋하지 않은 변경이 있으면 그대로 잃는다.
   */
  it('이름이 바뀌어도 이미 있는 워크스페이스를 쓴다', () => {
    const before = workspaceName('forge', 'ch1/m9');
    expect(workspaceName('anvil', 'ch1/m9', [before])).toBe(before);
  });

  /** 다른 스레드의 디렉터리를 주워 오지 않는다 — 고르는 기준은 **그 스레드의 해시**다. */
  it('다른 스레드의 워크스페이스는 물려받지 않는다', () => {
    const other = workspaceName('forge', 'ch1/m1');
    expect(workspaceName('anvil', 'ch1/m9', [other])).toBe(workspaceName('anvil', 'ch1/m9'));
  });

  /** 첫 턴(뿌리가 비었다)은 예전 그대로다. */
  it('물려받을 것이 없으면 새 이름으로 짓는다', () => {
    expect(workspaceName('forge', 'ch1/m9', [])).toBe('harkroom-forge-' + workspaceName('forge', 'ch1/m9').split('-').pop());
  });

  /**
   * **새로 짓는 이름에서 handle 을 빼지 않는다.** 이 이름은 디렉터리 이름이면서 동시에
   * `avcs workspace project <이름>` 의 워크스페이스 이름이다 — 같은 저장소를 가리키는 두
   * 에이전트가 한 스레드에 불리면 해시만으로 지은 이름은 같아지고, 그때 격리가 조용히
   * 사라진다(이 파일 머리의 경고이자 위 첫 줄이 지키는 것).
   */
  it('물려받는 것은 이미 있을 때뿐이고, 새 이름은 여전히 handle 로 갈린다', () => {
    expect(workspaceName('forge', 'ch1/m9', [])).not.toBe(workspaceName('scout', 'ch1/m9', []));
  });
});

describe('resolveWorkspaceName (#846)', () => {
  it('디스크에 이미 있는 이름을 물려준다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'ws-adopt-'));
    const before = workspaceName('forge', 'ch1/m9');
    await mkdir(join(base, before), { recursive: true });
    expect(await resolveWorkspaceName(base, 'anvil', 'ch1/m9')).toBe(before);
  });

  /** 뿌리가 아직 없는 첫 턴에 던지지 않는다 — 그때는 새 이름이다. */
  it('뿌리가 없어도 새 이름을 낸다', async () => {
    const missing = join(tmpdir(), 'ws-none-', String(Date.now()));
    expect(await resolveWorkspaceName(missing, 'forge', 'ch1/m9')).toBe(workspaceName('forge', 'ch1/m9'));
  });
});

describe('ensureWorkspace', () => {
  it('디렉터리가 없으면 avcs workspace project 를 부른다', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    };
    const dir = await ensureWorkspace(exec, {
      handle: 'forge',
      threadKey: 'ch1/m9',
      baseDir: '/tmp/nonexistent-base',
      repoDir: '/repo',
    });
    expect(calls[0]![0]).toBe('avcs');
    expect(calls[0]).toContain('project');
    expect(dir).toContain('harkroom-forge-');
  });

  // 브리프가 요구하는 판단: "이미 있으면 project 를 다시 부르지 않는다"는 경로가 반환한
  // 문자열이 그럴싸해 보이는 것만으로는 증명되지 않는다 — exec 가 실제로 한 번도 불리지
  // 않았음을 확인해야, 매 턴 재병합을 시도해 느려지거나 실패하는 회귀를 잡는다.
  it('디렉터리가 이미 있으면 exec 를 아예 부르지 않고 그 경로를 바로 돌려준다', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ws-'));
    const name = workspaceName('forge', 'ch1/m9');
    const existingDir = join(baseDir, name);
    await mkdir(existingDir, { recursive: true });

    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: '', stderr: '' };
    };

    const dir = await ensureWorkspace(exec, { handle: 'forge', threadKey: 'ch1/m9', baseDir, repoDir: '/repo' });

    expect(calls).toHaveLength(0);
    expect(dir).toBe(existingDir);
  });

  // Task 4 리뷰 지적: access() 는 파일과 디렉터리를 구분하지 않는다 — 비정상 종료가 남긴
  // 빈 파일 등을 디렉터리로 착각해 그 경로를 그대로 돌려주면, 그 값이 cwd 로 쓰이는 PTY
  // spawn 이 ENOTDIR 로 죽거나 더 나쁘게 엉뚱한 곳에서 돈다. 이건 avcs repo 여부와 무관한
  // 사람이 고쳐야 할 상태라 폴백하지 않고 던져야 한다.
  it('워크스페이스 경로에 디렉터리가 아닌 파일이 있으면 폴백하지 않고 던진다', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'ws-'));
    const name = workspaceName('forge', 'ch1/m9');
    await writeFile(join(baseDir, name), '');

    const exec: Exec = async () => ({ code: 0, stdout: '', stderr: '' });

    await expect(
      ensureWorkspace(exec, { handle: 'forge', threadKey: 'ch1/m9', baseDir, repoDir: '/repo' }),
    ).rejects.toThrow(/디렉터리가 아닌 파일/);
  });

  it('avcs repo 가 아니면 격리 없이 repoDir 로 폴백한다 — 채팅 전용 에이전트가 죽으면 안 된다', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'error: not an AVCS repo: /repo (run `avcs init`)' });
    const dir = await ensureWorkspace(exec, { handle: 'forge', threadKey: 'k', baseDir: '/tmp/x', repoDir: '/repo' });
    expect(dir).toBe('/repo'); // 기능 후퇴(격리 없음)이지 정지가 아니다 — spec §8 의 판단과 같다
  });

  it('그 외 project 실패는 stderr 를 담아 던진다 — 조용한 실패 금지', async () => {
    const exec: Exec = async () => ({ code: 1, stdout: '', stderr: 'lease conflict' });
    await expect(
      ensureWorkspace(exec, { handle: 'forge', threadKey: 'k', baseDir: '/tmp/x', repoDir: '/repo' }),
    ).rejects.toThrow(/lease conflict/);
  });
});
