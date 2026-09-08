/**
 * `sidecar.mjs` 의 타입 선언.
 *
 * 빌드 스크립트는 JS 로 둔다(빌드를 위해 빌드를 요구하지 않는다). 그런데 그 배선을 재는
 * 테스트는 TS 이고, `tsconfig` 에 `allowJs` 가 없으므로 import 가 `any` 로 떨어지며
 * `noImplicitAny` 에 걸린다. 이 파일이 그 한 칸을 메운다 — **선언만** 두고 구현은 그대로
 * `.mjs` 에 있다.
 */

export declare const desktopRoot: string;
export declare const repoRoot: string;
export declare const binariesDir: string;

/** 이 번들이 나오는 앱의 버전(`src-tauri/tauri.conf.json` 의 `version`). */
export declare function appVersion(): string;

/** 러너 번들에 구울 값들(esbuild `define`). 키는 `version.ts` 의 식별자와 같아야 한다. */
export declare function runnerDefines(version: string): Record<string, string>;

export declare function resolveTarget(): { triple: string; platform: string; arch: string };

export declare function buildSidecar(opts: {
  name: string;
  entry: string;
  resolveFrom: string;
  nativeDeps?: string[];
  target: { triple: string; platform: string; arch: string };
  define?: Record<string, string>;
}): Promise<{ outfile: string }>;
