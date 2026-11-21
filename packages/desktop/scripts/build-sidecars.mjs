#!/usr/bin/env node
// 앱과 함께 배포되는 사이드카를 **전부** 만든다. 둘 다 Rust(Mach-O)다 — Node 사이드카는 없다.
//
// - `harkroom-operator-rs` — 오퍼레이터(`crates/harkroom-operator`). 앱이 띄우는 오퍼레이터는 이것 하나다.
// - `harkroom-runner-rs` — 러너(`crates/harkroom-runner`). 오퍼레이터가 자기 옆의 이 파일을 에이전트마다 띄운다.
//
// Node 러너(`harkroom-runner` + `node-pty`)는 번들에서 뺐다 — 앱의 턴은 전부 Rust 러너로 돈다.
// `sign-app.mjs` 가 내용으로 Mach-O 를 찾아 서명하므로 서명 쪽은 손대지 않는다.
//
// `binaries/` 는 빌드마다 통째로 비운다(옛 triple 산출물이 남으면 배포에 섞인다) — 비우는 것은 여기 한 번이다.
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { binariesDir, repoRoot, resolveTarget } from './sidecarTarget.mjs';

async function main() {
  const target = resolveTarget();
  // 옛 산출물을 통째로 걷어낸다(위 주석 — 이 자리가 유일한 청소 지점이다).
  rmSync(binariesDir, { recursive: true, force: true });

  const operatorRs = buildRustSidecar(target, 'harkroom-operator', 'harkroom-operator-rs');
  const runnerRs = buildRustSidecar(target, 'harkroom-runner', 'harkroom-runner-rs');

  console.log(`Rust operator 사이드카 빌드 완료: ${operatorRs}`);
  console.log(`Rust runner 사이드카 빌드 완료: ${runnerRs}`);
}

/**
 * Rust 사이드카(`crates/<crate>` 의 `<bin>`)를 `tauri build` 와 **같은 triple** 로 만들어 `binaries/<bin>-<triple>` 에 둔다.
 *
 * `crates/*` 는 cargo workspace 가 아니다 — crate 디렉터리에서 자기 `Cargo.lock` 으로 `--locked` 빌드한다.
 * triple 을 명시하는 이유: `tauri build --target` 과 갈리면 다른 아키텍처가 실린다.
 */
function buildRustSidecar(target, crate, bin) {
  const crateDir = join(repoRoot, 'crates', crate);
  execFileSync('cargo', ['build', '--release', '--locked', '--target', target.triple, '--bin', bin], {
    cwd: crateDir,
    stdio: 'inherit',
  });
  mkdirSync(binariesDir, { recursive: true });
  const built = join(crateDir, 'target', target.triple, 'release', bin);
  const outfile = join(binariesDir, `${bin}-${target.triple}`);
  copyFileSync(built, outfile);
  chmodSync(outfile, 0o755);
  return outfile;
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
