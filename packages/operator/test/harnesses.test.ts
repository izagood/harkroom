// 하네스 능력(스펙 2026-09-20 §3 능력). 오퍼레이터가 "이 머신에 claude 가 있나, 로그인돼 있나"를
// 재서 hello 에 싣는다 — 서버는 그것을 보고 배정을 거절하고(409 harness_missing), 화면은 오퍼레이터
// 옆에 보인다. 여기서 재는 것은 판정의 재료뿐이다: PATH 의 실행 파일과 자격증명 파일의 존재.
import { describe, it, expect } from 'vitest';
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
    expect(out).toEqual({ 'claude-code': { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true } });
  });
  it('실행 파일 이름 표는 RUNNABLE_HARNESSES 와 같은 키다', () => {
    expect(Object.keys(HARNESS_BINARIES).sort()).toEqual(['claude-code', 'codex']);
  });
});
