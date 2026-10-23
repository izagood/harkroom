import { randomInt } from 'node:crypto';
import { hashToken } from '../auth/tokens.js';

/**
 * 비밀번호 재설정 코드(스레드 a6017542, designer 시안 R3·R4).
 *
 * - 12자, 헷갈리는 글자(0·O·1·I·L)를 뺀 대문자+숫자 31개에서 고른다 — 말이나 사진으로 옮겨 적어도
 *   틀리지 않게. 31^12 ≈ 2^59 라 30분 수명·리밋 아래서 맞히기는 현실적이지 않다.
 * - 보여 줄 때만 4-4-4 로 묶는다. 입력은 하이픈·공백·대소문자를 무시한다(`normalizeResetCode`).
 * - 저장은 정규화한 값의 해시만(`hashToken` — `session`·`invite` 와 같은 규칙).
 */
export const RESET_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const RESET_CODE_LENGTH = 12;
/** 수명 30분(소유자 D2). */
export const RESET_CODE_TTL_MS = 30 * 60_000;

export function newResetCode(): { code: string; display: string; hash: string } {
  let code = '';
  for (let i = 0; i < RESET_CODE_LENGTH; i += 1) code += RESET_CODE_ALPHABET[randomInt(RESET_CODE_ALPHABET.length)];
  return { code, display: `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`, hash: hashToken(code) };
}

/** 사람이 친 코드를 저장 꼴로 — 하이픈·공백을 지우고 대문자로. 길이·글자가 틀리면 null(조회하지 않는다). */
export function normalizeResetCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').toUpperCase();
  if (s.length !== RESET_CODE_LENGTH) return null;
  for (const ch of s) if (!RESET_CODE_ALPHABET.includes(ch)) return null;
  return s;
}
