// `sync-version.mjs` 의 타입 선언.
//
// **왜 필요한가**: `test/syncVersion.test.ts` 가 그 스크립트의 함수들을 **그대로 import 해서**
// 잰다(`sign-app.d.mts` 와 같은 이유). 함수를 테스트 쪽에 복사하면 재는 대상과 도는 대상이
// 갈려서, 스크립트가 셋 중 하나를 빠뜨리게 되돌아가도 회귀선은 초록으로 남는다.
//
// 스크립트 자체는 `.mjs` 로 남긴다 — 워크플로가 빌드 없이
// `node scripts/sync-version.mjs <버전>` 으로 부르는 것이 그 파일의 계약이다.

/** 세 자리에서 읽은 버전. `undefined` 면 그 파일에서 못 읽었다는 뜻이다. */
export interface Versions {
  tauri: string | undefined;
  cargo: string | undefined;
  lock: string | undefined;
}

/** 정본(`tauri.conf.json`)에 적힌 버전. */
export function readVersion(root?: string): string;

/** 세 자리를 읽어 그대로 돌려준다 — 맞추지 않는다. */
export function readAll(root?: string): Versions;

/** 세 자리가 모두 같은가. 다르면 무엇이 다른지 `found` 에 담아 돌려준다. */
export function checkAll(root?: string): { ok: boolean; found: Versions };

/**
 * 세 자리를 `version` 으로 맞춘다. 형식(`X.Y.Z`)이 아니면 **파일을 건드리기 전에** 던진다.
 * `tauri.conf.json` 은 버전 줄만 바꾼다 — 재직렬화하지 않는다(서식 노이즈 방지).
 */
export function writeAll(version: string, root?: string): string;

/** 정본 파일들의 절대 경로. */
export const TAURI_CONF: string;
export const CARGO_TOML: string;
export const CARGO_LOCK: string;
