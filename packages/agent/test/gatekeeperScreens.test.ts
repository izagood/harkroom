import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { looksReadyForPrompt } from '../src/pty.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name: string) => readFileSync(join(fixtures, name), 'utf8');

/**
 * 하네스의 **첫 실행 관문** 화면들(2026-09-08 실물). TUI 로 도는 멘션 턴은 이 화면들을
 * 만나고, 그때 프롬프트를 넣으면 관문에 타이핑된다 — 그래서 준비 판정은 여기서 반드시
 * 거짓이어야 한다.
 *
 * **관문이 늘 때마다 여기에 한 줄이 붙는다.** 그것이 이 파일의 값이다: 하네스의 첫 실행
 * 흐름은 우리 계약이 아니라서 다음 버전이 관문을 더할 수 있고, 그때 이 목록이 회귀선이 된다.
 *
 * 각 관문의 저장 위치(실측):
 * - ① 온보딩: `<configDir>/.claude.json` 최상위 `hasCompletedOnboarding` — **계정 단위**
 * - ② 폴더 신뢰: 같은 파일의 `projects[dir].hasTrustDialogAccepted` — **워크스페이스 단위**
 *   (`workspaceTrust.ts` 가 심는다)
 * - ③ bypass 수락: `<configDir>/settings.json` 의 `skipDangerousModePermissionPrompt` —
 *   **계정 단위**
 */
describe('첫 실행 관문 화면은 준비가 아니다', () => {
  const 관문들 = [
    ['① 온보딩 테마 선택', 'claude-tui-onboarding-theme.txt'],
    ['② 폴더 신뢰', 'claude-tui-trust-modal.txt'],
    ['③ bypassPermissions 수락', 'claude-tui-bypass-warning.txt'],
  ] as const;

  for (const [label, file] of 관문들) {
    it(`${label} 화면에서 준비 신호가 거짓이다`, () => {
      expect(looksReadyForPrompt(read(file))).toBe(false);
    });
  }

  it('입력 프롬프트에 도달한 실물 화면에서만 참이다', () => {
    // 관문 셋을 모두 지난 뒤의 실물 화면. `❯` 다음이 U+00A0(NBSP)이고, 그것이 입력창과
    // 승인 메뉴를 가르는 신호다 — 메뉴는 `❯ No, exit` 처럼 보통 공백을 쓴다.
    expect(looksReadyForPrompt(read('claude-tui-ready-real.txt'))).toBe(true);
  });

  // **커서 문자만으로는 못 가른다.** 이 단언이 없으면 다음 사람이 판정을 `/[❯›]/` 로
  // 되돌리고, 그 순간 모든 관문이 준비로 읽혀 프롬프트가 승인 메뉴에 타이핑된다.
  it('관문 화면에도 커서 문자는 있다 — 커서만 보는 판정으로 되돌리지 마라', () => {
    for (const [, file] of 관문들) {
      expect(/[❯›]/.test(read(file))).toBe(true);
    }
  });

  // ②와 ③은 화면에 **똑같이** `No, exit` 를 쓴다. 2026-09-08 에 커서 뒤 바이트만 보고
  // ②를 ③으로 읽어 "관문이 워크스페이스 단위다"라는 틀린 결론을 냈다 — 두 화면을 가르는
  // 것은 커서가 아니라 문구다.
  //
  // **문구를 raw 에서 그대로 찾을 수 없다**: TUI 는 절대 커서 이동(`ESC[<n>G`)으로 단어를
  // 하나씩 놓는다. 단어 사이의 빈칸은 **공백 문자가 아니라 커서 점프**라서, ANSI 를 걷어내면
  // `No,exit` 처럼 붙어 버린다. 그래서 공백을 지우고 비교한다 — 픽스처가 실물인 이상 이
  // 성질을 피할 수 없고, 피하려고 픽스처를 다듬으면 실물과 다른 것을 재게 된다.
  const 화면글자 = (raw: string) =>
    raw
      .replace(/\][^]*(?:|\\)/g, '')
      .replace(/[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\s+/g, '');

  it('②와 ③은 문구로만 갈린다', () => {
    const 신뢰 = 화면글자(read('claude-tui-trust-modal.txt'));
    const bypass = 화면글자(read('claude-tui-bypass-warning.txt'));
    // 같은 선택지 문구를 쓴다 — 이것이 커서만으로 못 가르는 이유다.
    for (const s of [신뢰, bypass]) expect(s).toContain('No,exit');
    expect(bypass).toContain('BypassPermissionsmode');
    expect(신뢰).not.toContain('BypassPermissionsmode');
    expect(신뢰).toContain('trust');
  });
});
