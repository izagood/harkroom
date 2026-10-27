import { describe, expect, it, vi } from 'vitest';
import { autoRegisterFirstOperator, type AutoRegisterDeps } from './autoRegisterOperator';

const BASE = 'https://example.test';

function deps(over: Partial<AutoRegisterDeps> = {}): AutoRegisterDeps & { register: ReturnType<typeof vi.fn>; mintCode: ReturnType<typeof vi.fn> } {
  return {
    baseUrl: BASE,
    canRegister: true,
    listLocal: async () => ({ communities: [] }),
    listOperators: async () => [],
    mintCode: vi.fn(async () => ({ code: 'hkreg_test' })),
    register: vi.fn(async () => ({ name: 'mac' })),
    ...over,
  } as never;
}

describe('autoRegisterFirstOperator — 첫 설치에서 이 머신을 등록', () => {
  it('빈 커뮤니티 + 새 앱(로컬 등록 없음)이면 코드를 발급해 이 머신에 넘긴다', async () => {
    const d = deps();
    expect(await autoRegisterFirstOperator(d)).toBe('registered');
    expect(d.mintCode).toHaveBeenCalledTimes(1);
    expect(d.register).toHaveBeenCalledWith(BASE, 'hkreg_test');
  });

  it('로컬 설정에 다른 커뮤니티만 있으면 이 커뮤니티는 아직 아니다 — 등록한다', async () => {
    const d = deps({ listLocal: async () => ({ communities: [{ baseUrl: 'https://other.test', registered: true }] }) });
    expect(await autoRegisterFirstOperator(d)).toBe('registered');
  });

  it('이 머신이 이미 이 커뮤니티에 등록돼 있으면 하지 않는다', async () => {
    const d = deps({ listLocal: async () => ({ communities: [{ baseUrl: BASE, registered: true }] }) });
    expect(await autoRegisterFirstOperator(d)).toBe('already-local');
    expect(d.register).not.toHaveBeenCalled();
  });

  it('커뮤니티에 다른 오퍼레이터가 있으면 사람이 정한다 — 하지 않는다', async () => {
    const d = deps({ listOperators: async () => [{ id: 'op-1' }] });
    expect(await autoRegisterFirstOperator(d)).toBe('community-has-operators');
    expect(d.mintCode).not.toHaveBeenCalled();
  });

  it('등록 능력이 없으면 하지 않는다', async () => {
    const d = deps({ canRegister: false });
    expect(await autoRegisterFirstOperator(d)).toBe('no-capability');
    expect(d.mintCode).not.toHaveBeenCalled();
  });

  it('목록을 못 읽으면 모르는 채로 등록하지 않는다', async () => {
    const d = deps({ listOperators: async () => { throw new Error('503'); } });
    expect(await autoRegisterFirstOperator(d)).toBe('unknown');
    expect(d.mintCode).not.toHaveBeenCalled();
  });

  it('서버 주소가 없으면 하지 않는다', async () => {
    expect(await autoRegisterFirstOperator(deps({ baseUrl: null }))).toBe('no-server');
  });
});
