// 하네스가 이 워크스페이스를 **신뢰하도록** 미리 적어 둔다(2026-09-08).
//
// **왜 필요해졌는가.** `-p`/`exec` 은 워크스페이스 신뢰를 묻지 않는다 — claude 의 `--help`
// 가 그 사실을 명시한다: *"The workspace trust dialog is skipped when Claude is run in
// non-interactive mode (via -p …)"*. 멘션 턴을 TUI 로 옮기면서 그 대화상자가 깨어났다.
//
// **묻게 두면 턴이 통째로 죽는다.** 러너는 사람이 아니라서 답할 수 없고, 대화상자가 화면을
// 덮은 채로 무발화 한도(기본 30분)까지 매달린다. 더 나쁜 것은 그 대화상자가 준비 표시와
// 같은 글자(`❯`)를 담고 있어 준비 판정을 오인시킨다는 점이다 — 그러면 프롬프트가 모달에
// 타이핑된다(2026-09-08 프로덕션에서 실제로 그랬다).
//
// **권한이 새로 열리지 않는다.** 신뢰가 허용하는 것은 그 디렉터리의 project-local 설정·훅·
// exec 정책 로드다. 그 디렉터리는 **러너가 만들어 에이전트에게 준 워크스페이스**이고,
// `mentionPermission: 'auto'` 에이전트는 이미 그 안에서 무엇이든 실행할 수 있다(스펙 §6 이
// 그렇게 정했다). 즉 훅을 심어 실행하는 길은 이미 있는 길보다 넓지 않다. 신뢰가 정하는
// 것은 "이 디렉터리를 작업 대상으로 인정하는가"이고, 러너가 그것을 만들었다는 사실이 곧 답이다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { adapterFor, harnessAdaptersEnabled } from './adapters/index.js';
import type { AgentHarness } from '@harkroom/shared';

/**
 * claude 의 신뢰 장부. `CLAUDE_CONFIG_DIR` 를 따라간다 — 계정별 config 디렉터리로 띄우면
 * 이 파일도 그 아래로 옮겨간다(`claudeSessions.ts` 의 projects 경로와 같은 규율).
 */
function claudeConfigFile(configDir: string | null): string {
  return join(configDir ?? join(homedir(), '.claude'), '.claude.json');
}

/**
 * 신뢰를 적는다. **이미 적혀 있으면 아무것도 쓰지 않는다** — 매 턴 같은 파일을 다시 쓰면
 * 그 파일을 함께 보는 하네스와 경합하고, 하네스가 담아 둔 다른 상태(비용·기간 통계 등)를
 * 덮어쓸 위험이 생긴다.
 *
 * **던지지 않는다.** 못 적었다면 대화상자가 뜨고 준비 대기가 상한에서 실패한다 — 그 실패가
 * 이미 사람에게 사실을 말한다(`pty.ts::PromptNotDeliveredError`). 여기서 예외를 올리면
 * 원인이 하나 더 앞으로 밀릴 뿐 나아지지 않는다.
 */
async function trustForClaude(workspaceDir: string, path: string): Promise<void> {
  let doc: { projects?: Record<string, Record<string, unknown>> } = {};
  try {
    doc = JSON.parse(await readFile(path, 'utf8')) as typeof doc;
  } catch {
    // 파일이 없거나 깨졌다 — 신뢰만 담은 최소 문서로 시작한다. 하네스가 나머지를 채운다.
    doc = {};
  }
  const projects = doc.projects ?? {};
  const entry = projects[workspaceDir] ?? {};
  if (entry.hasTrustDialogAccepted === true) return;

  projects[workspaceDir] = { ...entry, hasTrustDialogAccepted: true };
  doc.projects = projects;
  await mkdir(dirname(path), { recursive: true });
  // 0600 — 이 파일에는 MCP 설정과 사용 통계가 함께 산다.
  await writeFile(path, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

/**
 * codex 의 신뢰 장부는 `<CODEX_HOME>/config.toml` 의 `[projects."<경로>"] trust_level`.
 *
 * TOML 파서를 들이지 않고 **없으면 덧붙이는 방식**으로 다룬다: 이 파일은 러너가 만든
 * 격리 홈의 것이라 우리가 적은 것 외에는 하네스가 적은 UI 상태뿐이고, 같은 절이 두 번
 * 있으면 codex 가 나중 것을 읽는다. 파서를 넣으면 그 의존이 러너 전체로 번진다.
 */
async function trustForCodex(workspaceDir: string, path: string): Promise<void> {
  const codexHome = dirname(path);
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch { /* 없으면 새로 만든다 */ }

  const header = `[projects."${workspaceDir}"]`;
  if (text.includes(header)) return;

  const block = `${text.endsWith('\n') || text === '' ? '' : '\n'}\n${header}\ntrust_level = "trusted"\n`;
  await mkdir(codexHome, { recursive: true });
  await writeFile(path, text + block, { mode: 0o600 });
}

/**
 * claude 의 계정 설정 파일. **`.claude.json` 과 다른 파일이다** — 그쪽은 워크스페이스별
 * 상태(`projects[dir]`)를 담고, 이쪽은 계정 전체에 걸리는 설정을 담는다.
 */
function claudeSettingsFile(configDir: string | null): string {
  return join(configDir ?? join(homedir(), '.claude'), 'settings.json');
}

/**
 * bypassPermissions 경고 화면을 미리 지나 둔다(2026-09-08 실측).
 *
 * **더는 기본 경로가 아니다**(2026-09-09). `turn.ts` 가 murmur 의 `auto` 를 claude 의
 * `auto` 로 번역하도록 고쳤고, 그 모드에는 이 경고가 없다(실측). 남겨 두는 이유는 사람이
 * 터미널에서 `shift+tab` 으로 bypass 까지 올려 쓸 수 있기 때문이다 — 그때 이 기록이 없으면
 * 그 세션이 경고 화면에서 멈춘다.
 *
 * 2026-09-08 에는 이것이 기본 경로였고, 그래서 프로덕션의 모든 첫 턴이 **기본 선택
 * `❯ No, exit`** 로 1초 만에 죽었다(exitCode 1).
 *
 * **권한이 새로 열리지 않는다.** 그 모드는 이미 `mentionPermission: 'auto'` 가 정한
 * 것이고, 이 화면은 **이미 내려진 결정을 계정마다 다시 묻는 확인창**일 뿐이다. 여기서
 * 적는 것은 "그 결정을 이 계정에도 적용한다"이지 새 권한이 아니다.
 *
 * **워크스페이스가 아니라 계정 단위다.** 그래서 `ensureWorkspaceTrusted` 와 함수를 갈랐다 —
 * 저장 위치도 다르고(`settings.json`), 한 번 적으면 그 계정의 모든 워크스페이스가 풀린다.
 *
 * codex 에는 이 관문이 없다. 없는 파일을 만들지 않는다.
 */
async function acceptDangerousModeForClaude(configDir: string | null): Promise<void> {
  const path = claudeSettingsFile(configDir);
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    // 없거나 깨졌다 — 이 키 하나만 담은 최소 문서로 시작한다. 하네스가 나머지를 채운다.
    doc = {};
  }
  // 이미 적혀 있으면 아무것도 쓰지 않는다(`trustForClaude` 와 같은 이유): 하네스가 이 파일에
  // 테마·TUI 모드를 함께 담으므로, 매 턴 다시 쓰면 그 상태를 놓고 경합한다.
  if (doc.skipDangerousModePermissionPrompt === true) return;

  doc.skipDangerousModePermissionPrompt = true;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(doc, null, 2), { mode: 0o600 });
}

/**
 * 이 계정이 하네스의 **계정 단위 관문**을 지나게 한다. `ensureWorkspaceTrusted` 와 나란히,
 * **PTY 를 띄우기 전에** 부른다.
 *
 * 던지지 않는 이유는 `ensureWorkspaceTrusted` 와 같다 — 못 적었으면 관문이 뜨고, 그때는
 * 준비 대기가 상한에서 사람을 부른다(`pty.ts::injectPrompt.onAttention`).
 */
export async function ensureDangerousModeAccepted(opts: {
  harness: AgentHarness;
  claudeConfigDir: string | null;
}): Promise<void> {
  try {
    if (opts.harness === 'claude-code') await acceptDangerousModeForClaude(opts.claudeConfigDir);
  } catch (err) {
    console.error(
      '[workspaceTrust] bypassPermissions 수락 기록 실패(턴은 계속한다 — 경고 화면이 뜨면 '
        + '준비 대기가 상한에서 사람을 부른다): '
        + (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * **새 경로** — 장부의 자리와 형식을 어댑터 표에서 읽는다.
 *
 * 옛 분기와 무엇이 다른가: 하네스 이름을 보지 않는다. 그래서 네 번째 하네스가 와도 이
 * 함수는 안 고친다 — 표에 `trust` 를 채우면 된다. `null` 이면 **그 관문이 없다**는 뜻이라
 * 아무것도 쓰지 않는다(opencode 가 그 자리다: 실측에서 신뢰를 묻지 않았다).
 *
 * 쓰는 일 자체는 옛 경로와 **같은 함수**가 한다 — 여기서 다시 구현하면 두 벌이 되고, 그
 * 순간 패리티 테스트가 "같은 코드가 같은 답을 낸다"는 공허한 것을 재게 된다.
 */
async function trustViaAdapter(opts: {
  harness: AgentHarness;
  workspaceDir: string;
  claudeConfigDir: string | null;
  codexHome: string;
}): Promise<void> {
  const ledger = adapterFor(opts.harness).trust;
  if (ledger === null) return;
  const root = ledger.root === 'account-config-dir'
    ? (opts.claudeConfigDir ?? join(homedir(), '.claude'))
    : opts.codexHome;
  const path = join(root, ledger.file);
  if (ledger.kind === 'claude-json') await trustForClaude(opts.workspaceDir, path);
  else await trustForCodex(opts.workspaceDir, path);
}

/**
 * 이 턴이 쓸 워크스페이스를 하네스가 신뢰하게 한다. **PTY 를 띄우기 전에 부른다** —
 * 뜬 뒤에 적으면 그 턴은 이미 대화상자를 만난 뒤다.
 */
export async function ensureWorkspaceTrusted(opts: {
  harness: AgentHarness;
  workspaceDir: string;
  claudeConfigDir: string | null;
  codexHome: string;
}): Promise<void> {
  try {
    // ── 이설 중이다. 두 경로가 함께 산다(2026-09-11) ────────────────────────────
    //
    // 이 경로가 깨지면 에이전트가 안 돌고, 그러면 murmur 자체를 못 쓴다. 그래서 옛 분기를
    // **그대로 두고** 새 경로를 스위치 뒤에 둔다. 기본값은 꺼짐이므로 켜지 않은 러너는
    // 지금까지와 한 글자도 다르지 않게 돈다.
    //
    // 두 경로가 같은 답을 내는지는 `test/workspaceTrustParity.test.ts` 가 **양쪽을 실제로
    // 돌려 파일 바이트를 비교**해서 지킨다. 옛 분기는 스위치가 기본 켜짐이 되고 한 판
    // 돌려 본 뒤에 지운다.
    if (harnessAdaptersEnabled()) await trustViaAdapter(opts);
    else if (opts.harness === 'claude-code') await trustForClaude(opts.workspaceDir, claudeConfigFile(opts.claudeConfigDir));
    else if (opts.harness === 'codex') await trustForCodex(opts.workspaceDir, join(opts.codexHome, 'config.toml'));
  } catch (err) {
    // 위 주석의 이유로 삼킨다 — 다만 조용히는 아니다.
    console.error(
      `[workspaceTrust] ${opts.workspaceDir} 신뢰 기록 실패(턴은 계속한다 — 대화상자가 뜨면 준비 대기가 상한에서 실패한다): `
        + (err instanceof Error ? err.message : String(err)),
    );
  }
}
