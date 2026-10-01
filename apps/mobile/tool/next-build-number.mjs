#!/usr/bin/env node
// App Store Connect 에 올라간 최대 빌드 번호 + 1 을 stdout 에 출력한다.
//
// `github.run_number` 를 쓰지 않는 이유: 워크플로별 카운터라 워크플로를 새로 만들면 1 부터
// 시작하고, 이미 올라간 번호와 겹치면 업로드가 거부된다. 로컬 릴리스와 CI 가 각자 카운터를
// 들면 언젠가 반드시 부딪히므로, **유일한 진실인 App Store Connect 를 직접 조회한다.**
//
// **App Store Connect 만으로는 모자라다**(2026-10-02): 방금 올린 빌드는 처리가 시작될 때까지
// `/v1/builds` 목록에 안 잡힌다 — 실측으로 업로드 11분 뒤에도 안 보였다. 그 사이 다음 머지가
// 같은 번호를 골라 altool 이 "bundle version must be higher than … '9'" 로 거부했다(두 번 연속).
// 그래서 CI 는 바닥값을 함께 준다: `BUILD_NUMBER_FROM_RUN=1` 이면 이 워크플로의 실행 번호로
// `run_number × 10 + run_attempt` 를 만들고, 결과는 max(ASC 최대값 + 1, 바닥값) 이다.
// 실행 번호는 늘기만 하고(실패한 실행도 소비한다) 다시 돌리기(attempt)도 번호를 올린다.
// 로컬 릴리스는 바닥값 없이 지금처럼 ASC 만 본다 — 로컬은 몰아서 연달아 올리지 않는다.
//
// 비밀값은 인자로 받지 않는다(프로세스 목록·셸 기록에 남는다). 환경 변수와 키 **파일 경로**로만 받고,
// 아무것도 출력하지 않는다 — stdout 은 번호 한 줄이다.
//
// 사용법:
//   ASC_KEY_ID=... ASC_ISSUER_ID=... ASC_PRIVATE_KEY_PATH=... ASC_APP_ID=... \
//     node apps/mobile/tool/next-build-number.mjs

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 다음 빌드 번호. [ascVersions] 는 App Store Connect 가 준 빌드 번호 문자열들, [env] 는 바닥값을
 * 정하는 환경 변수다. 순수 함수로 둔다 — 네트워크 없이 시험할 수 있게.
 */
export function nextBuildNumber(ascVersions, env = {}) {
  // 빌드 번호는 문자열로 오고 정렬도 문자열 기준이라 "10" < "9" 가 된다. 정수로 바꿔 최대값을 구한다.
  const numbers = ascVersions.map((v) => Number.parseInt(v, 10)).filter(Number.isInteger);
  const fromAsc = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
  return Math.max(fromAsc, buildNumberFloor(env));
}

/** CI 바닥값. 켜지 않았거나 값이 이상하면 0(바닥 없음). */
export function buildNumberFloor(env) {
  if (env.BUILD_NUMBER_FROM_RUN !== '1') return 0;
  const run = Number.parseInt(env.GITHUB_RUN_NUMBER ?? '', 10);
  const attempt = Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? '1', 10);
  if (!Number.isInteger(run) || run < 1 || !Number.isInteger(attempt) || attempt < 1 || attempt > 9) return 0;
  return run * 10 + attempt;
}

// 시험이 import 할 때는 아래(조회·출력)를 돌리지 않는다.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();

async function main() {
  const appId = process.env.ASC_APP_ID;
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const keyPath = process.env.ASC_PRIVATE_KEY_PATH;

  if (!appId || !keyId || !issuerId || !keyPath) {
    console.error('필요: ASC_APP_ID / ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY_PATH 환경 변수');
    process.exit(2);
  }

  const b64url = (buf) => Buffer.from(buf).toString('base64url').replace(/=+$/, '');

  /**
   * App Store Connect 는 ES256 으로 서명한 JWT 를 요구한다. Node 의 sign 은 DER 을 내놓지만
   * JWS 는 raw r||s 를 요구하므로 dsaEncoding 으로 직접 지정한다.
   */
  function makeToken() {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }),
    );
    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    const signature = signer.sign({ key: readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' });
    return `${header}.${payload}.${b64url(signature)}`;
  }

  const url = new URL('https://api.appstoreconnect.apple.com/v1/builds');
  url.searchParams.set('filter[app]', appId);
  url.searchParams.set('sort', '-version');
  url.searchParams.set('limit', '200');

  const response = await fetch(url, { headers: { Authorization: `Bearer ${makeToken()}` } });
  if (!response.ok) {
    // 응답 본문은 싣지 않는다 — 오류 본문에 요청 정보가 되비칠 수 있고, 이 줄은 CI 로그에 남는다.
    console.error(`App Store Connect 조회 실패: HTTP ${response.status}`);
    process.exit(1);
  }

  const { data } = await response.json();
  console.log(nextBuildNumber((data ?? []).map((build) => build.attributes.version), process.env));
}
