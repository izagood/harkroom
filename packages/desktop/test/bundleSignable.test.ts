// 번들이 **서명·공증을 통과할 수 있는 상태**인지를 고정하는 회귀선.
//
// 이 파일이 닫는 것은 두 결함이고, 둘 다 같은 목적(배포되는 `.app` 을 만드는 것)을 막았다.
// 실측으로 겪은 그대로 적는다:
//
//   1차 공증 제출 → status: Invalid
//                   The binary is not signed. (…/node-pty/prebuilds/darwin-arm64/pty.node)
//                   The binary is not signed. (…/node-pty/prebuilds/darwin-arm64/spawn-helper)
//                   ← `codesign --deep` 이 `Contents/Resources` 안의 Mach-O 를 건너뛴다
//
//   2차 공증 제출 → status: Accepted        ← 공증 자체는 통과했다
//                 → xcrun stapler staple  → rejected
//                     (invalid destination for symbolic link in bundle)
//                   ← `#433` 이 만들던 `Contents/MacOS/node_modules` 링크
//
// **단위 테스트로는 이 작업을 검증할 수 없다** — 진짜 증거는 실제 서명·공증이다. 그래서 이
// 파일이 하는 일은 좁다: **한 번 고친 성질이 조용히 되돌아가지 않게 붙잡는 것**뿐이다.
// 그 성질을 되돌리면 다시 몇 분짜리 공증 왕복 끝에야 알게 되고, 그때는 원인이 멀어져 있다.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isMachO, machOFilesDeepestFirst } from '../scripts/sign-app.mjs';

const DESKTOP_DIR = path.resolve(__dirname, '..');
const APP = path.join(
  DESKTOP_DIR,
  'src-tauri', 'target', 'release', 'bundle', 'macos', 'murmur.app',
);
const SIGN_SCRIPT = path.join(DESKTOP_DIR, 'scripts', 'sign-app.mjs');
const MAIN_RS = path.join(DESKTOP_DIR, 'src-tauri', 'src', 'main.rs');
const ENTITLEMENTS = path.join(DESKTOP_DIR, 'src-tauri', 'entitlements.plist');

const BUILD_HINT =
  '먼저 `pnpm --filter @murmur/desktop build:sidecar` 와 ' +
  '`cd packages/desktop && npx tauri build --bundles app` 을 돌려라';

/** 디렉터리 아래 **모든** 심볼릭 링크(링크를 따라가지 않는다). */
function symlinksUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isSymbolicLink()) {
        out.push(p);
        continue; // 링크는 내려가지 않는다 — 밖으로 새면 이 검사가 무의미해진다.
      }
      if (name.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

describe('번들에 심볼릭 링크가 없다 (#433 — `staple` 이 그것을 거절한다)', () => {
  /**
   * **이 성질 자체를 고정한다.** 누가 링크를 다시 만들면 여기서 RED 다.
   *
   * 왜 "node_modules 링크가 없다"가 아니라 "링크가 하나도 없다"인가: `stapler` 가 거절한
   * 것은 링크의 **목적지**이지 이름이 아니다(`invalid destination for symbolic link in
   * bundle`). 이름을 하나 찍어 두면 다른 이름으로 같은 결함이 다시 들어올 수 있고, 그때
   * 이 회귀선은 초록으로 남는다. 지금 이 번들은 링크가 **0개**인 것이 맞는 상태이므로,
   * 그 강한 성질을 그대로 잰다.
   *
   * **다만 이 검사만 믿지 마라.** 옛 링크는 빌드 산출물이 아니라 앱이 러너를 처음 띄울 때
   * 생겼다 — 갓 빌드한 번들은 수정 전에도 0개다. 실행 시점과 무관하게 서는 것은 아래의
   * 소스 검사이고, 이 검사는 "실물 번들에도 정말 없다"를 더해 줄 뿐이다.
   */
  it('빌드된 .app 안에 심볼릭 링크가 하나도 없다', () => {
    if (!existsSync(APP)) {
      console.warn(`건너뜀: ${APP} 이 없다 — ${BUILD_HINT}`);
      return;
    }
    const links = symlinksUnder(APP);
    expect(links, `번들 안 심볼릭 링크:\n${links.join('\n')}`).toEqual([]);
  });

  /**
   * **이 검사가 둘 중 더 강하다.** 위 테스트만으로는 부족한 이유가 둘이다:
   *
   * 1. `.app` 이 있어야만 잰다 — 번들 없이 도는 자리(CI 유닛 잡, 빌드 전 로컬)에서는
   *    링크를 다시 만드는 변경이 그대로 통과한다.
   * 2. **더 중요한 것**: 옛 링크는 빌드 산출물에 없었다. `ensure_node_pty_alongside_sidecar`
   *    는 `daemon_spawn_runner` 안에서만 불렸으므로 **앱이 러너를 처음 띄울 때** 생겼다.
   *    즉 러너를 안 띄우고 번들을 세면 **수정 전에도 0개**라, 위 검사는 갓 빌드한 번들에
   *    대고는 아무것도 증명하지 못한다.
   *
   * 그래서 링크를 만들던 **코드가 돌아왔는지**를 소스에서 본다. 이쪽은 실행 시점과
   * 무관하게 성립한다.
   */
  it('main.rs 가 번들 안에 심볼릭 링크를 만들지 않는다', () => {
    const source = readFileSync(MAIN_RS, 'utf8');
    // `#[cfg(windows)]` 갈래의 복사도 함께 사라졌으므로 `symlink` 호출 자체가 없어야 한다.
    expect(source, '`main.rs` 가 다시 심볼릭 링크를 만들면 `staple` 이 거절한다')
      .not.toMatch(/fs::symlink\s*\(/);
    expect(source, '`ensure_node_pty_alongside_sidecar` 는 `#433` 예고대로 걷어냈다')
      .not.toContain('fn ensure_node_pty_alongside_sidecar');
  });
});

describe('Mach-O 를 내용으로 찾는다 (`--deep` 이 놓친 것)', () => {
  /**
   * **확장자가 없는 Mach-O 를 만들어 잰다.** 이것이 이 회귀선의 핵심이다.
   *
   * 예전 스크립트는 `-name '*.node' -o -name spawn-helper` 로 찾았다 — 이름 기반이다.
   * 그 방식으로 되돌리면 아래 파일(`spawn-helper` 도 아니고 `.node` 도 아닌 이름)은
   * 목록에서 빠지고, 그러면 이 테스트가 RED 다.
   *
   * 실물 Mach-O 를 쓴다 — 가짜 매직 넘버를 손으로 적으면 `file` 이 무엇이라 부를지가
   * 이 테스트의 가정이 되고, 그 가정은 `file` 이 바뀌면 조용히 틀어진다. 시스템에 반드시
   * 있는 `/bin/sh` 를 이름만 바꿔 복사한다.
   */
  it('확장자가 없는 이름의 Mach-O 도 찾는다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'murmur-macho-'));
    try {
      // 확장자도 없고, 옛 이름 목록(`*.node`·`spawn-helper`)에도 안 걸리는 이름.
      const disguised = path.join(dir, 'totally-unrelated-name');
      writeFileSync(disguised, readFileSync('/bin/sh'));
      chmodSync(disguised, 0o755);

      expect(isMachO(disguised), '내용으로 보면 이것은 Mach-O 다').toBe(true);
      expect(machOFilesDeepestFirst(dir)).toContain(disguised);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 대조군 — **Mach-O 가 아닌 것은 안 잡아야 한다.** 이것이 없으면 위 테스트는
   * "전부 다 Mach-O 라고 답하는" 구현으로도 통과한다.
   *
   * 사이드카(`murmur-runner`·`murmur-daemon`)가 정확히 이 경우다: 셔뱅 스크립트라
   * Mach-O 가 아니고, 서명 대상이 아닌 것이 맞다.
   */
  it('셔뱅 스크립트는 Mach-O 가 아니다 (사이드카가 이 경우다)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'murmur-macho-'));
    try {
      const script = path.join(dir, 'murmur-runner');
      writeFileSync(script, '#!/usr/bin/env node\nconsole.log("hi");\n');
      chmodSync(script, 0o755);

      expect(isMachO(script)).toBe(false);
      expect(machOFilesDeepestFirst(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **심볼릭 링크를 따라가지 않는다.** 따라가면 번들 **밖**의 파일을 서명하려 들고,
   * 그것은 남의 파일을 건드리는 것이다. 링크가 있으면 안 되는 것이 이 작업의 다른
   * 절반이지만, 있더라도 밖으로 새지는 않아야 한다.
   */
  it('심볼릭 링크는 목록에 넣지 않는다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'murmur-macho-'));
    try {
      const link = path.join(dir, 'linked-binary');
      symlinkSync('/bin/sh', link);
      expect(machOFilesDeepestFirst(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **깊이 내림차순** — 안쪽이 먼저 나와야 한다. 순서가 뒤집히면 바깥을 먼저 서명하게
   * 되고, 안쪽을 서명하는 순간 그 바깥 서명이 깨진다
   * (`a sealed resource is missing or invalid`). 순서가 곧 정확성이다.
   */
  it('깊은 것이 먼저 나온다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'murmur-macho-'));
    try {
      const shallow = path.join(dir, 'outer');
      const deepDir = path.join(dir, 'a', 'b', 'c');
      execFileSync('mkdir', ['-p', deepDir]);
      const deep = path.join(deepDir, 'inner');
      const sh = readFileSync('/bin/sh');
      writeFileSync(shallow, sh);
      writeFileSync(deep, sh);

      expect(machOFilesDeepestFirst(dir)).toEqual([deep, shallow]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('바깥 .app 에 `--deep` 을 쓰지 않는다', () => {
  /**
   * **성질을 소스에서 고정한다.** Apple DTS(Quinn, 포럼 129980): `--deep` 은 앱의
   * entitlements 를 nested code 에 적용해 "trusted execution system 이 프로그램을 막을 수
   * 있다". 그리고 macOS 13 부터 서명 용도로 deprecated 다.
   *
   * 실행 결과로 재기 어려운 성질이다 — `--deep` 을 붙여도 서명 자체는 성공하고, 그 대가는
   * 공증 거절이나 실행 차단으로 훨씬 뒤에 온다. 그래서 **인자 목록을 직접 본다.**
   * 주석에는 `--deep` 이 여러 번 나오므로(왜 안 쓰는지를 길게 적었다) 주석을 걷어내고 잰다.
   */
  it('sign-app.mjs 의 codesign 호출 어디에도 `--deep` 이 없다', () => {
    const source = readFileSync(SIGN_SCRIPT, 'utf8');
    const codeOnly = source
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    expect(codeOnly, "`--deep` 은 nested code site 만 본다 — `Contents/Resources` 를 놓친다")
      .not.toContain("'--deep'");
  });

  /**
   * 대조군 — 스크립트가 **여전히 codesign 을 부른다.** 위 검사만 있으면 `codesign` 호출을
   * 통째로 지운 스크립트도 통과한다.
   */
  it('그래도 codesign 은 부른다 (대조군)', () => {
    const source = readFileSync(SIGN_SCRIPT, 'utf8');
    expect(source).toContain("execFileSync('codesign'");
  });
});

describe('entitlements — 본체에만, 필요한 것만', () => {
  /**
   * **`plutil -lint` 로 실제로 검증한다.** 바이너리 plist 나 BOM 이 있으면 공증이
   * `Embedded entitlements are invalid` 로 거절하고, macOS 10.15.4+ 에서는 아예 실행되지
   * 않는다. 문자열로 XML 을 흉내내 재면 그 두 결함을 못 잡는다 — `plutil` 이 정본이다.
   */
  it('유효한 plist 다', () => {
    expect(existsSync(ENTITLEMENTS), `${ENTITLEMENTS} 가 있어야 한다`).toBe(true);
    // 실패하면 던진다 — 그 자체가 이 테스트의 판정이다.
    execFileSync('plutil', ['-lint', ENTITLEMENTS]);
  });

  /**
   * **BOM 이 없어야 한다.** `plutil -lint` 는 BOM 이 있어도 통과시키지만 `codesign` 은
   * 그것을 싫어한다. 첫 바이트를 직접 본다.
   */
  it('BOM 이 없는 ASCII XML 이다', () => {
    const raw = readFileSync(ENTITLEMENTS);
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'BOM 이 있으면 안 된다')
      .toBe(false);
    expect(raw.subarray(0, 5).toString('utf8')).toBe('<?xml');
  });

  /**
   * **`get-task-allow` 가 있으면 공증이 그대로 거절한다**("The executable requests the
   * com.apple.security.get-task-allow entitlement"). 디버깅용 값이고 배포본에 있으면
   * 다른 프로세스가 이 앱에 코드를 주입할 수 있다. 실수로 들어오는 일이 잦아서 못박는다.
   */
  it('get-task-allow 가 없다 (있으면 공증이 거절한다)', () => {
    const source = readFileSync(ENTITLEMENTS, 'utf8');
    // **주석이 아니라 선언을 본다.** 이 파일은 "왜 안 넣는지"를 주석으로 길게 적으므로
    // 문자열 존재만 보면 그 설명 자체에 걸린다(실제로 걸렸다). `<key>` 로 감싼 형태를 잰다.
    expect(source).not.toMatch(/<key>\s*com\.apple\.security\.get-task-allow\s*<\/key>/);
  });

  /**
   * **`allow-unsigned-executable-memory` 를 넣지 않는다** — `allow-jit` 의 상위집합이라
   * 공격 표면만 넓힌다. JavaScriptCore 는 `MAP_JIT` 를 쓰므로 `allow-jit` 으로 충분하다.
   */
  it('allow-unsigned-executable-memory 가 없다 (allow-jit 으로 충분하다)', () => {
    const source = readFileSync(ENTITLEMENTS, 'utf8');
    // 주석에서 "왜 안 넣는지"를 설명하므로 **키로 선언됐는지**를 본다.
    expect(source).not.toMatch(
      /<key>\s*com\.apple\.security\.cs\.allow-unsigned-executable-memory\s*<\/key>/,
    );
  });

  /**
   * 대조군 — **`allow-jit` 은 실제로 있어야 한다.** 위의 "없다" 검사들만 있으면 빈 plist 도
   * 전부 통과한다. 이 앱의 UI 는 WKWebView(JavaScriptCore = JIT) 안에서 돌고, hardened
   * runtime 이 그것을 막으므로 이 키가 필요하다.
   */
  it('allow-jit 이 선언돼 있다 (대조군 — 웹뷰가 JIT 를 쓴다)', () => {
    const source = readFileSync(ENTITLEMENTS, 'utf8');
    expect(source).toMatch(/<key>\s*com\.apple\.security\.cs\.allow-jit\s*<\/key>\s*<true\s*\/>/);
  });

  /**
   * **본체 서명에만 붙는다.** 안쪽 Mach-O 를 도는 루프가 `--entitlements` 를 쓰면 nested
   * code 가 앱의 권한을 물려받고, 그것이 Quinn 이 경고한 `--deep` 의 부작용과 같은 결과다.
   */
  it('sign-app.mjs 가 본체 서명에만 --entitlements 를 붙인다', () => {
    const source = readFileSync(SIGN_SCRIPT, 'utf8');
    // 본체 서명 호출에는 있다.
    expect(source).toMatch(/'--identifier',\s*IDENTIFIER,\s*\.\.\.entitlements/);
    // 안쪽 루프의 서명 호출에는 없다.
    const nestedCall = source.match(/for \(const path of nested\)[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(nestedCall, '안쪽 Mach-O 에는 entitlements 를 붙이지 않는다')
      .not.toContain('entitlements');
  });
});
