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
import type { AgentHarness } from '@murmur/shared';

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
async function trustForClaude(workspaceDir: string, configDir: string | null): Promise<void> {
  const path = claudeConfigFile(configDir);
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
async function trustForCodex(workspaceDir: string, codexHome: string): Promise<void> {
  const path = join(codexHome, 'config.toml');
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
    if (opts.harness === 'claude-code') await trustForClaude(opts.workspaceDir, opts.claudeConfigDir);
    else if (opts.harness === 'codex') await trustForCodex(opts.workspaceDir, opts.codexHome);
  } catch (err) {
    // 위 주석의 이유로 삼킨다 — 다만 조용히는 아니다.
    console.error(
      `[workspaceTrust] ${opts.workspaceDir} 신뢰 기록 실패(턴은 계속한다 — 대화상자가 뜨면 준비 대기가 상한에서 실패한다): `
        + (err instanceof Error ? err.message : String(err)),
    );
  }
}
