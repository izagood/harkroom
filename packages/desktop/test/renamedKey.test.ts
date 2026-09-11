/**
 * 이름이 바뀐 저장 키의 **폴백 회귀선**(`murmur.*` → `harkroom.*`).
 *
 * 이것이 없으면 리브랜딩이 조용히 사람의 상태를 지운다: 키 이름만 바꾸면 앱은 새 키를 읽고,
 * 거기엔 아무것도 없고, 화면은 **처음 켠 것처럼** 뜬다. 설정·초안·로그인이 다 그렇게 사라진다.
 *
 * **되돌려 RED**: `getRenamedLocal` 에서 폴백 한 줄을 지우면 "옛 키만 있으면 그것을 읽는다"가
 * 빨개진다. `removeRenamedLocal` 에서 옛 키 삭제를 지우면 "지우면 둘 다 사라진다"가 빨개진다.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  deleteRenamedSecret, getRenamedLocal, getRenamedSecret, legacyKey, removeRenamedLocal,
} from '../src/lib/renamedKey';

beforeEach(() => localStorage.clear());

describe('legacyKey', () => {
  it('새 접두사를 옛 접두사로 되돌린다', () => {
    expect(legacyKey('harkroom.prefs')).toBe('murmur.prefs');
    expect(legacyKey('harkroom.runner.pat.abc')).toBe('murmur.runner.pat.abc');
  });

  // 접두사가 아닌 키에는 폴백할 자리가 없다 — `null` 이 그 사실이다.
  it('새 접두사가 아니면 null', () => {
    expect(legacyKey('murmur.session')).toBeNull();
    expect(legacyKey('something.else')).toBeNull();
  });
});

describe('localStorage 폴백', () => {
  it('새 키가 있으면 그것을 읽는다', () => {
    localStorage.setItem('harkroom.prefs', 'new');
    localStorage.setItem('murmur.prefs', 'old');
    expect(getRenamedLocal('harkroom.prefs')).toBe('new');
  });

  it('옛 키만 있으면 그것을 읽는다 — 이것이 이 파일의 존재 이유다', () => {
    localStorage.setItem('murmur.prefs', 'old');
    expect(getRenamedLocal('harkroom.prefs')).toBe('old');
  });

  it('둘 다 없으면 null', () => {
    expect(getRenamedLocal('harkroom.prefs')).toBeNull();
  });

  // 로그아웃이 옛 자리를 남겨 두면 그것은 지운 것이 아니다.
  it('지우면 둘 다 사라진다', () => {
    localStorage.setItem('harkroom.prefs', 'new');
    localStorage.setItem('murmur.prefs', 'old');
    removeRenamedLocal('harkroom.prefs');
    expect(localStorage.getItem('harkroom.prefs')).toBeNull();
    expect(localStorage.getItem('murmur.prefs')).toBeNull();
  });
});

describe('키체인 폴백', () => {
  const store = (init: Record<string, string>) => {
    const vault = new Map(Object.entries(init));
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      const key = String(args?.key ?? '');
      if (cmd === 'secret_get') return vault.get(key) ?? null;
      if (cmd === 'secret_delete') { vault.delete(key); return null; }
      return null;
    });
    return { vault, invoke };
  };

  it('새 키가 있으면 옛 키를 두드리지 않는다', async () => {
    const { invoke } = store({ 'harkroom.sessions': 'new' });
    expect(await getRenamedSecret(invoke, 'harkroom.sessions')).toBe('new');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('옛 키만 있으면 그것을 읽는다', async () => {
    const { invoke } = store({ 'murmur.sessions': 'old' });
    expect(await getRenamedSecret(invoke, 'harkroom.sessions')).toBe('old');
  });

  it('지우면 둘 다 사라진다', async () => {
    const { vault, invoke } = store({ 'harkroom.sessions': 'new', 'murmur.sessions': 'old' });
    await deleteRenamedSecret(invoke, 'harkroom.sessions');
    expect(vault.size).toBe(0);
  });

  /**
   * 옛 키 삭제가 실패해도 로그아웃은 성공해야 한다 — 대부분 애초에 없고, 그 실패로 전체가
   * 실패하면 사람은 **새 키가 지워졌다는 사실까지** 못 믿게 된다.
   */
  it('옛 키 삭제가 던져도 새 키 삭제는 유지된다', async () => {
    const vault = new Map([['harkroom.sessions', 'new']]);
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      const key = String(args?.key ?? '');
      if (cmd === 'secret_delete' && key.startsWith('murmur.')) throw new Error('없음');
      if (cmd === 'secret_delete') { vault.delete(key); return null; }
      return null;
    });
    await expect(deleteRenamedSecret(invoke, 'harkroom.sessions')).resolves.toBeUndefined();
    expect(vault.size).toBe(0);
  });
});
