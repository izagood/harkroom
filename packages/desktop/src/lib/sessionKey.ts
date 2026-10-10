import { getController } from '../state/controller';
import { sessionNumber } from './sessionEnd';

/**
 * 컨트롤러(=커뮤니티 세션 하나)에 묶인 캐시 키. 커뮤니티마다 토큰·서버가 다르므로 한 세션이 받은 것을
 * 다른 세션이 빌려 쓰지 않게 키에 세션을 넣는다. 로그아웃 뒤 새 컨트롤러는 새 번호라 옛 것을 못 본다.
 * 세션이 끝나면(`stop()`) 그 번호의 항목은 캐시가 비운다(`sessionEnd.ts`).
 * 컨트롤러가 없으면(로그아웃 직후·시험) null — 부르는 쪽은 캐시 없이 지나간다.
 */
export function sessionScopedKey(id: string): string | null {
  let c: object;
  try { c = getController(); } catch { return null; }
  if (!c) return null;
  return `${sessionPrefix(sessionNumber(c))}${id}`;
}

export function sessionPrefix(sessionNo: number): string {
  return `${sessionNo}\n`;
}
