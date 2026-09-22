import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNameLink, NAME_LINK_DIR, nameLinkPath, resolveAgentStateDir } from '../src/stateDir.js';

describe('resolveAgentStateDir (#167)', () => {
  // 이 이슈의 핵심 회귀선. handle 만으로 나누면 서로 다른 서버의 같은 handle 이 같은
  // 디렉터리를 써서 sessions.json 이 섞이고, 섞인 뒤에는 풀 수 없다.
  it('같은 handle 이라도 계정 id 가 다르면 디렉터리가 다르다', () => {
    const a = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const b = resolveAgentStateDir('/state', 'forge', 'acct-2');
    expect(a.agentStateDir).not.toBe(b.agentStateDir);
  });

  // **URL 무관함은 시그니처가 보장한다** — 이 함수는 URL 을 받지 않는다. 그래서 같은
  // 서버를 localhost 로 붙든 LAN IP 로 붙든 계정 id 가 같아 디렉터리가 같다.
  // 테스트로 표현할 수 있는 것은 "같은 (handle, id) 면 같은 경로"뿐이다 — 앞선 초안은
  // 이것을 "URL 이 달라도 같다"로 이름 붙였는데, URL 이 인자에 없으니 그 테스트는
  // f(a,b,c) === f(a,b,c) 라는 동어반복이었다.
  it('같은 handle·id 면 항상 같은 경로다', () => {
    const a = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const b = resolveAgentStateDir('/state', 'forge', 'acct-1');
    expect(a.agentStateDir).toBe(b.agentStateDir);
  });

  it('baseDir 가 다르면 경로가 다르다', () => {
    const a = resolveAgentStateDir('/state-a', 'forge', 'acct-1');
    const b = resolveAgentStateDir('/state-b', 'forge', 'acct-1');
    expect(a.agentStateDir).not.toBe(b.agentStateDir);
  });

  /**
   * **의도된 회귀선이다(#850).** 초판은 `<handle>-<id>` 로 짓고 *"handle 은 사람이 디렉터리를
   * 보고 알아볼 수 있게 하려고 넣는다"* 고 적었다. 그 꼬리표는 이름이 바뀌면 **거짓말로 남는다**
   * (jaebin 지시: 안은 id, 부르는 이름은 언제 바꿔도 동작에 영향이 없어야 한다 — 디렉터리도).
   * 사람이 찾는 길은 `by-name/<handle>` 심링크가 따로 낸다 — 그쪽은 기동 때마다 다시 걸리므로
   * 언제나 지금 이름이다.
   */
  it('뿌리 이름은 id 하나다 — 이름은 안 들어간다', () => {
    const { agentStateDir } = resolveAgentStateDir('/state', 'my-handle', 'acct-1');
    expect(agentStateDir).toBe('/state/acct-1');
    expect(agentStateDir).not.toContain('my-handle');
  });

  it('사람이 찾아 들어가는 길은 by-name 심링크다', () => {
    expect(nameLinkPath('/state', 'my-handle')).toBe('/state/by-name/my-handle');
  });

  // legacyPath 는 서버별로 갈리기 **전** 경로다. 호출자가 존재를 확인해 운영자에게
  // 안내한다 — 자동으로 옮기지 않는다.
  it('legacyPath 는 handle 만으로 만든 예전 경로다', () => {
    const { legacyPath, agentStateDir } = resolveAgentStateDir('/state', 'forge', 'acct-1');
    expect(legacyPath).toBe('/state/forge');
    expect(legacyPath).not.toBe(agentStateDir);
  });
});

describe('resolveAgentStateDir (#174 instance)', () => {
  /**
   * 요구 1 — **하위 호환.** 지금 돌고 있는 러너가 재시작에 상태를 잃으면 안 되므로
   * 인스턴스가 없을 때의 경로는 `#167` 이 만든 것과 **문자 그대로** 같아야 한다.
   * 그래서 리터럴로 적는다: `resolveAgentStateDir` 를 다시 불러 비교하면 규칙이 바뀌어도
   * 양쪽이 함께 바뀌어 통과한다.
   */
  it('instance 가 없으면 경로 넷 전부가 #167 의 경로와 문자 그대로 같다', () => {
    const paths = resolveAgentStateDir('/state', 'forge', 'acct-1');
    expect(paths.agentStateDir).toBe('/state/acct-1');
    expect(paths.sessionsPath).toBe('/state/acct-1/sessions.json');
    expect(paths.mcpDir).toBe('/state/acct-1/mcp');
    expect(paths.workspaceBaseDir).toBe('/state/acct-1/workspaces');
  });

  it('undefined 를 명시적으로 넘긴 것과 생략한 것이 같다', () => {
    const without = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const explicit = resolveAgentStateDir('/state', 'forge', 'acct-1', undefined);
    expect(explicit).toEqual(without);
  });

  /** 요구 2 — 인스턴스는 **마지막 세그먼트**다. 리터럴로 적는다(같은 이유). */
  it('instance 가 있으면 경로 마지막에 붙는다', () => {
    const { agentStateDir } = resolveAgentStateDir('/state', 'forge', 'acct-1', 'instance-a');
    expect(agentStateDir).toBe('/state/acct-1/instance-a');
  });

  /**
   * 요구 4 — **세션 파일·MCP 설정·avcs 워크스페이스 셋 다** 인스턴스 아래여야 한다.
   *
   * 하나만 옛 경로에 남으면 그 파일을 두 인스턴스가 밟고, 격리는 없는 것과 같아진다.
   * 그래서 셋을 **각각** 단언한다 — 뿌리 하나만 보는 단언은 뿌리가 맞아도 그 아래를
   * 안 쓰는 구현을 통과시킨다(개수·존재만 보는 회귀선의 전형).
   */
  it('세션 파일·MCP 설정·avcs 워크스페이스 셋 다 인스턴스 경로 아래다', () => {
    const p = resolveAgentStateDir('/state', 'forge', 'acct-1', 'a');
    expect(p.agentStateDir).toBe('/state/acct-1/a');
    expect(p.sessionsPath).toBe('/state/acct-1/a/sessions.json');
    expect(p.mcpDir).toBe('/state/acct-1/a/mcp');
    expect(p.workspaceBaseDir).toBe('/state/acct-1/a/workspaces');
  });

  /**
   * 요구 2·4 — 두 인스턴스가 **어느 것도** 공유하지 않는다.
   *
   * 뿌리만 비교하면 부족하다: 뿌리는 갈렸는데 세션 파일만 옛 뿌리에 두는 구현이 통과한다.
   * 그래서 네 경로를 짝지어 전부 다름을 단언한다.
   */
  it('두 인스턴스는 뿌리·세션·MCP·워크스페이스 어느 것도 공유하지 않는다', () => {
    const a = resolveAgentStateDir('/state', 'forge', 'acct-1', 'a');
    const b = resolveAgentStateDir('/state', 'forge', 'acct-1', 'b');
    for (const key of ['agentStateDir', 'sessionsPath', 'mcpDir', 'workspaceBaseDir'] as const) {
      expect(a[key], key).not.toBe(b[key]);
    }
  });

  /** 인스턴스를 준 러너와 안 준 러너도 서로를 밟지 않는다(같은 계정으로 섞어 띄우는 경우). */
  it('인스턴스를 준 러너와 안 준 러너의 경로도 전부 다르다', () => {
    const base = resolveAgentStateDir('/state', 'forge', 'acct-1');
    const inst = resolveAgentStateDir('/state', 'forge', 'acct-1', 'a');
    for (const key of ['agentStateDir', 'sessionsPath', 'mcpDir', 'workspaceBaseDir'] as const) {
      expect(base[key], key).not.toBe(inst[key]);
    }
  });

  /** `legacyPath` 는 인스턴스와 무관하다 — 그 경로가 있던 시절에는 인스턴스가 없었다. */
  it('legacyPath 는 인스턴스에 영향받지 않는다', () => {
    expect(resolveAgentStateDir('/state', 'forge', 'acct-1', 'a').legacyPath).toBe('/state/forge');
  });

  /**
   * #843 이름 변경. 이 묶음이 지키는 것 하나: **이름이 바뀌어도 상태는 같은 자리에 있다.**
   * 이것이 깨지면 이름을 바꾼 에이전트가 다음 기동에 모든 스레드의 세션과 워크스페이스를
   * 잃는다 — 서버가 오래 이름 변경을 막았던 바로 그 이유다.
   */
  it('옛 `<handle>-<id>` 뿌리가 있으면 그것을 그대로 쓴다', () => {
    const before = { agentStateDir: '/state/forge-acct-1', sessionsPath: '/state/forge-acct-1/sessions.json',
      workspaceBaseDir: '/state/forge-acct-1/workspaces', codexHomeDir: '/state/forge-acct-1/codex-home' };
    const after = resolveAgentStateDir('/state', 'anvil', 'acct-1', undefined, ['forge-acct-1']);
    expect(after.agentStateDir).toBe(before.agentStateDir);
    expect(after.sessionsPath).toBe(before.sessionsPath);
    expect(after.workspaceBaseDir).toBe(before.workspaceBaseDir);
    expect(after.codexHomeDir).toBe(before.codexHomeDir);
  });

  /** 인스턴스 축은 그대로 남는다 — 옛 뿌리를 물려받되 인스턴스끼리는 여전히 갈린다. */
  /** 지금 모양(`<id>`)의 뿌리가 이미 있으면 그것을 고른다 — 새로 짓지 않는다. */
  it('id 뿌리가 이미 있으면 그것을 쓴다', () => {
    expect(resolveAgentStateDir('/state', 'forge', 'acct-1', undefined, ['acct-1']).agentStateDir)
      .toBe('/state/acct-1');
  });

  it('옛 디렉터리를 물려받아도 인스턴스는 갈린다', () => {
    const a = resolveAgentStateDir('/state', 'anvil', 'acct-1', 'a', ['forge-acct-1']);
    const b = resolveAgentStateDir('/state', 'anvil', 'acct-1', 'b', ['forge-acct-1']);
    expect(a.agentStateDir).toBe('/state/forge-acct-1/a');
    expect(b.agentStateDir).toBe('/state/forge-acct-1/b');
  });

  /** 남의 디렉터리를 주워 오지 않는다 — 꼬리표가 아니라 **id** 로 고른다. */
  it('다른 에이전트의 디렉터리는 물려받지 않는다', () => {
    const { agentStateDir } = resolveAgentStateDir(
      '/state', 'anvil', 'acct-2', undefined, ['forge-acct-1', 'anvil-acct-9'],
    );
    expect(agentStateDir).toBe('/state/acct-2');
  });

  /** 첫 기동(디렉터리가 하나도 없음)은 예전 그대로다. */
  it('물려받을 것이 없으면 새 이름으로 만든다', () => {
    expect(resolveAgentStateDir('/state', 'forge', 'acct-1', undefined, []).agentStateDir)
      .toBe('/state/acct-1');
  });

  /**
   * id 는 UUID 라 다른 id 의 **접미**가 될 수 없지만, 그것을 우연에 맡기지 않는다.
   * `endsWith(id)` 로 썼다면 `x-2acct-1` 이 `acct-1` 의 자리를 훔친다.
   */
  it('id 는 하이픈 경계로 맞춘다', () => {
    expect(resolveAgentStateDir('/state', 'forge', 'acct-1', undefined, ['x-2acct-1']).agentStateDir)
      .toBe('/state/acct-1');
  });
});

/**
 * #850 — 뿌리 이름이 id 하나가 됐으므로 사람이 눈으로 찾을 길을 따로 낸다.
 *
 * 이 묶음이 지키는 것 둘:
 *  - 링크는 **지금 이름**이다(이름이 바뀌면 옛 이름의 링크가 남지 않는다)
 *  - 남의 파일을 지우지 않는다(심링크가 아니면 손대지 않는다)
 */
describe('ensureNameLink (#850)', () => {
  const linkTarget = async (base: string, handle: string): Promise<string | null> =>
    readlink(nameLinkPath(base, handle)).catch(() => null);

  it('이름 → 뿌리 링크를 건다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'namelink-'));
    await ensureNameLink(base, 'forge', 'acct-1');
    expect(await linkTarget(base, 'forge')).toBe(join('..', 'acct-1'));
  });

  /**
   * **이름을 바꾸면 옛 링크가 사라진다.** 남겨 두면 `by-name/` 이 "한 에이전트를 가리키는
   * 이름이 둘" 이라고 말하고, 그중 무엇이 지금 이름인지는 아무 데도 안 적혀 있다 —
   * 편의로 낸 것이 오히려 사람을 헷갈리게 한다.
   */
  it('이름이 바뀌면 옛 이름의 링크를 걷어낸다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'namelink-'));
    await ensureNameLink(base, 'forge', 'acct-1');
    await ensureNameLink(base, 'anvil', 'acct-1');
    expect(await linkTarget(base, 'anvil')).toBe(join('..', 'acct-1'));
    expect(await linkTarget(base, 'forge')).toBeNull();
  });

  /** 다른 에이전트의 링크는 남긴다 — 걷어내는 기준은 **같은 뿌리**다. */
  it('다른 뿌리를 가리키는 링크는 건드리지 않는다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'namelink-'));
    await ensureNameLink(base, 'scout', 'acct-2');
    await ensureNameLink(base, 'forge', 'acct-1');
    expect(await linkTarget(base, 'scout')).toBe(join('..', 'acct-2'));
  });

  /** 두 번 불러도 같다 — 기동마다 부른다. */
  it('여러 번 불러도 같은 링크 하나다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'namelink-'));
    await ensureNameLink(base, 'forge', 'acct-1');
    await ensureNameLink(base, 'forge', 'acct-1');
    expect(await readdir(join(base, NAME_LINK_DIR))).toEqual(['forge']);
  });

  /**
   * **남의 파일은 지우지 않는다.** 그 자리에 진짜 디렉터리가 있으면 사람이 둔 것일 수 있고,
   * 편의 기능이 남의 파일을 지우는 것은 어떤 편의로도 못 갚는다.
   */
  it('그 자리에 진짜 디렉터리가 있으면 손대지 않는다', async () => {
    const base = await mkdtemp(join(tmpdir(), 'namelink-'));
    const real = nameLinkPath(base, 'forge');
    await mkdir(real, { recursive: true });
    await writeFile(join(real, 'keep.txt'), 'mine');

    await ensureNameLink(base, 'forge', 'acct-1');

    expect(await readdir(real)).toEqual(['keep.txt']);
  });

  /**
   * 링크를 못 만들어도 던지지 않는다 — 없어도 러너는 똑같이 돈다.
   *
   * **뿌리 자리에 파일을 둬서** 실패를 만든다. 처음에는 `/proc/...` 같은 못 쓰는 경로를
   * 썼는데 그것은 OS 마다 다르게 굴고(리눅스 CI 에서 5초를 먹고 타임아웃했다), 테스트가
   * 재려는 것은 "이 환경에서 못 만든다"가 아니라 **"못 만들면 조용히 넘어간다"** 다.
   * 파일 아래에는 어느 OS 에서도 디렉터리를 못 만든다(ENOTDIR).
   */
  it('실패해도 던지지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'namelink-'));
    const notADir = join(dir, 'base');
    await writeFile(notADir, 'not a directory');
    await expect(ensureNameLink(notADir, 'forge', 'acct-1')).resolves.toBeUndefined();
  });
});
