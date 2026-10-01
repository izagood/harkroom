// claude TUI 의 **계정 단위 관문**을 미리 지나 둔다(2026-10-01). 러너(`agent/src/workspaceTrust.ts`)와
// operator(계정 로그인 직후, `operator/src/claudeAccounts.ts`)가 같은 함수를 쓴다 — 두 벌이면
// 한쪽만 고쳐지는 날이 온다.
//
// ## 왜 필요한가 (실측, claude 2.1.286)
// - **첫 실행 테마 선택.** `<configDir>/.claude.json` 에 `hasCompletedOnboarding: true` 가 없으면
//   TUI 가 테마 선택 화면부터 띄운다. 러너는 답할 수 없어 준비 상한(60초)을 다 태운 뒤 다음
//   계정으로 넘어갔다 — 풀의 계정 하나가 배정마다 그렇게 넘어가 한 번도 돌지 않았다. 빈 config
//   디렉터리로 띄워 재 보면 이 키 하나로 그 화면이 사라진다(테마 값만 적어서는 안 사라진다).
// - **"Teach auto mode about your environment?"** auto mode 분류기 거부가 계정에 5번 쌓이면
//   턴이 **끝난 뒤** 이 선택 창이 뜬다. 턴 끝 판정에는 영향이 없지만 화면에 남아, 그 세션을
//   터미널로 연 사람이 친 글을 먹는다. "Don't show again" 이 적는 값이 `autoModeEnvSetup.dismissed`
//   다(바이너리에서 읽었다). 같은 값을 적는다 — 안내 창일 뿐이라 권한이 새로 열리지 않는다.
//
// ## 규율 (`workspaceTrust.ts` 판례)
// - **이미 적혀 있으면 아무것도 쓰지 않는다.** 이 파일은 하네스가 비용·통계 등을 함께 담는
//   곳이라, 매번 다시 쓰면 그 상태를 놓고 하네스와 경합한다.
// - **다른 키는 건드리지 않는다.** `autoModeEnvSetup` 안의 `denials` 등도 그대로 둔다.
// - 파일이 깨졌으면 **쓰지 않는다** — 하네스의 상태를 우리 최소 문서로 덮으면 되돌릴 수 없다.
//   (없을 때만 새로 만든다.)
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 계정 config 디렉터리 안의 claude 전역 설정 파일. */
export const CLAUDE_GLOBAL_CONFIG_FILE = '.claude.json';

/**
 * 관문 키를 채운 새 문서. **바꿀 것이 없으면 `null`** — 호출자는 그때 파일을 쓰지 않는다.
 * 순수 함수다(테스트가 파일 없이 규칙을 잰다).
 */
export function withClaudeAccountGates(doc: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false;
  const next: Record<string, unknown> = { ...doc };
  if (next.hasCompletedOnboarding !== true) {
    next.hasCompletedOnboarding = true;
    changed = true;
  }
  const raw = next.autoModeEnvSetup;
  const setup = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (setup.dismissed !== true) {
    next.autoModeEnvSetup = { ...setup, dismissed: true };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * `<configDir>/.claude.json` 에 관문 키를 적는다. 썼으면 `true`.
 *
 * **던진다** — 삼킬지는 호출자가 정한다(러너는 삼키고 로그를 남긴다: 못 적으면 관문이 뜨고
 * 준비 대기가 그 사실을 드러낸다).
 */
export async function markClaudeAccountGates(configDir: string): Promise<boolean> {
  const path = join(configDir, CLAUDE_GLOBAL_CONFIG_FILE);
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let doc: Record<string, unknown> = {};
  if (text !== null) {
    const parsed: unknown = JSON.parse(text); // 깨졌으면 던진다 — 위 "쓰지 않는다"
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${path} 가 객체가 아니다 — 덮어쓰지 않는다`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const next = withClaudeAccountGates(doc);
  if (next === null) return false;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  // 0600 — 이 파일에는 MCP 설정과 사용 통계가 함께 산다(`workspaceTrust.ts` 와 같다).
  await writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  return true;
}

// ── 사람이 지나야 하는 관문 표식(2026-10-01) ─────────────────────────────────────
//
// 관문 중에는 **우리가 미리 지나 두면 안 되는 것**이 있다. 조직이 건 관리 설정 승인("Managed
// settings require approval" — 프롬프트를 어디로 보낼지 승인한다)이 그렇다. 러너는 그 화면을
// 만나면 그 계정을 건너뛰고(`pty.ts::gateFailMs`) 다음 계정으로 간다. 그 사실을 사람이 알고 그
// 계정의 터미널을 열어 직접 고를 수 있게, 러너가 계정 디렉터리에 표식을 남긴다.
//
// - **화면 원문은 남기지 않는다.** 조직의 수집 주소 같은 값이 들어 있을 수 있다. 시각만 적는다.
// - writer 가 여럿(러너 여러 개·operator)이라 **원자적으로** 쓴다(tmp + rename). 내용이 시각
//   하나라 마지막 writer 가 이겨도 뜻이 같다.
// - 지우는 곳: 그 계정으로 턴이 성공했을 때(러너), 사람이 연 터미널이 끝났을 때(스크립트),
//   다시 로그인했을 때(operator).

/** 계정 config 디렉터리 안의 표식 파일. claude 가 쓰는 이름과 겹치지 않게 접두를 붙였다. */
export const CLAUDE_ATTENTION_FILE = '.harkroom-attention.json';

/**
 * 표식이 이만큼 지나면 다시 배정 후보로 돌린다. 사람이 우리 밖에서(직접 터미널로) 관문을 지났을
 * 수도 있다 — 영영 빼 두면 그 계정이 다시는 안 쓰인다. 아직 막혀 있으면 3초 만에 다시 표식이 선다.
 */
export const CLAUDE_ATTENTION_TTL_MS = 30 * 60 * 1000;

export interface ClaudeAccountAttention {
  kind: 'gate';
  atMs: number;
}

export async function markAccountNeedsAttention(configDir: string, atMs: number): Promise<void> {
  const path = join(configDir, CLAUDE_ATTENTION_FILE);
  const tmp = `${path}.tmp-${randomUUID()}`;
  const body: ClaudeAccountAttention = { kind: 'gate', atMs };
  await writeFile(tmp, JSON.stringify(body), { mode: 0o600 });
  await rename(tmp, path);
}

/** 표식. 없거나 깨졌으면 `null`(깨진 표식으로 계정을 빼지 않는다). */
export async function readAccountAttention(configDir: string): Promise<ClaudeAccountAttention | null> {
  let text: string;
  try {
    text = await readFile(join(configDir, CLAUDE_ATTENTION_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text) as { kind?: unknown; atMs?: unknown };
    return v.kind === 'gate' && typeof v.atMs === 'number' && Number.isFinite(v.atMs)
      ? { kind: 'gate', atMs: v.atMs }
      : null;
  } catch {
    return null;
  }
}

/** 표식이 지금 유효한가(`CLAUDE_ATTENTION_TTL_MS`). */
export function isAttentionFresh(a: ClaudeAccountAttention | null, now: number): boolean {
  return a !== null && now - a.atMs < CLAUDE_ATTENTION_TTL_MS && a.atMs <= now + 60_000;
}

/** 표식을 지운다. 없으면 아무 일도 없다. 지웠으면 `true`. */
export async function clearAccountAttention(configDir: string): Promise<boolean> {
  const path = join(configDir, CLAUDE_ATTENTION_FILE);
  const had = await stat(path).then(() => true, () => false);
  if (had) await rm(path, { force: true });
  return had;
}

/**
 * 이 디렉터리를 그 계정이 **신뢰한 작업 폴더**로 적는다(없을 때만). operator 가 사람에게 여는
 * 터미널의 작업 폴더(harkroom 이 만든 빈 폴더)에만 쓴다 — 거기서 폴더 신뢰 화면이 먼저 뜨면
 * 사람이 고쳐야 할 관문이 그 뒤에 가린다. 규율은 `markClaudeAccountGates` 와 같다.
 */
export async function markClaudeWorkspaceTrusted(configDir: string, workspaceDir: string): Promise<boolean> {
  const path = join(configDir, CLAUDE_GLOBAL_CONFIG_FILE);
  let text: string | null = null;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  let doc: Record<string, unknown> = {};
  if (text !== null) {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${path} 가 객체가 아니다 — 덮어쓰지 않는다`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const projects = (doc.projects && typeof doc.projects === 'object' && !Array.isArray(doc.projects)
    ? doc.projects : {}) as Record<string, Record<string, unknown>>;
  const entry = projects[workspaceDir] ?? {};
  if (entry.hasTrustDialogAccepted === true) return false;
  const next = { ...doc, projects: { ...projects, [workspaceDir]: { ...entry, hasTrustDialogAccepted: true } } };
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(next, null, 2), { mode: 0o600 });
  return true;
}
