import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { errorText } from '../src/lib/errorText';
import { translator } from '../src/i18n';

/**
 * 서버 오류를 앱 언어로(i18n P5 ②b, security C7). 아는 code 는 사전, 모르는 code 는 서버 원문 그대로.
 */
const tEn = translator('en');
const tKo = translator('ko');

describe('errorText', () => {
  it('뜻이 code 하나로 정해지는 오류는 고른 언어의 사전 문장이다', () => {
    const e = new ApiError(409, 'handle_taken', 'an account with this handle already exists');
    expect(errorText(e, tEn)).toBe('That handle is already taken.');
    expect(errorText(e, tKo)).toBe('이미 쓰는 이름이다.');
  });

  it('모르는 code·자리마다 뜻이 다른 code 는 서버 원문을 그대로 보인다 — 「무엇이」 를 잃지 않는다', () => {
    expect(errorText(new ApiError(404, 'not_found', 'no such channel'), tKo)).toBe('no such channel');
    expect(errorText(new ApiError(400, 'brand_new_code', '새 오류'), tEn)).toBe('새 오류');
  });

  it('code 모양이 이상하거나 프로토타입 이름이면 사전을 찾지 않는다(C7)', () => {
    for (const code of ['__proto__', 'constructor', 'toString', 'Has-Caps', 'a.b', '']) {
      expect(errorText(new ApiError(400, code, 'raw'), tEn), code).toBe('raw');
    }
  });

  it('글이 없는 오류는 넘긴 대체 문구, 없으면 일반 문장', () => {
    expect(errorText(undefined, tEn, 'Could not save')).toBe('Could not save');
    expect(errorText({}, tKo)).toBe('요청이 처리되지 않았다.');
    expect(errorText(new Error('boom'), tEn)).toBe('boom');
  });
});
