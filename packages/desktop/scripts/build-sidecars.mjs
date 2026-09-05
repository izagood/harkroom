#!/usr/bin/env node
// 앱과 함께 배포되는 Node 사이드카를 **전부** 만든다.
//
// - `murmur-runner` — 러너(#431 1단계 B, `#425`·`#429` 를 닫았다). `node-pty` 를 곁들인다.
// - `murmur-daemon` — daemon(#431 2단계 a). **네이티브 의존이 없다.**
//
// ## 왜 스크립트를 둘로 나누지 않고 하나로 묶었는가
//
// 두 산출물은 **같은 디렉터리**(`src-tauri/binaries/`)로 나가고, 그 디렉터리는 빌드마다
// 통째로 비워야 한다(옛 triple 산출물·옛 prebuilds 가 남으면 배포에 섞인다). 스크립트를
// 둘로 나누면 각자가 그 디렉터리를 비우게 되고 — 나중에 실행한 쪽이 먼저 실행한 쪽의
// 산출물을 지운다. 그래서 **비우는 것은 여기 한 번**이고, 그 다음 두 산출물을 차례로 낸다.
//
// `tauri.conf.json` 의 `externalBin` 이 둘 다 요구하므로 "러너만 빌드된 상태"는 어차피
// 유효한 중간 상태가 아니다 — 명령 하나가 둘 다 내는 것이 그 계약과도 맞는다.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { binariesDir, buildSidecar, repoRoot, resolveTarget } from './sidecar.mjs';

async function main() {
  const target = resolveTarget();

  // 옛 산출물을 통째로 걷어낸다(위 주석 — 이 자리가 유일한 청소 지점이다).
  rmSync(binariesDir, { recursive: true, force: true });

  const agentRoot = join(repoRoot, 'packages', 'agent');
  const daemonRoot = join(repoRoot, 'packages', 'daemon');

  const runner = await buildSidecar({
    name: 'murmur-runner',
    entry: join(agentRoot, 'src', 'main.ts'),
    resolveFrom: agentRoot,
    // PTY 를 여는 것은 러너의 일이다 — 그래서 `node-pty` 는 **러너만** 곁들인다.
    nativeDeps: ['node-pty'],
    target,
  });

  const daemon = await buildSidecar({
    name: 'murmur-daemon',
    entry: join(daemonRoot, 'src', 'main.ts'),
    resolveFrom: daemonRoot,
    // **daemon 은 `node-pty` 를 곁들이지 않는다.** daemon 이 하는 일은 러너 프로세스를
    // spawn 하고 unix 소켓으로 말하는 것이고, 그 어느 것도 PTY 를 요구하지 않는다 —
    // PTY 는 하네스를 실제로 돌리는 러너의 일이다. 네이티브 애드온을 안 곁들이므로
    // daemon 은 `bundle.resources` 도 필요 없다(그 항목은 러너 것으로 그대로 둔다).
    nativeDeps: [],
    target,
  });

  console.log(`러너 사이드카 빌드 완료: ${runner.outfile}`);
  console.log(`  node-pty prebuild: ${target.platform}-${target.arch}`);
  console.log(`daemon 사이드카 빌드 완료: ${daemon.outfile}`);
  console.log('  네이티브 의존: 없음 (PTY 는 러너의 일이다)');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
