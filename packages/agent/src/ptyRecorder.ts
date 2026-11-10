/**
 * PTY 원시 출력 녹화(기본 꺼짐). `AGENT_PTY_RECORD_DIR` 를 준 러너만 턴마다 파일 하나를 쓴다.
 *
 * ## 왜 있나
 * 러너가 화면으로 내리는 판정(준비·관문·정지)은 지금 `@xterm/headless` 가 그린 화면 텍스트를 본다.
 * 다른 터미널 에뮬레이터로 옮겨도 같은 화면이 나오는지 재려면, 그린 뒤의 텍스트(test/fixtures 의
 * `*.txt`)가 아니라 **하네스가 실제로 뱉은 바이트**를 다시 틀어 봐야 한다. 이것이 그 바이트를 남긴다.
 *
 * ## 형식 — asciicast v2
 * 첫 줄은 헤더 JSON, 그 뒤 한 줄에 하나씩 `[초, "o", 출력]`·`[초, "r", "COLSxROWS"]`. 널리 쓰는 형식이라
 * 재생 도구(asciinema 등)를 따로 만들 필요가 없다. node-pty 가 이미 문자열로 디코드해 주므로 그 문자열을
 * 그대로 적는다(화면 판정이 받는 것과 같은 값이다).
 *
 * ## 남기지 않는 것
 * - **입력은 적지 않는다.** attach 한 사람이 친 글자(비밀번호를 포함할 수 있다)는 이 파일에 없다.
 * - 헤더에 명령·인자·환경을 적지 않는다 — 인자에는 지시문 경로와 작업 폴더가, 환경에는 비밀이 있다.
 * 그래도 **화면 출력 자체**에는 계정 이름·작업 폴더 경로·붙여 넣은 프롬프트가 보일 수 있다. 그래서
 * 파일은 0600·폴더는 0700 으로 만들고, 켠 사람의 기계 밖으로 나가는 길은 두지 않는다.
 *
 * ## 실패는 턴을 죽이지 않는다
 * 쓰기는 node-pty 의 data 리스너 안에서 일어난다 — 여기서 던지면 턴 전체가 죽는다(`pty.ts` 의
 * `onData` 주석과 같은 규율). 열기·쓰기가 실패하면 녹화만 멈추고 조용히 넘어간다.
 */
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** 파일 하나의 상한. 넘으면 그 턴의 녹화를 거기서 멈춘다(디스크를 채우지 않는다). */
export const PTY_RECORD_MAX_BYTES = 32 * 1024 * 1024;

export interface PtyRecorder {
  output(chunk: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** 파일 이름에 쓸 수 있는 글자만 남긴다 — 하네스 이름이 경로 조각이 되지 않게. */
function safeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'pty';
}

/**
 * `dir` 아래에 녹화 파일 하나를 연다. `dir` 이 없거나(꺼짐) 열 수 없으면 null — 부르는 쪽은 녹화 없이 간다.
 * `now` 는 시험이 시각을 고정하려고 연다.
 */
export function openPtyRecorder(
  dir: string | null,
  meta: { label: string; cols: number; rows: number },
  now: () => number = Date.now,
): PtyRecorder | null {
  if (!dir || !isAbsolute(dir)) return null;
  const startedMs = now();
  let fd: number;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date(startedMs).toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${safeLabel(meta.label)}-${process.pid}.cast`;
    fd = openSync(join(dir, name), 'wx', 0o600);
  } catch {
    return null;
  }
  let written = 0;
  let open = true;
  const write = (line: string): void => {
    if (!open) return;
    const buf = Buffer.from(line + '\n', 'utf8');
    if (written + buf.length > PTY_RECORD_MAX_BYTES) { close(); return; }
    try {
      writeSync(fd, buf);
      written += buf.length;
    } catch {
      close();
    }
  };
  const close = (): void => {
    if (!open) return;
    open = false;
    try { closeSync(fd); } catch { /* 이미 닫혔으면 할 일이 없다 */ }
  };
  const elapsed = (): number => Math.round(now() - startedMs) / 1000;
  write(JSON.stringify({
    version: 2,
    width: meta.cols,
    height: meta.rows,
    timestamp: Math.floor(startedMs / 1000),
    env: { TERM: 'xterm-256color' },
  }));
  return {
    output(chunk) { write(JSON.stringify([elapsed(), 'o', chunk])); },
    resize(cols, rows) { write(JSON.stringify([elapsed(), 'r', `${cols}x${rows}`])); },
    close,
  };
}
