// **앱이 새 서버 표면에 기대면, 그 PR 에서 호환 하한을 정해야 한다** — 잊을 수 없게.
//
// `MIN_SERVER_VERSION`(shared/src/compat.ts)은 손으로 올린다. 자동으로 따라 오르면 "늘 켜진
// 경고"가 되기 때문이다(#756). 그런데 그 규칙에 장치가 없어서 하한이 #756 뒤로 한 번도 안
// 올랐다 — 그 사이 앱은 `POST /accounts/agents/:id/restart`(v0.3.14) 같은 표면에 새로
// 기댔고, 서버 v0.3.9 앞에서 [재시작]이 404 로 죽는데도 화면은 "요구 버전은 넘는다"고 말했다.
//
// 이 파일은 판단을 대신하지 않는다. **판단할 순간을 PR 로 끌어온다:**
//   1. `api.ts` 가 부르는 표면은 전부 `serverSurface.json` 에 있다 — 새 표면이면 빨개진다.
//      그 자리에서 `since`(그 라우트가 **서버에** 처음 들어간 릴리스)를 적는다.
//   2. 하한은 `since` 의 최댓값보다 낮을 수 없다 — 적어 놓고 안 올리면 빨개진다.
//   3. 더는 안 부르는 표면은 json 에서도 지운다 — 남으면 하한을 근거 없이 붙잡는다.
//
// **못 잡는 것:** 있던 라우트에 필드를 더하는 것(#797 `PATCH /channels/:id` 의 `name` —
// 낡은 서버는 zod strip 으로 조용한 200 을 준다). 그건 여전히 PR 작성자 몫이다.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { MIN_SERVER_VERSION, compareRelease } from '@harkroom/shared';
import { extractServerSurface } from './serverSurface';

const API_TS = path.resolve(__dirname, '../src/lib/api.ts');
const surface = JSON.parse(
  readFileSync(path.resolve(__dirname, 'serverSurface.json'), 'utf8'),
) as Record<string, string>;
const called = extractServerSurface(readFileSync(API_TS, 'utf8'));

describe('서버 표면 ↔ 호환 하한', () => {
  it('뽑기가 실제로 무언가를 뽑는다 (정규식이 조용히 0 개가 되지 않게)', () => {
    expect(called.length).toBeGreaterThan(50);
    expect(called).toContain('GET /healthz');
    expect(called).toContain('POST /accounts/agents/:p/restart');
  });

  it('api.ts 가 부르는 표면은 전부 serverSurface.json 에 있다', () => {
    const missing = called.filter((e) => !(e in surface));
    expect(
      missing,
      '새 서버 표면이다. test/serverSurface.json 에 "그 라우트가 서버에 들어간 릴리스"를 since 로 적고,\n'
      + '그 값이 MIN_SERVER_VERSION 보다 높으면 packages/shared/src/compat.ts 의 하한과 표를 함께 올려라.',
    ).toEqual([]);
  });

  it('json 에만 남은 표면은 없다', () => {
    const stale = Object.keys(surface).filter((e) => !called.includes(e));
    expect(stale, '더는 부르지 않는 표면이다 — serverSurface.json 에서 지워라').toEqual([]);
  });

  it('since 는 전부 X.Y.Z 다', () => {
    const bad = Object.entries(surface).filter(([, v]) => compareRelease(v, v) === null);
    expect(bad).toEqual([]);
  });

  it('MIN_SERVER_VERSION 은 since 의 최댓값보다 낮지 않다', () => {
    const [top, needs] = Object.entries(surface)
      .map(([e, v]) => [v, e] as const)
      .reduce((a, b) => (compareRelease(b[0], a[0])! > 0 ? b : a));
    expect(
      compareRelease(MIN_SERVER_VERSION, top)! >= 0,
      `${needs} 는 서버 v${top} 이상이 있어야 돈다 — MIN_SERVER_VERSION(${MIN_SERVER_VERSION})을 올려라`,
    ).toBe(true);
  });
});
