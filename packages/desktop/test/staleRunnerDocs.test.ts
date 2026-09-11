/**
 * **문서가 없는 것을 안내하지 않는다** — 낡은 러너 구조 회귀선(`#431` 사이드카·daemon,
 * `#482` `adopted`).
 *
 * ## 왜 문서에도 회귀선을 거는가
 *
 * `#503` 이 같은 낡음을 **화면**에서 고치며 `runnerCommand.test.tsx` 에 회귀선을 걸었다.
 * 그때 범위 밖으로 보고된 것이 문서였고, 이 파일이 그쪽을 맡는다. 문서를 테스트로 고정하는
 * 것이 이 저장소에 없는 관례는 아니다 — `packages/server/test/repoHygiene.test.ts` 가 이미
 * `README.md` 의 제목 언어와 환경변수 표를 소스에서 추출한 목록과 대조한다. 이 파일은 그
 * 선례를 따르되 대조 대상이 다르다: **화면 정본과 문서**를 맞춘다.
 *
 * ## 무엇을 재는가 — 그리고 무엇을 일부러 안 재는가
 *
 * 문서는 산문이라 "옳게 서술했는가"를 기계가 못 본다. 그래서 **사라진 것의 이름**과
 * **살아 있어야 할 사실**만 잡는다:
 *
 * - ① 맨 `pnpm --filter @harkroom/agent start` 가 **유일한 길**로 적히지 않는다.
 *   그 명령을 금지하지 않는다 — 저장소 안에서는 지금도 돈다(`packages/agent/package.json`
 *   의 `start`). 막는 것은 **사이드카 갈래 없이 그것만** 내미는 것이다. `#503` 의 ①과
 *   같은 계약이고, 재는 자리만 DOM 에서 문서로 바뀐다.
 * - ② 사라진 상태 이름(`외부에서 실행 중`)이 **지금의 안내로** 남아 있지 않다. 다만 문서는
 *   화면과 달리 *"예전에는 이렇게 적혀 있었고 그것이 왜 틀렸나"* 를 남기는 자리라
 *   (이 저장소 문체다) 그 이름이 **글자로 나타나는 것 자체**는 막지 않는다 — 상태 표의
 *   행처럼 **지금의 안내로 쓰인 자리**만 잡는다. 그 구분을 어떻게 하는지는 아래 참고.
 * - ③ 대조군. ①② 만 있으면 **"그 절을 통째로 지웠다"로도 초록이 된다.**
 *
 * 재지 않는 것: 문장의 옳음, 문단 구조, 링크. 산문 검사기를 만들 생각이 아니다.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  RUNNER_DEV_COMMAND,
  RUNNER_SIDECAR_NAME,
  RUNNER_SIDECAR_PATH,
} from '../src/lib/runnerCommand';
import { runnerStatusLabel } from '../src/components/RunnerStatus';
import { translator } from '../src/i18n';

// **`ko` 로 고정한다.** 이 파일이 재는 상대는 화면이 아니라 `docs/operations.md` 이고
// 그 문서가 한국어다 — 기대값을 다른 언어로 만들면 정본이 개명돼도 여기가 안 빨개진다
// (이 시험의 존재 이유가 그 연결이다). 문서가 옮겨지는 날 이 한 줄을 함께 옮긴다.
const ko = translator('ko');

const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

/** 사람이 러너 실행을 안내받는 문서 — 여기 낡은 명령이 남으면 그대로 붙여넣는다. */
const GUIDE_DOCS = ['docs/operations.md', 'packages/agent/README.md', 'README.md'] as const;

/**
 * 사라진 상태 이름이 **지금의 안내로** 쓰였는지 가른다.
 *
 * 문서는 *"예전에는 X 라고 적혀 있었는데 틀렸다"* 를 남기는 자리다 — 그것이 다음 사람이 또
 * 옛 구조로 되돌리지 않게 하는 장치이고 이 저장소 문체다. 그래서 이름이 나타나는 것 자체는
 * 위반이 아니고, **과거를 말하는 표지 없이** 적힌 자리만 잡는다.
 *
 * **줄이 아니라 문단(빈 줄로 갈린 블록) 단위로 본다.** 한국어 산문은 한 문장이 여러 줄로
 * 접히므로, 줄 단위로 보면 "예전에는" 과 그 이름이 다른 줄에 떨어져 멀쩡한 역사 서술이
 * 위반으로 잡힌다(실제로 처음 그렇게 빨개졌다). 표 행은 문단이 곧 표 전체라 그 안에
 * 표지가 없으면 그대로 걸린다 — 옛 상태 표가 정확히 그 모양이었다.
 */
const PAST_MARKERS = ['예전', '옛 ', '옛 표', '앞 판본', '이전', '적혀 있었', '사라진', '없어졌'];

function currentGuidanceBlocks(text: string, needle: string): string[] {
  return text
    .split(/\n\s*\n/)
    .filter((block) => block.includes(needle))
    .filter((block) => !PAST_MARKERS.some((m) => block.includes(m)))
    // 실패 메시지가 문단 전체를 쏟지 않게 첫 줄만 남긴다.
    .map((block) => block.split('\n')[0] ?? block);
}

describe('낡은 러너 구조 문서 회귀선 (#431 사이드카·daemon · #482 adopted)', () => {
  it('① `pnpm --filter @harkroom/agent start` 를 유일한 실행 방법으로 적지 않는다', () => {
    for (const rel of GUIDE_DOCS) {
      const text = read(rel);
      if (!text.includes(RUNNER_DEV_COMMAND)) continue;
      // dev 명령을 적었으면 사이드카 갈래도 **반드시** 함께 있어야 한다. 저장소가 없는
      // 사람에게는 그 명령이 붙여넣는 순간 실패한다 — `#503` 이 화면에서 막은 그것이다.
      expect(
        text.includes(RUNNER_SIDECAR_PATH) || text.includes(RUNNER_SIDECAR_NAME),
        `${rel}: pnpm 갈래만 있고 사이드카 갈래가 없다`,
      ).toBe(true);
    }
  });

  it('② 사라진 상태 이름 `외부에서 실행 중` 을 지금의 안내로 쓰지 않는다', () => {
    for (const rel of GUIDE_DOCS) {
      const blocks = currentGuidanceBlocks(read(rel), '외부에서 실행 중');
      expect(blocks, `${rel}: 사라진 상태 이름이 현재 안내로 남아 있다`).toEqual([]);
    }
  });

  it('② 검출기 자체가 옛 문장을 실제로 잡는다 (표지 목록이 커져 무력해지지 않는다)', () => {
    // `PAST_MARKERS` 가 넓어지면 ②는 아무것도 못 잡으면서 초록으로 남는다. 지웠던 그
    // 문장을 그대로 먹여 **잡히는지** 확인한다 — 검출기의 대조군이다.
    const old = '| 외부에서 실행 중 | 이미 러너가 붙어 있다(presence) — 앱은 띄우지 않았다 |';
    expect(currentGuidanceBlocks(old, '외부에서 실행 중')).toHaveLength(1);
  });

  it('② 상태 표가 지금 값의 문구를 `RunnerStatus.tsx` 와 같은 출처로 적는다', () => {
    // `#503` 의 ③과 같은 장치다. 정본이 개명되면 문서가 따라오거나, 안 따라오면 빨개진다.
    const adopted = runnerStatusLabel({
      agentId: '', status: 'adopted', exitCode: null, message: null,
    }, ko);
    expect(read('docs/operations.md')).toContain(adopted);
  });

  it('③ 대조군 — 러너를 손으로 띄우는 안내가 살아 있고, 실행 가능한 명령을 준다', () => {
    // ①②만 있으면 "그 절을 통째로 지웠다"로도 초록이다. 손으로 띄우는 길은 사라지지
    // 않았다 — 앱은 내가 소유한 에이전트만 띄운다(`runnerLauncher.ts::doStartOne`).
    for (const rel of ['docs/operations.md', 'packages/agent/README.md', 'README.md']) {
      const text = read(rel);
      expect(text, `${rel}: 사이드카 실행 경로가 없다`).toContain(RUNNER_SIDECAR_PATH);
      expect(text, `${rel}: PAT 환경변수 안내가 없다`).toContain('MURMUR_PAT');
    }
    const ops = read('docs/operations.md');
    // 상태 표가 산다 — 이 표가 없으면 ②는 "표를 지웠다"로도 통과한다.
    expect(ops).toContain('### 상태 표시가 말하는 것');
    // daemon 이 러너의 부모라는 사실이 적혀 있다(`#431` 2단계). 이것이 빠지면 다음 사람이
    // "앱이 자식으로 띄운다"는 옛 구조로 되돌려도 아무것도 빨개지지 않는다.
    expect(ops).toContain('daemon');
    // 그리고 `PATH` 함정은 **여전히 유효한 안내**다 — 사이드카가 됐어도 하네스 CLI 는
    // 그대로 `PATH` 에서 찾는다. 낡은 것만 지우다 이 절까지 지우면 여기서 빨개진다.
    expect(ops).toContain('로그인 셸의 `PATH`');
  });
});
