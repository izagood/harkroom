// 하네스 능력(스펙 2026-09-20 §3 능력). 오퍼레이터가 "이 머신에 claude 가 있나, 로그인돼 있나"를
// 재서 hello 에 싣는다 — 서버는 그것을 보고 배정을 거절하고(409 harness_missing), 화면은 오퍼레이터
// 옆에 보인다. 여기서 재는 것은 판정의 재료뿐이다: PATH 의 실행 파일과 자격증명 파일의 존재.
import { describe, it, expect } from 'vitest';
import { RUNNABLE_HARNESSES } from '@harkroom/shared';
import { detectHarnesses, HARNESS_BINARIES } from '../src/harnesses.js';

const existsIn = (files: string[]) => async (p: string) => files.includes(p);

describe('detectHarnesses', () => {
  it('실행 파일이 PATH 의 어느 디렉터리에 있으면 installed, 자격증명 파일이 있으면 loggedIn', async () => {
    const out = await detectHarnesses({
      path: '/opt/homebrew/bin:/usr/bin', env: {}, home: '/home/u',
      exists: existsIn(['/opt/homebrew/bin/claude', '/home/u/.claude/.credentials.json', '/usr/bin/codex']),
    });
    expect(out).toEqual({
      'claude-code': { installed: true, loggedIn: true },
      codex: { installed: true, loggedIn: false },
      opencode: { installed: false, loggedIn: false },
    });
  });
  it('PATH 를 못 읽었으면(null) 아무것도 installed 가 아니다 — 모르는 것을 있다고 하지 않는다', async () => {
    const out = await detectHarnesses({ path: null, env: {}, home: '/home/u', exists: existsIn(['/usr/bin/claude']) });
    expect(out['claude-code']).toEqual({ installed: false, loggedIn: false });
  });
  it('CLAUDE_CONFIG_DIR·CODEX_HOME 을 존중한다 — 러너가 실제로 쓰는 자리와 같은 규칙', async () => {
    const out = await detectHarnesses({
      path: '/usr/bin', env: { CLAUDE_CONFIG_DIR: '/cfg', CODEX_HOME: '/cx' }, home: '/home/u',
      exists: existsIn(['/usr/bin/claude', '/usr/bin/codex', '/cfg/.credentials.json', '/cx/auth.json']),
    });
    expect(out).toEqual({
      'claude-code': { installed: true, loggedIn: true },
      codex: { installed: true, loggedIn: true },
      opencode: { installed: false, loggedIn: false },
    });
  });

  /**
   * **PATH 에 없어도 설치된 것이 있다**(2026-09-22 실측). opencode 의 공식 설치본은
   * `~/.opencode/bin` 에 들어가고 그 디렉터리를 PATH 에 넣는 것은 사람 몫이다 — PATH 만 보면
   * 멀쩡히 설치된 머신이 `installed:false` 가 되고, 서버는 그 하네스로의 배정을 409 로 거절한다.
   */
  it('opencode 는 PATH 에 없어도 설치 관례 자리를 본다', async () => {
    const out = await detectHarnesses({
      path: '/usr/bin', env: {}, home: '/home/u',
      exists: existsIn(['/home/u/.opencode/bin/opencode']),
    });
    expect(out.opencode).toEqual({ installed: true, loggedIn: false });
  });

  it('opencode 의 자격증명은 XDG 자리다 — `<data>/opencode/auth.json` 로 한 단계 깊다', async () => {
    const byDefault = await detectHarnesses({
      path: '/usr/bin', env: {}, home: '/home/u',
      exists: existsIn(['/home/u/.local/share/opencode/auth.json']),
    });
    expect(byDefault.opencode?.loggedIn).toBe(true);

    const byXdg = await detectHarnesses({
      path: '/usr/bin', env: { XDG_DATA_HOME: '/data' }, home: '/home/u',
      exists: existsIn(['/data/opencode/auth.json']),
    });
    expect(byXdg.opencode?.loggedIn).toBe(true);
  });
  it('실행 파일 이름 표는 RUNNABLE_HARNESSES 와 같은 키다', () => {
    // 목록을 손으로 적지 않는다 — 러너가 돌리는 하네스가 늘면 여기도 늘어야 하고,
    // 그 사실을 사람이 옮겨 적게 두면 언젠가 한쪽만 늘어난다(그때 증상은 409 거절이다).
    expect(Object.keys(HARNESS_BINARIES).sort()).toEqual([...RUNNABLE_HARNESSES].sort());
  });
});
