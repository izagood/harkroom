// @vitest-environment node
/**
 * 사이드카 번들의 회귀선 — **번들된 CJS 의존이 Node 빌트인을 `require` 할 수 있어야 한다.**
 *
 * `sidecar.mjs` 는 `format: 'esm'` 으로 번들한다. ESM 산출물에는 `require` 가 없으므로,
 * esbuild 는 번들 안으로 끌어들인 CJS 코드의 `require("events")` 를 자기 셔뱅(`__require`)
 * 으로 바꾸고, 그 셔뱅은 스코프에 `require` 가 없으면 **던진다**:
 *
 *     Error: Dynamic require of "events" is not supported
 *
 * 이것이 배포된 러너에서 **relay 를 통째로 죽여 놓았다.** `ws` 는 CJS 이고 로드 시점에
 * `events`·`net`·`tls`·`stream`·`crypto` 를 require 하므로, `nodeWsDialer` 의
 * `await import('ws')` 가 **네트워크에 나가기 전에** 실패했다. 그리고 dialer 가 그 예외를
 * 삼켜(`.catch(() => handlers.onClose())`) 백오프로 영원히 재시도했다 — 러너 로그에도,
 * 서버 로그에도 흔적이 하나도 남지 않았다. 터미널 관찰·입력·이어받기가 함께 죽어 있었다.
 *
 * **`ws` 로 재지 않는다.** 결함은 `ws` 의 것이 아니라 번들 형식의 것이므로, 같은 모양의
 * 최소 픽스처로 잰다 — 그러면 이 회귀선이 `ws` 의 버전·의존 그래프 변화에 흔들리지 않고,
 * 나중에 다른 CJS 의존이 들어와도 같은 함정을 이 자리에서 잡는다.
 *
 * `nodePtyLoader.ts` 가 `createRequire(import.meta.url)` 를 쓰는 것이 같은 함정의 앞선
 * 사례다. 거기서는 한 사례를 우회했고, 이 회귀선이 닫는 것은 그 **부류**다.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// 빌드 스크립트는 순수 JS 지만 선언만 옆에 둔다(`scripts/sidecar.d.mts`) — 이 파일이
// 재는 배선을 `any` 로 두면 파라미터 이름이 바뀌어도 조용히 통과한다.
import { buildSidecar, binariesDir, resolveTarget } from '../scripts/sidecar.mjs';

const NAME = 'builtin-require-probe';
const target = resolveTarget();
const outfile = join(binariesDir, `${NAME}-${target.triple}`);

afterAll(() => {
  // 이 회귀선의 산출물은 배포물이 아니다 — 남기면 `binaries/` 에 정체 모를 실행 파일이
  // 쌓이고, tauri 가 `externalBin` 밖의 파일을 어떻게 다루는지에 기대게 된다.
  if (existsSync(outfile)) rmSync(outfile, { force: true });
});

describe('사이드카 번들 (ESM)', () => {
  it('번들된 CJS 의존이 Node 빌트인을 require 할 수 있다', async () => {
    await buildSidecar({
      name: NAME,
      entry: join(__dirname, 'fixtures', 'cjsRequiresBuiltinEntry.mjs'),
      resolveFrom: __dirname,
      nativeDeps: [],
      target,
    });

    // 실행이 판정이다 — 번들 텍스트를 들여다보면 esbuild 의 셔뱅 이름에 회귀선이 매인다.
    const out = execFileSync(process.execPath, [outfile], { encoding: 'utf-8' });

    expect(out).toContain('BUILTIN_REQUIRE_OK');
  });
});
