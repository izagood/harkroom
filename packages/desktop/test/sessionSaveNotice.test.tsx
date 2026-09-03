import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { sessionStore, type StoredSessions } from '../src/lib/session';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Notice } from '../src/components/Notice';

// #212 — 키체인 쓰기 실패의 회귀선.
//
// 여기서 지키는 것은 두 가지다. 하나는 **실패가 사람 앞에 선다**는 것: 예전에는 catch 가
// 비어 있어서, 세션이 어디에도 저장되지 않았는데 화면은 로그인 상태였고 사람은 다음 기동에
// 로그아웃된 이유를 알 방법이 없었다. 다른 하나는 **평문으로 내려가지 않는다**는 것:
// 키체인을 쓰겠다고 해놓고 조용히 localStorage 에 토큰을 남기는 것이 더 나쁘다는 판단은
// 이미 내려진 결정이고, 알림을 붙이는 과정에서 그것이 뒤집히지 않아야 한다.

/** `secret_set` 만 실패하는 키체인. 잠김·접근 거부·Secret Service 미기동이 이 모양이다. */
function lockedKeychain(): void {
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (cmd: string) => {
      if (cmd === 'secret_set') throw new Error('keychain locked');
      return null;
    }),
  };
}

/** 정상 키체인. 성공 경로에서 경고가 상시로 뜨지 않는지 보는 데 쓴다. */
function workingKeychain(): Map<string, string> {
  const vault = new Map<string, string>();
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'secret_get') return vault.get(String(args?.key)) ?? null;
      if (cmd === 'secret_set') { vault.set(String(args?.key), String(args?.value)); return null; }
      if (cmd === 'secret_delete') { vault.delete(String(args?.key)); return null; }
      throw new Error(`unknown command ${cmd}`);
    }),
  };
  return vault;
}

const sessions: StoredSessions = {
  active: 'acct_123',
  communities: [{ accountId: 'acct_123', baseUrl: 'http://x:3400', token: 'murs_secret', handle: 'testuser' }],
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  useAppStore.getState().reset();
});

describe('키체인 쓰기 실패 (#212)', () => {
  it('실패를 사람 앞에 세운다 — 조용히 삼키지 않는다', async () => {
    lockedKeychain();

    await sessionStore.save(sessions);

    render(<Notice />);
    // role="alert" 이라 스크린리더도 즉시 읽는다. 그 자리가 비어 있으면 예전의 빈 catch 다.
    expect(screen.getByRole('alert').textContent).toContain('keychain');
  });

  // 저장이 안 됐다는 사실만으로는 부족하다. 사람이 알아야 하는 것은 **다음 기동에 로그인이
  // 남지 않는다**는 것이다 — 그 말이 없으면 다음 기동의 로그아웃은 여전히 이유 없는 로그아웃이다.
  it('다음 기동에 로그인이 남지 않는다는 것을 말한다', async () => {
    lockedKeychain();

    await sessionStore.save(sessions);

    render(<Notice />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/sign in again/i);
    expect(text).toMatch(/next time you open/i);
    // 이번 실행은 계속 쓸 수 있다는 것도 같이 말한다 — 안 그러면 사람은 지금 당장 무엇을
    // 잃었는지 몰라 하던 일을 멈춘다.
    expect(text).toMatch(/keep using/i);
  });

  // 이 결정의 회귀선이다: 키체인이 막혔다고 평문으로 내려가면, 키체인을 쓴다고 해놓고
  // 조용히 토큰을 디스크에 남기는 것이 된다.
  it('실패해도 평문(localStorage)에 토큰을 쓰지 않는다', async () => {
    lockedKeychain();

    await sessionStore.save(sessions);

    expect(localStorage.getItem('murmur.sessions')).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('murs_secret');
  });

  it('성공하면 알림이 뜨지 않는다', async () => {
    const vault = workingKeychain();

    await sessionStore.save(sessions);

    expect([...vault.values()].join()).toContain('murs_secret');
    expect(useAppStore.getState().notice).toBeNull();
    render(<Notice />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
