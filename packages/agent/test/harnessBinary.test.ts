/**
 * `harnessBinaryName` 이 **러너가 실제로 실행하는 것**과 같은지 재는 회귀선(`#473`).
 *
 * ## 왜 이 파일이 있어야 하나 — 표가 두 곳에 있다
 *
 * 진실의 원천은 `turn.ts` 의 `PRESETS` 다. 러너가 `PATH` 에서 찾는 실행 파일이 거기서
 * 나온다. 그런데 화면 문구를 만드는 것은 앱이고, **앱은 `@murmur/agent` 를 못 들인다**
 * (데스크탑의 devDependency 이고 `node-pty` 같은 네이티브 의존을 끌고 온다). 그래서
 * 이름만 `@murmur/shared` 에 따로 뒀다.
 *
 * 사본이 둘이면 갈린다. 갈리는 날 앱은 없는 실행 파일 이름을 사람에게 말하고 —
 * *"`claude` 를 설치하라"* 인데 러너는 다른 것을 찾고 있는 상태 — 사람은 설치하고도
 * 안 고쳐지는 것을 겪는다. `#473` 이 고치려는 증상이 이름만 바뀐 채 되돌아온다.
 *
 * **그래서 이 파일이 둘을 대조한다.** 여기가 그 갈림을 잡는 유일한 자리다.
 *
 * `PRESETS` 를 직접 읽지 않고 `buildTurnCommand` 를 통해 재는 이유: 그 표는 export 되지
 * 않고(모듈 안의 구현 세부다), 그것을 열려고 export 를 늘리면 다음 사람이 표를 밖에서
 * 참조하기 시작한다. 러너가 **실제로 만드는 계획**의 `command` 를 보는 편이 재는 대상과
 * 도는 대상이 같다는 점에서도 낫다.
 */
import { describe, expect, it } from 'vitest';
import { harnessBinaryName, RUNNABLE_HARNESSES } from '@murmur/shared';

import { buildTurnCommand } from '../src/turn.js';

/** 어느 하네스로도 계획을 세울 수 있는 최소 입력. 재는 것은 `command` 하나다. */
function 계획(harness: (typeof RUNNABLE_HARNESSES)[number]): string {
  return buildTurnCommand({
    harness,
    mode: 'mention',
    // codex 는 첫 턴에 세션 id 가 없어도 되고 claude 는 있어야 한다 — 둘 다 통과하도록
    // id 를 준다. 이 값은 `command` 에 영향을 주지 않는다.
    sessionId: '11111111-2222-4333-8444-555555555555',
    isFirstTurn: true,
    systemPrompt: '지시문',
    // claude 는 지시문을 **파일로만** 받는다(`#92`, argv 노출 방지) — 없으면 던진다.
    // 이 값도 `command` 에는 영향을 주지 않는다.
    systemPromptFile: '/tmp/system-prompt.txt',
    promptCtx: '본문',
    model: null,
    effort: null,
    mentionPermission: 'readonly',
    mcpConfigPath: '/tmp/mcp.json',
    pat: 'murp_x',
    murmurUrl: 'https://murmur.example',
    codexHome: '/tmp/codex-home',
    claudeConfigDir: null,
  }).command;
}

describe('harnessBinaryName 이 PRESETS 의 실행 파일과 같다 (#473)', () => {
  /**
   * **되돌려 RED**: `@murmur/shared` 의 `harnessBinaryName` 에서 `'claude-code'` 의 답을
   * `'claude-code'` 로 바꾸면(그럴듯한 실수다 — 하네스 이름과 실행 파일 이름이 다르다는
   * 것이 이 표의 존재 이유다) 이 단언이 빨개진다.
   */
  it('실행 가능한 하네스 전부에서 두 값이 일치한다', () => {
    for (const harness of RUNNABLE_HARNESSES) {
      expect(harnessBinaryName(harness)).toBe(계획(harness));
    }
  });

  /**
   * 실행 가능한 하네스가 늘었는데 이름 표를 안 고치면 앱은 그 하네스에 대해 문구에서
   * 이름을 빼먹는다 — *"이 에이전트의 하네스(…)를 찾을 수 없다"* 로 나가고, 사람은
   * 다시 무엇을 설치할지 모른다. **`null` 이 남아 있으면 여기서 잡는다.**
   */
  it('실행 가능한 하네스에는 이름이 반드시 있다 — 새 하네스를 붙일 때 여기가 걸린다', () => {
    for (const harness of RUNNABLE_HARNESSES) {
      expect(harnessBinaryName(harness)).not.toBeNull();
    }
  });

  /** 모르는 값에는 지어내지 않는다(`#368`). */
  it('실행하지 않는 하네스와 모르는 값에는 이름을 지어내지 않는다', () => {
    // `gemini` 는 `PRESETS.gemini === 'unsupported'` 라 러너가 실행하지 않는다.
    expect(harnessBinaryName('gemini')).toBeNull();
    expect(harnessBinaryName('없는하네스')).toBeNull();
    expect(harnessBinaryName(undefined)).toBeNull();
    expect(harnessBinaryName(null)).toBeNull();
  });
});
