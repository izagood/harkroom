/**
 * 턴 기록 가리기(비밀 보관소 D7, PR 3b). 마운트한 비밀의 값이 하네스 기록(claude 세션 jsonl·codex rollout)에
 * 남았으면 `***` 로 바꿔 쓴다. 계획·검토: harkroom 스레드 bc98df3a.
 *
 * 왜 이것으로 충분하지 않은가(문서화한 한계): 모델이 값을 출력했다면 그 값은 **이미 모델 제공사에 갔다.**
 * 이것이 지키는 것은 이 머신의 디스크에 남는 사본이다 — 백업·동기화·나중의 resume·다른 에이전트의 셸.
 *
 * 형태: 평문, **JSON 문자열 안의 평문**(jsonl 은 줄바꿈·따옴표를 이스케이프해 적는다), URL 인코딩,
 * base64(표준·패딩 없음·url-safe). 여러 줄 값은 16자 이상 줄마다 따로 본다. 8바이트 미만 값은 보지 않는다
 * (서버 D5 와 같은 규칙 — 짧은 값은 정상 글을 망가뜨린다).
 *
 * 쓰기: 심링크는 건드리지 않는다. 같은 디렉터리에 임시 파일을 쓰고 rename 한다 — 도중에 죽어도 반쪽 파일이
 * 남지 않는다. 원래 mode 를 지킨다. 구조(JSON 줄)는 값이 문자열 안에 있으므로 그대로 산다 — resume 이 되는지는
 * 하네스별 실측 항목이다(PR 3b 본문).
 */
import { randomBytes } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SCRUB_MIN_BYTES = 8;
const LINE_MIN_CHARS = 16;
export const SCRUB_MASK = '***';

/** 한 값에서 찾을 글자 바늘들. 긴 것부터 — 짧은 바늘이 긴 바늘의 일부를 먼저 지워 긴 것이 남는 일을 막는다. */
export function scrubNeedles(value: Buffer): string[] {
  if (value.length < SCRUB_MIN_BYTES) return [];
  const out = new Set<string>();
  const add = (s: string) => { if (s.length >= SCRUB_MIN_BYTES) out.add(s); };
  const b64 = value.toString('base64');
  add(b64); add(b64.replace(/=+$/, '')); add(value.toString('base64url'));
  const text = value.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(value)) {
    const forms = [text, text.trim()];
    if (text.trim().includes('\n')) {
      for (const line of text.trim().split(/\r?\n/)) if (line.trim().length >= LINE_MIN_CHARS) forms.push(line.trim());
    }
    for (const f of forms) {
      add(f);
      add(JSON.stringify(f).slice(1, -1));
      try { add(encodeURIComponent(f)); } catch { /* 짝 없는 서로게이트 */ }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** 문자열에서 바늘을 전부 가린다. 바꾼 횟수를 함께 준다. */
export function scrubText(text: string, needles: readonly string[]): { text: string; replaced: number } {
  let replaced = 0;
  let out = text;
  for (const n of needles) {
    if (!out.includes(n)) continue;
    const parts = out.split(n);
    replaced += parts.length - 1;
    out = parts.join(SCRUB_MASK);
  }
  return { text: out, replaced };
}

/** 파일 하나를 가린다. 없거나 심링크면 건드리지 않는다(0). */
export async function scrubFile(path: string, needles: readonly string[]): Promise<number> {
  if (!needles.length) return 0;
  let info;
  try { info = await lstat(path); } catch { return 0; }
  if (!info.isFile()) return 0;
  const before = await readFile(path, 'utf8');
  const { text, replaced } = scrubText(before, needles);
  if (!replaced) return 0;
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.scrub`);
  try {
    await writeFile(tmp, text, { mode: info.mode & 0o777, flag: 'wx' });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return replaced;
}
