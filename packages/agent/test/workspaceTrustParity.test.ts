// **옛 경로와 새 경로가 같은 답을 내는가** — 신뢰 장부(2026-09-11).
//
// 러너의 실행 경로는 깨지면 murmur 자체를 못 쓰게 만드는 자리다. 그래서 이설은 옛 분기를
// 남긴 채 새 경로를 스위치 뒤에 두고, **전환 전에 둘이 같음을 증명한다.** 이 파일이 그
// 증명이고, `MURMUR_HARNESS_ADAPTERS` 가 기본 켜짐이 된 뒤 옛 분기를 지울 때 함께 정리한다.
//
// ## 잰 방법 — 바이트를 비교한다
//
// 태그나 경로 문자열을 비교하지 않는다. **양쪽을 실제로 돌려** 디스크에 적힌 파일을 읽고
// 그 내용을 맞춘다. 이유는 어댑터 패리티 테스트와 같다: 값만 비교하면 두 경로가 같은
// 오해를 공유해도 초록이다. 여기서 재는 것은 "하네스가 이 워크스페이스를 신뢰하게 되는가"
// 이고, 그 사실은 파일에만 있다.
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNABLE_HARNESSES, type AgentHarness } from '@murmur/shared';

import { ensureWorkspaceTrusted } from '../src/workspaceTrust.js';
import { adapterFor } from '../src/adapters/index.js';

const RUNNABLE = RUNNABLE_HARNESSES as readonly AgentHarness[];

let root: string;
let savedFlag: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'trust-parity-'));
  savedFlag = process.env.MURMUR_HARNESS_ADAPTERS;
});
afterEach(async () => {
  // 플래그를 원상복구한다 — 남기면 **이 파일 뒤에 도는 다른 테스트가 새 경로로 돈다.**
  if (savedFlag === undefined) delete process.env.MURMUR_HARNESS_ADAPTERS;
  else process.env.MURMUR_HARNESS_ADAPTERS = savedFlag;
  await rm(root, { recursive: true, force: true });
});

/**
 * 한쪽 경로로 신뢰를 적고, **적힌 파일 전부**를 `상대경로 → 내용` 으로 돌려준다.
 *
 * 파일 하나를 지목해 읽지 않는 이유: 그러면 "새 경로가 **다른 파일에도** 뭔가 적는다"를
 * 못 잡는다. 무엇이 생겼는지까지 같아야 같은 것이다.
 */
async function runOnce(harness: AgentHarness, enabled: boolean): Promise<Record<string, string>> {
  const base = join(root, `${harness}-${enabled ? 'new' : 'old'}`);
  const configDir = join(base, 'config');
  const codexHome = join(base, 'codex-home');
  const workspaceDir = join(base, 'workspace');
  await mkdir(workspaceDir, { recursive: true });

  if (enabled) process.env.MURMUR_HARNESS_ADAPTERS = '1';
  else delete process.env.MURMUR_HARNESS_ADAPTERS;

  await ensureWorkspaceTrusted({ harness, workspaceDir, claudeConfigDir: configDir, codexHome });

  // 두 뿌리 아래에서 우리가 적을 수 있는 이름만 본다. 경로에 workspaceDir 이 들어가므로
  // 그 부분은 비교 전에 지운다(옛/새 실행이 서로 다른 임시 디렉터리에서 돌기 때문이다).
  const out: Record<string, string> = {};
  for (const [label, path] of [
    ['claude/.claude.json', join(configDir, '.claude.json')],
    ['claude/settings.json', join(configDir, 'settings.json')],
    ['codex/config.toml', join(codexHome, 'config.toml')],
  ] as const) {
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text !== null) out[label] = text.split(workspaceDir).join('<WORKSPACE>');
  }
  return out;
}

describe('신뢰 장부 — 옛 경로와 새 경로가 같다', () => {
  for (const harness of RUNNABLE) {
    it(`${harness}: 적히는 파일과 내용이 같다`, async () => {
      const old = await runOnce(harness, false);
      const now = await runOnce(harness, true);
      expect(now).toEqual(old);
      // 공허한 통과를 막는다 — 둘 다 아무것도 안 적었으면 "같다"가 뜻이 없다.
      // 장부가 있는 하네스는 **무엇이든 적혀 있어야** 한다.
      if (adapterFor(harness).trust !== null) expect(Object.keys(old).length).toBeGreaterThan(0);
    });
  }

  it('장부가 없는 하네스에는 새 경로도 아무것도 안 적는다', async () => {
    // opencode 는 `trust: null` 이다(실측에서 신뢰를 묻지 않았다). 옛 경로에는 분기가 아예
    // 없어 아무 일도 안 했는데, 새 경로가 표를 읽다가 뭔가 지어내면 그때 갈린다.
    expect(adapterFor('opencode').trust).toBeNull();
    expect(await runOnce('opencode', true)).toEqual({});
    expect(await runOnce('opencode', false)).toEqual({});
  });

  it('두 번 불러도 같다 — 이미 적혀 있으면 덮지 않는다', async () => {
    // 옛 경로가 지키던 성질이다(하네스가 같은 파일에 담아 둔 다른 상태를 놓고 경합하지
    // 않기 위해). 새 경로도 같은 함수를 쓰므로 유지돼야 하고, 그것을 여기서 고정한다.
    for (const harness of RUNNABLE) {
      const first = await runOnce(harness, true);
      const second = await runOnce(harness, true);
      expect(second).toEqual(first);
    }
  });
});
