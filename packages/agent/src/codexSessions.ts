// codex 는 claude 와 달리 세션 id 를 시작 전에 지정할 수 없다 — `--session-id` 같은 것이
// 없어서, 첫 턴이 끝난 뒤에야 codex 가 무슨 세션을 만들었는지 알 수 있다. 이 모듈은 그
// "사후 발견" 하나만 한다: 방금 끝난 턴이 만든 rollout 파일을 codex 자신의 세션 저장소에서
// 찾아 세션 id 를 읽어낸다.
//
// 초판은 `~/.codex/session_index.jsonl` 을 cwd 로 매칭하려 했는데 실측 결과 그 파일에는
// cwd 필드가 없고 `codex exec` 세션은 애초에 거기 기록되지도 않았다. 진짜 저장소는
// `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` 이고, 그 첫 줄
// (`session_meta`) 의 payload 에 cwd 가 있다는 것을 실측으로 확인했다. `codex exec --json`
// 으로 stdout 에서 id 를 파싱하는 대안도 있었지만, 그러면 그 턴의 화면이 사람이 attach 할
// 수 없는 JSON 스트림이 되어 하네스 재설계의 목적 자체(터미널에 사람이 붙을 수 있는 것)와
// 정면으로 부딪힌다 — 의도적으로 기각했다.

import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// 파일시스템 mtime 은 클럭/포맷에 따라 초 단위로 반올림될 수 있다(예: 일부 오버레이
// 파일시스템, 오래된 FAT류). sinceMs 를 턴 시작 시각으로 잡아 두면, 파일이 그 직후
// 같은 초에 생성됐을 때 mtime 이 내림 반올림되어 sinceMs 보다 "더 이전"처럼 보일 수 있다.
// 그 오탐을 피하려고 비교에 여유를 둔다 — 1시간 전처럼 명백히 오래된 파일을 통과시킬
// 정도로 크지는 않다.
const MTIME_TOLERANCE_MS = 2000;

const ROLLOUT_FILE_RE = /^rollout-.*\.jsonl$/;
const FILENAME_UUID_RE = /rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `sessionsDir` 아래를 재귀적으로 훑어(날짜별로 중첩돼 있으므로) `rollout-*.jsonl` 경로만
 * 모은다. 디렉터리 자체가 없으면(codex 를 아직 한 번도 안 돌렸다) 빈 목록을 돌려준다 —
 * 이것도 "발견 못 함"의 정상 경로이지 에러가 아니다.
 */
async function walkRolloutFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkRolloutFiles(full)));
    } else if (entry.isFile() && ROLLOUT_FILE_RE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 파일 전체를 읽지 않고 첫 줄만 읽는다 — session_meta 는 첫 줄에만 있고, 나머지(특히
 * base_instructions 같은 필드)를 품은 rollout 파일은 수 MB 까지 자랄 수 있다.
 * for-await 를 한 번만 돌고 return 하면 node:readline 이 내부적으로 스트림을 정리한다.
 */
async function readFirstLine(filePath: string): Promise<string | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      return line;
    }
    return null;
  } finally {
    rl.close();
    stream.close();
  }
}

/**
 * cwd 비교를 위한 정규화. macOS 는 `/var` 가 `/private/var` 의 심볼릭 링크라 프로세스에
 * 넘겨진 cwd 문자열과 rollout 파일에 codex 가 실제로 관찰해 적어 둔 cwd 문자열이 겉보기엔
 * 달라도 같은 디렉터리를 가리킬 수 있다(실측: 관찰된 파일의 cwd 는 `/private/var/...`
 * 형태였다). realpath 가 심볼릭 링크와 trailing slash 를 함께 정리해 준다. 대상 디렉터리가
 * 이미 지워졌으면 realpath 는 ENOENT 로 실패하는데, 그때는 최소한 `resolve` 로 trailing
 * slash·`.`/`..` 정도는 정리해서 비교한다.
 */
async function normalizeCwd(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function extractFilenameUuid(filePath: string): string | null {
  const match = FILENAME_UUID_RE.exec(basename(filePath));
  return match?.[1] ?? null;
}

/**
 * session_meta.payload 에서 돌려줄 세션 id 를 고른다.
 *
 * **여기가 함정이다.** payload 에는 `id` 와 `session_id` 가 둘 다 있다. 2026-09-01 당시
 * rollout 사슬에서는 둘이 어긋나는 파일이 있었고 파일명 uuid 는 `id` 와 일치했다. 최신
 * codex-cli 0.153.2 실측에서는 `exec resume` 이 같은 id·같은 rollout 파일에 이어 쓰지만,
 * 과거 형식도 읽어야 하므로 파일명과 `id` 를 교차검증하는 규칙은 유지한다.
 *
 * 그래서 `id` 를 채택한다. 구버전 파일에서 `session_id` 를 쓰면 resume 사슬의 조상 값으로
 * 되돌아갈 수 있다.
 *
 * 혹시 `id` 와 파일명이 서로 다른 값이면(관측된 적은 없다) 파일명 쪽을 신뢰한다 —
 * 파일명은 codex 프로세스가 그 순간 지은 이름이라 payload 내용보다 조작·손상 여지가 적다.
 */
function resolveSessionId(filePath: string, payload: Record<string, unknown>): string | null {
  const filenameId = extractFilenameUuid(filePath);
  const payloadId = typeof payload.id === 'string' ? payload.id : null;

  if (payloadId && filenameId && payloadId !== filenameId) {
    console.warn(
      `[codexSessions] ${filePath}: payload.id(${payloadId}) 가 파일명의 uuid(${filenameId}) 와 다르다 — ` +
        '파일명을 신뢰한다',
    );
    return filenameId;
  }
  return payloadId ?? filenameId;
}

/**
 * 파일 하나를 읽어 `cwd` 가 일치하는 session_meta 인지 확인하고, 맞으면 세션 id 를 돌려준다.
 * 이 함수는 절대 던지지 않는다 — 다른 프로세스(codex)가 동시에 쓰고 있는 파일이라 언제든
 * 잘려 있을 수 있고, 손상 파일 하나가 발견 전체를 막아서는 안 된다(spec 요구사항).
 */
async function matchRolloutFile(filePath: string, targetCwd: string): Promise<string | null> {
  let line: string | null;
  try {
    line = await readFirstLine(filePath);
  } catch {
    return null;
  }
  if (!line) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // 쓰는 도중 잘린 첫 줄 등 — 이 파일만 포기하고 호출자가 다음 파일로 넘어가게 한다.
    return null;
  }

  if (!isPlainObject(parsed) || parsed.type !== 'session_meta' || !isPlainObject(parsed.payload)) {
    return null;
  }
  const payload = parsed.payload;
  if (typeof payload.cwd !== 'string') return null;

  const fileCwd = await normalizeCwd(payload.cwd);
  if (fileCwd !== targetCwd) return null;

  return resolveSessionId(filePath, payload);
}

/**
 * 방금 끝난 codex 턴이 만든(또는 이어받은) 세션의 id 를 찾는다.
 *
 * `<sessionsDir>/**\/rollout-*.jsonl` 을 mtime 역순(최신 우선)으로 훑어, 첫 줄의
 * `session_meta.cwd` 가 `opts.cwd` 와 일치하고 mtime 이 `opts.sinceMs` 이후인 첫 파일의
 * 세션 id 를 돌려준다. 찾지 못하면 `null` — 이건 실패가 아니라 정상적인 기능 후퇴다
 * (spec §8): 러너는 다음 턴에 새 세션으로 다시 시작하면 된다.
 *
 * 스레드마다 avcs 워크스페이스 디렉터리가 고유하므로(threadKey 하나당 workspaceName
 * 하나) cwd 는 정확한 매칭 키다.
 */
export async function findCodexSessionId(
  sessionsDir: string = join(homedir(), '.codex', 'sessions'),
  opts: { cwd: string; sinceMs: number },
): Promise<string | null> {
  const targetCwd = await normalizeCwd(opts.cwd);
  const files = await walkRolloutFiles(sessionsDir);

  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      candidates.push({ file, mtimeMs: info.mtimeMs });
    } catch {
      // 훑는 도중 파일이 지워졌을 수 있다 — 건너뛴다.
    }
  }

  // mtime 역순. mtime 이 같은 두 파일은(같은 밀리초에 시작된 세션들, 드물지만 가능) 파일명이
  // 곧 생성 타임스탬프+uuid 이므로 파일명 역순으로 한 번 더 정렬해 결과를 결정적으로 만든다 —
  // 어느 쪽이 "맞는" 것인지 codex 가 구분해 주는 정보가 더 없는 이상, 최소한 같은 입력에는
  // 항상 같은 답을 내는 것이 다음으로 중요하다.
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));

  for (const { file, mtimeMs } of candidates) {
    if (mtimeMs < opts.sinceMs - MTIME_TOLERANCE_MS) continue;
    const id = await matchRolloutFile(file, targetCwd);
    if (id) return id;
  }
  return null;
}
