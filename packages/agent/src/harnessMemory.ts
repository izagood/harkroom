/**
 * 하네스 파일 메모리 **수확 알림**(메모리 고도화 U5, 2026-09-28 jaebin: "공존할 수 있다 — 하네스의
 * 모든 부분을 파악해서 컨트롤할 수는 없으니").
 *
 * Claude Code 는 자기 시스템 프롬프트의 `# Memory` 절을 따라 `<CLAUDE_CONFIG_DIR>/projects/<cwd>/memory/`
 * 에 파일로 기억을 적는다. 그런데 러너의 cwd 는 **스레드마다** 다르다(`mentionTurn.ts::resolveWorkspaceDir`)
 * — 그래서 거기 적힌 것은 그 스레드에서만 보인다. 2026-09-28 감사: 388 디렉터리 중 43곳에 113개가
 * 갇혀 있었고, forge 의 현장 교훈 8개(niccli NVM 함정·kube-vip 등)도 그중이었다.
 *
 * 하네스를 끄거나 옮기지 않는다(그것은 하네스의 영역이다). 대신 **알린다**: 이 스레드의 파일
 * 메모리에 새로 생기거나 바뀐 파일이 있으면 다음 턴 프롬프트에 목록을 싣고, 다른 스레드에서도
 * 쓸 것이면 `memory.set` 으로 옮기라고 말한다. 판단은 에이전트가 한다 — 스레드 안에서만 쓸
 * 메모는 거기 두는 것이 맞다.
 *
 * 한계: 알림은 **같은 스레드의 다음 턴**에 나온다. 그 스레드에 다음 턴이 없으면 알리지 못한다.
 * 턴이 끝난 뒤에는 에이전트에게 말할 길이 없기 때문이다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { escapeForPrompt } from './prompt.js';

export const HARNESS_MEMORY_SEEN_DIR = 'harness-memory-seen';
/** 한 턴에 싣는 파일 수 상한 — 넘치면 "그 밖에 N개"로 줄인다. */
export const HARNESS_MEMORY_MAX_LISTED = 10;

/**
 * Claude Code 가 cwd 를 프로젝트 디렉터리 이름으로 바꾸는 규칙: 영숫자가 아닌 글자는 전부 `-`.
 * (`/Users/x/.a` → `-Users-x--a`, 2026-09-28 실측으로 확인)
 */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * `configDir` 이 null 이면 계정 지정이 없는 것(시스템 기본)이다. claude 의 기본은 `~/.claude` 라
 * 그 자리를 본다 — 파일 메모리를 적는 하네스가 지금 claude 뿐이기 때문이다.
 */
export function claudeMemoryDir(configDir: string | null, cwd: string, dirUnderConfig = 'projects'): string {
  return join(configDir ?? join(homedir(), '.claude'), dirUnderConfig, claudeProjectDirName(cwd), 'memory');
}

export interface HarnessMemoryFile {
  name: string;
  mtimeMs: number;
  /** 프론트매터의 `description:` 한 줄(있으면). */
  description: string | null;
}

/** 인덱스(`MEMORY.md`)는 뺀다 — 목록일 뿐 기억이 아니다. 디렉터리가 없으면 빈 배열. */
export async function scanHarnessMemory(dir: string): Promise<HarnessMemoryFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: HarnessMemoryFile[] = [];
  for (const name of names.sort()) {
    if (name === 'MEMORY.md' || !name.endsWith('.md')) continue;
    try {
      const path = join(dir, name);
      const st = await stat(path);
      if (!st.isFile()) continue;
      const head = (await readFile(path, 'utf8')).slice(0, 2000);
      const m = /^description:\s*(.+)$/m.exec(head);
      out.push({ name, mtimeMs: Math.floor(st.mtimeMs), description: m ? m[1]!.trim().slice(0, 200) : null });
    } catch {
      // 읽는 사이 지워졌다 — 없는 것으로 친다.
    }
  }
  return out;
}

export interface HarnessMemoryNotice {
  lines: string[];
  /** 성공한 턴 뒤에 부른다 — 알린 상태를 저장한다. */
  commit(): Promise<void>;
}

function seenFile(stateDir: string, key: string): string {
  return join(stateDir, HARNESS_MEMORY_SEEN_DIR, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
}

export async function planHarnessMemoryNotice(opts: {
  stateDir: string;
  key: string;
  files: HarnessMemoryFile[];
}): Promise<HarnessMemoryNotice> {
  const file = seenFile(opts.stateDir, opts.key);
  let seen: Record<string, number> = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { files?: Record<string, number> };
    if (parsed.files && typeof parsed.files === 'object') seen = parsed.files;
  } catch {
    // 처음이다.
  }
  const fresh = opts.files.filter((f) => seen[f.name] !== f.mtimeMs);
  const next = Object.fromEntries(opts.files.map((f) => [f.name, f.mtimeMs]));
  const commit = async () => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(opts.stateDir, HARNESS_MEMORY_SEEN_DIR), { recursive: true });
      await writeFile(tmp, JSON.stringify({ files: next }), { mode: 0o600 });
      await rename(tmp, file);
    } catch (err: unknown) {
      console.error(`[harnessMemory] 본 목록 저장 실패 — 다음 턴이 다시 알린다: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (!fresh.length) return { lines: [], commit };

  const listed = fresh.slice(0, HARNESS_MEMORY_MAX_LISTED);
  const lines = [
    '<harness-memory>',
    '이 스레드의 하네스 파일 메모리(작업 디렉터리 기준이라 **다른 스레드에서는 안 보인다**)에 새로 적히거나',
    '바뀐 파일이 있다. 다른 스레드·다른 턴에서도 쓸 것이면 `memory.set` 으로 옮겨라(주제는 `mem/<이름>`,',
    '한 작업의 경위는 `kind: "journal"`). 이 스레드에서만 쓸 메모면 그대로 둬도 된다.',
    ...listed.map((f) => `- ${escapeForPrompt(f.name)}${f.description ? ` — ${escapeForPrompt(f.description)}` : ''}`),
    ...(fresh.length > listed.length ? [`- …그 밖에 ${fresh.length - listed.length}개`] : []),
    '</harness-memory>',
  ];
  return { lines, commit };
}
