// 개발 빌드 서명 훅이 **자리에 있는지** 고정하는 회귀선(#450 후속).
//
// ## 무엇을 막는가
//
// 러너 기동은 에이전트마다 PAT 를 따로 읽으므로(`murmur.runner.pat.<agentId>`), 키체인
// 승인이 다시 걸리면 **러너 수만큼** 대화상자가 뜬다. 승인이 다시 걸리는 이유는 링커의
// ad-hoc 서명이 designated requirement 를 **내용 해시**로 만들기 때문이고, 해시는
// 재빌드마다 바뀐다(실측 2026-09-06: 별개로 빌드한 같은 프로그램이 서로 다른 cdhash).
//
// ## 왜 이렇게 좁게 재는가
//
// **진짜 증거는 실제 서명이다** — 키체인 승인 대화상자를 테스트에서 만들 수 없고,
// 인증서는 각자 기계에서 만드는 것이라 CI 에도 없다. 그래서 `bundleSignable.test.ts` 와
// 같은 태도를 취한다: 한 번 붙인 성질이 **조용히 떨어져 나가지 않게** 붙잡는 것뿐이다.
// 훅이 사라지면 승인 폭풍이 돌아오는데, 그때는 원인이 멀어져 있다.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const here = join(import.meta.dirname, '..');

describe('개발 빌드 서명 훅', () => {
  it('cargo runner 가 서명 스크립트를 거쳐 실행한다', () => {
    const cfg = readFileSync(join(here, 'src-tauri/.cargo/config.toml'), 'utf8');
    expect(cfg).toContain('runner');
    expect(cfg).toContain('sign-dev-and-run.sh');
  });

  /**
   * **경로가 `src-tauri` 기준이어야 한다.** 처음에 `scripts/…` 로 뒀다가 실제 실행에서
   * 깨졌다 — cargo 가 `src-tauri` 에서 부르므로 그 자리엔 `scripts/` 가 없다:
   *
   *     sh: scripts/sign-dev-and-run.sh: No such file or directory
   *
   * 앱이 아예 안 뜨는 결함이라, 경로를 되돌리면 이 줄이 먼저 잡아야 한다.
   */
  it('runner 경로가 src-tauri 기준으로 실재한다', () => {
    const cfg = readFileSync(join(here, 'src-tauri/.cargo/config.toml'), 'utf8');
    const path = cfg.match(/sign-dev-and-run\.sh/) ? cfg.match(/"([^"]*sign-dev-and-run\.sh)"/)?.[1] : null;
    expect(path).toBeTruthy();
    expect(existsSync(join(here, 'src-tauri', path!))).toBe(true);
  });

  it('두 스크립트 모두 실행 가능하다', () => {
    for (const s of ['scripts/sign-dev.sh', 'scripts/sign-dev-and-run.sh']) {
      const p = join(here, s);
      expect(existsSync(p)).toBe(true);
      // 실행 비트가 빠지면 `sh <file>` 로는 돌아도 의도가 흐려진다.
      expect(statSync(p).mode & 0o111).toBeGreaterThan(0);
    }
  });

  /**
   * **인증서가 없는 기계에서 조용히 넘어가야 한다.** 이 인증서는 개인 키라 저장소에 담을
   * 수 없고 CI 에도 없다 — 없을 때 실패로 처리하면 남의 빌드가 깨진다.
   */
  it('인증서가 없어도 빌드를 깨뜨리지 않는다', () => {
    const out = execFileSync('sh', [join(here, 'scripts/sign-dev.sh'), '/bin/echo'], {
      encoding: 'utf8',
      env: { ...process.env, MURMUR_SIGN_IDENTITY: '존재하지-않는-인증서-이름' },
    });
    // 아무 일도 하지 않고 성공으로 끝난다(위 호출이 던지지 않는 것이 곧 그 확인이다).
    expect(out).not.toContain('서명했다');
  });

  /**
   * **`sign-app.mjs` 와 같은 환경변수를 쓴다.** 서명 신원을 고르는 자리가 개발과 릴리즈에서
   * 갈라지면, 한쪽만 고쳐 놓고 다른 쪽이 왜 안 되는지 찾게 된다.
   */
  it('릴리즈 스크립트와 같은 환경변수로 신원을 덮는다', () => {
    const dev = readFileSync(join(here, 'scripts/sign-dev.sh'), 'utf8');
    const rel = readFileSync(join(here, 'scripts/sign-app.mjs'), 'utf8');
    expect(dev).toContain('MURMUR_SIGN_IDENTITY');
    expect(rel).toContain('MURMUR_SIGN_IDENTITY');
  });
});
