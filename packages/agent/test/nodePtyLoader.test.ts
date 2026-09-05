// `node-pty` 를 **위치로 찾는** 로더의 회귀선(`#433` 을 닫은 자리).
//
// 이 로더가 생긴 이유는 배포 번들에서 두 자리가 갈리기 때문이다:
//
//   externalBin        → murmur.app/Contents/MacOS/murmur-runner
//   bundle.resources   → murmur.app/Contents/Resources/node_modules/node-pty
//
// 예전에는 Rust 가 번들 안에 심볼릭 링크를 만들어 이었는데, **`stapler` 가 그 링크를
// 거절한다**(`invalid destination for symbolic link in bundle`) — 공증이 `Accepted` 여도
// 티켓을 못 박으면 배포가 성립하지 않는다. 그래서 링크를 없애고 러너가 직접 해석한다.
//
// 여기서 재는 것은 **경로 결정**이다. 실제 네이티브 로딩(`pty.node`·`spawn-helper`)은
// `pty.test.ts` 와 `main.rs` 의 사이드카 통합 테스트가 실물로 재고, 배포 번들의 두 번째
// 후보는 실물 `.app` 이 있어야 하므로 실물 검증 절차가 맡는다.
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { findNodePtyDir, loadNodePty, nodePtyCandidates } from '../src/nodePtyLoader.js';

/** `<dir>/node_modules/node-pty` 에 `package.json` 만 있는 껍데기를 만든다. */
function placeStub(dir: string, rel: string[]): string {
  const pkgDir = path.join(dir, ...rel, 'node_modules', 'node-pty');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'node-pty' }));
  return pkgDir;
}

describe('node-pty 후보 경로 (#433)', () => {
  /**
   * **두 배치를 모두 안다.** 하나만 알면 다른 쪽에서 러너가 안 뜨고, 그 사실은 배포된
   * 앱에서만(또는 개발 빌드에서만) 드러난다 — 어느 쪽이든 늦다.
   */
  it('개발(사이드카 옆)과 배포(../Resources) 두 자리를 본다', () => {
    const candidates = nodePtyCandidates('/somewhere/Contents/MacOS');
    expect(candidates).toEqual([
      path.join('/somewhere/Contents/MacOS', 'node_modules', 'node-pty'),
      path.join('/somewhere/Contents/MacOS', '..', 'Resources', 'node_modules', 'node-pty'),
    ]);
  });

  /**
   * 개발 빌드 — `build:sidecar` 가 사이드카 옆에 직접 두고, `cargo-tauri` 가 그것을
   * `target/<profile>/` 로 함께 복사한다. 이 자리에서 해석되지 않으면 `pnpm tauri dev` 가
   * 통째로 죽는다.
   */
  it('사이드카 옆에 있으면 그것을 고른다 (개발 빌드)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'murmur-pty-dev-'));
    try {
      const expected = placeStub(root, []);
      expect(findNodePtyDir(root)).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * **배포 번들 — 이것이 링크를 대신하는 자리다.** `Contents/MacOS` 옆에는 아무것도 없고
   * `Contents/Resources` 에만 있다. 예전에는 이 간극을 심볼릭 링크가 메웠다.
   */
  it('Contents/Resources 에만 있으면 그것을 고른다 (배포 번들)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'murmur-pty-bundle-'));
    try {
      const contents = path.join(root, 'Contents');
      const macos = path.join(contents, 'MacOS');
      mkdirSync(macos, { recursive: true });
      placeStub(contents, ['Resources']);

      const hit = findNodePtyDir(macos);
      expect(hit).not.toBeNull();
      // 경로에 `..` 이 남으므로 정규화해서 비교한다 — 재는 것은 "어디를 가리키는가"다.
      expect(path.resolve(hit as string)).toBe(
        path.resolve(contents, 'Resources', 'node_modules', 'node-pty'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * **디렉터리만 있고 `package.json` 이 없으면 고르지 않는다.** 옛 빌드가 남긴 빈 껍데기나
   * 실패한 복사를 집으면 `createRequire` 가 훨씬 뒤에서 알아보기 어려운 이유로 죽는다.
   */
  it('package.json 이 없는 빈 디렉터리는 고르지 않는다', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'murmur-pty-empty-'));
    try {
      mkdirSync(path.join(root, 'node_modules', 'node-pty'), { recursive: true });
      expect(findNodePtyDir(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * **후보가 비면 Node 의 통상 해석으로 물러난다.** 이 모듈은 번들된 사이드카에서만이
   * 아니라 소스에서 그대로도 돈다(`vitest`, `pnpm start` 의 `tsx`) — 그때 `node-pty` 는
   * 워크스페이스의 평범한 의존이고, 후보 두 자리에는 없는 것이 정상이다.
   *
   * 이 갈래가 없으면 `pty.test.ts` 전체가 죽는다(실제로 죽었다 — 구현 중 실측).
   *
   * **번들에서는 이 갈래가 서지 않는다**: esbuild 가 `node-pty` 를 external 로 두므로
   * `createRequire` 의 걷기가 번들 파일 위치에서 시작하는데, 배포 번들의
   * `Contents/MacOS` 위로는 `node_modules` 가 없다. 그래서 배치가 실제로 틀어지면
   * 이 폴백이 그것을 덮지 못하고 아래 테스트의 오류가 그대로 난다.
   */
  it('후보가 비어도 워크스페이스 의존으로 해석된다 (소스에서 돌 때)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'murmur-pty-fallback-'));
    try {
      // 후보 두 자리는 비어 있다 — 그래도 통상 해석이 워크스페이스의 node-pty 를 집는다.
      expect(findNodePtyDir(root)).toBeNull();
      expect(typeof loadNodePty(root).spawn).toBe('function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * 어느 방법으로도 못 찾으면 **어디를 봤는지 적어서** 던진다. 이 실패는 배포 배치가
   * 틀어졌을 때만 나는데, 그때 "못 찾았다"만 있으면 어느 자리를 고쳐야 할지 알 수 없다.
   *
   * 여기서는 통상 해석까지 막아야 그 갈래에 닿는다 — `createRequire` 가 이 파일 위치에서
   * 걷기 때문에 워크스페이스 안에서는 항상 성공한다. 그래서 **오류 메시지를 만드는 쪽만**
   * 직접 잰다(`nodePtyCandidates` 가 그 본문이다).
   */
  it('못 찾았을 때의 메시지가 본 자리를 전부 적는다', () => {
    const candidates = nodePtyCandidates('/nowhere/Contents/MacOS');
    expect(candidates.some((c) => c.includes('Resources'))).toBe(true);
    expect(candidates.some((c) => c.includes('node_modules'))).toBe(true);
  });
});

describe('실물 node-pty 해석 (#433)', () => {
  /**
   * **실물로 해석해 본다.** 껍데기 `package.json` 으로 경로 결정만 재면 "찾기는 하는데
   * 못 부르는" 상태를 통과시킨다 — `node-pty` 는 CommonJS 이고 그 안에서 네이티브
   * 애드온을 자기 파일 기준 상대 경로로 다시 찾으므로, `createRequire` 로 실제로 불러야
   * 그 연쇄가 성립하는지 안다.
   *
   * 이 패키지의 `node_modules` 를 사이드카 자리로 삼는다 — 러너의 배포 배치와 같은
   * 모양(패키지가 `<기준>/node_modules/node-pty` 에 있다)이다.
   */
  it('createRequire 로 실제 node-pty 를 부른다', () => {
    const base = path.resolve(__dirname, '..');
    if (findNodePtyDir(base) === null) {
      console.warn(`건너뜀: ${base} 에 node-pty 가 없다 — \`pnpm install\` 을 돌려라`);
      return;
    }
    const pty = loadNodePty(base);
    // `spawn` 이 있어야 러너가 쓸 수 있다. 실제 PTY 를 여는 것은 `pty.test.ts` 의 일이다.
    expect(typeof pty.spawn).toBe('function');
  });
});
