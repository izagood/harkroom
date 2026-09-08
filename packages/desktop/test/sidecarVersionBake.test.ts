// @vitest-environment node
// (`sidecar.mjs` 는 로드 시점에 esbuild 를 import 한다 — jsdom 에서는 그것이 깨진다.
//  이 파일이 재는 것은 빌드 스크립트의 배선이지 DOM 이 아니다.)
/**
 * 러너 사이드카에 **자기 버전이 구워지는지**의 회귀선.
 *
 * ## 왜 이 회귀선이 필요한가
 *
 * 러너 버전이 화면에 뜨는 길은 러너가 그 값을 **가지고 있어야** 시작된다. 앞서는 그 값이
 * spawn env(`AGENT_VERSION`) 하나에만 걸려 있었고, 앱 밖에서 뜬 러너는 아무도 심어 주지
 * 않아 영원히 `unknown` 이었다. 이제 번들 시점에 굽는다.
 *
 * 그런데 이 배선은 **깨져도 조용하다**: esbuild `define` 의 키가 소스의 식별자와 다르면
 * 치환이 그냥 안 일어나고, 읽는 쪽은 `typeof` 로만 만지므로 없는 값으로 떨어진다. 빌드도
 * 성공하고 앱도 뜬다 — 화면의 버전만 다시 "모름"이 된다. 이름이 어긋나는 것을 여기서 잡는다.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { appVersion, binariesDir, buildSidecar, resolveTarget, runnerDefines } from '../scripts/sidecar.mjs';

const repoRoot = path.resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

/** 아래 실행 테스트가 만드는 픽스처 산출물. 배포물이 아니므로 끝나면 지운다. */
const FIXTURE = 'baked-version-probe';
const target = resolveTarget();
const fixtureOut = path.join(binariesDir, `${FIXTURE}-${target.triple}`);

afterAll(() => {
  if (existsSync(fixtureOut)) rmSync(fixtureOut, { force: true });
});

describe('러너 사이드카에 버전을 굽는다', () => {
  it('구울 값은 `tauri.conf.json` 의 버전이다 — 앱이 심는 값과 같은 출처여야 한다', () => {
    const conf = JSON.parse(read('packages/desktop/src-tauri/tauri.conf.json')) as { version: string };
    expect(appVersion()).toBe(conf.version);
    // `packages/desktop/package.json` 은 언제나 `0.0.0` 이다. 그것을 읽으면 구운 값과
    // 앱이 `package_info()` 로 심는 값이 갈리고, 뒤처짐 판정이 방금 띄운 러너를
    // 뒤처졌다고 말한다.
    expect(appVersion()).not.toBe('0.0.0');
  });

  it('`define` 의 키가 `version.ts` 가 읽는 식별자와 같다 — 어긋나면 조용히 unknown 이 된다', () => {
    const keys = Object.keys(runnerDefines('0.1.80'));
    expect(keys).toEqual(['__AGENT_VERSION__']);
    // 소스가 실제로 그 이름을 읽는지 본다. 상수를 서로 비교하면 둘이 함께 움직여 초록이
    // 된다 — 한쪽은 **읽는 쪽 소스**여야 한다.
    const versionTs = read('packages/agent/src/version.ts');
    for (const key of keys) {
      expect(versionTs, `version.ts 가 ${key} 를 읽지 않는다`).toContain(key);
    }
  });

  it('값은 JSON 문자열 리터럴이다 — 날 것으로 넣으면 식별자로 치환된다', () => {
    // esbuild `define` 은 값을 **JS 표현식**으로 끼워 넣는다. `'0.1.80'` 을 그대로 주면
    // 숫자 표현식이 되고, 브랜치명 같은 값은 선언되지 않은 식별자가 되어 러너가 로드
    // 시점에 죽는다.
    expect(runnerDefines('0.1.80').__AGENT_VERSION__).toBe('"0.1.80"');
  });

  it('러너 빌드에만 `define` 을 준다 — daemon 은 자기 버전을 보고하지 않는다', () => {
    const script = read('packages/desktop/scripts/build-sidecars.mjs');
    // 러너 블록에만 있어야 한다. `murmur-daemon` 이후 구간에 나타나면 daemon 번들에도
    // 굽는 것이고, 그것은 아무도 읽지 않는 값이다.
    const daemonAt = script.indexOf("name: 'murmur-daemon'");
    const defineAt = script.indexOf('runnerDefines(');
    expect(defineAt).toBeGreaterThan(-1);
    expect(defineAt).toBeLessThan(daemonAt);
    expect(script.slice(daemonAt)).not.toContain('define:');
  });

  /**
   * **치환이 실제로 일어나는지는 실행으로 잰다.** 위 단언들은 이름과 배선을 재지만, 그
   * 이름이 esbuild 를 통과해 값이 되는지는 재지 않는다 — 그 사이에 `define` 파라미터가
   * `buildSidecar` 에서 빠지는 것 같은 일이 있으면 전부 초록인 채로 러너만 `unknown` 이
   * 된다(그것이 이 이슈의 모양이었다).
   *
   * 러너 전체가 아니라 최소 픽스처로 잰다 — `sidecarBundle.test.ts` 와 같은 이유다.
   */
  it('번들에 구운 값이 실행 시점에 읽힌다 — 픽스처를 실제로 빌드해서 돌린다', async () => {
    await buildSidecar({
      name: FIXTURE,
      entry: path.join(__dirname, 'fixtures', 'bakedVersionEntry.mjs'),
      resolveFrom: __dirname,
      nativeDeps: [],
      define: runnerDefines('9.9.9-test'),
      target,
    });

    const out = execFileSync(process.execPath, [fixtureOut], {
      encoding: 'utf-8',
      // env 가 있으면 그쪽이 이긴다 — 여기서 재는 것은 **구운 값**이므로 비운다.
      env: { ...process.env, AGENT_VERSION: undefined } as NodeJS.ProcessEnv,
    });
    expect(out).toContain('BAKED:9.9.9-test');
  });
});