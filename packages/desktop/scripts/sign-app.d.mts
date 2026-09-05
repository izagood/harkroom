// `sign-app.mjs` 의 타입 선언.
//
// **왜 필요한가**: `test/bundleSignable.test.ts` 가 그 스크립트의 `isMachO`·
// `machOFilesDeepestFirst` 를 **그대로 import 해서** 잰다. 함수를 테스트 쪽에 복사하면
// 재는 대상과 도는 대상이 갈리고, 그러면 스크립트를 확장자 기반 탐지로 되돌려도
// 회귀선은 초록으로 남는다 — 되돌려 RED 가 서려면 같은 함수여야 한다.
//
// 스크립트 자체는 `.mjs` 로 남긴다(빌드 없이 `node scripts/sign-app.mjs` 로 도는 것이
// 그 파일의 계약이다). 그래서 타입만 여기 따로 둔다.

/**
 * 이 파일이 Mach-O 인가. **내용으로 판정한다**(`file -b -h`) — 확장자·이름을 보지 않는다.
 * 심볼릭 링크는 따라가지 않는다.
 */
export function isMachO(path: string): boolean;

/**
 * 디렉터리 아래의 모든 Mach-O 를 **깊이 내림차순**으로 돌려준다. 안쪽부터 서명해야
 * 바깥 서명이 깨지지 않는다. 심볼릭 링크는 목록에 넣지도, 내려가지도 않는다.
 */
export function machOFilesDeepestFirst(root: string): string[];
