import { describe, expect, it, vi } from 'vitest';
import { AUTO_REGISTER_NAME, autoRegisterFirstOperator, type AutoRegisterDeps } from './autoRegisterOperator';

const BASE = 'https://example.test';

type Spied = AutoRegisterDeps & {
  register: ReturnType<typeof vi.fn>;
  mintCode: ReturnType<typeof vi.fn>;
  markAutoRegistered: ReturnType<typeof vi.fn>;
};

function deps(over: Partial<AutoRegisterDeps> = {}): Spied {
  return {
    baseUrl: BASE,
    canRegister: true,
    canManage: true,
    listLocal: async () => ({ communities: [] }),
    wasAutoRegistered: () => false,
    markAutoRegistered: vi.fn(),
    mintCode: vi.fn(async () => ({ code: 'hkreg_test' })),
    register: vi.fn(async () => ({ name: 'mac' })),
    ...over,
  } as never;
}

describe('autoRegisterFirstOperator — 이 기계가 이 커뮤니티에 없으면 등록(격리 C P8)', () => {
  it('새 앱(로컬 등록 없음)이면 코드를 발급해 이 기계에 넘기고 표시한다', async () => {
    const d = deps();
    expect(await autoRegisterFirstOperator(d)).toBe('registered');
    expect(d.mintCode).toHaveBeenCalledTimes(1);
    expect(d.register).toHaveBeenCalledWith(BASE, 'hkreg_test', AUTO_REGISTER_NAME);
    expect(d.markAutoRegistered).toHaveBeenCalledWith(BASE);
  });

  it('다른 기기가 이미 선 커뮤니티여도 이 기계가 없으면 등록한다 — 서버 목록은 묻지 않는다', async () => {
    const d = deps();
    expect('listOperators' in d).toBe(false);
    expect(await autoRegisterFirstOperator(d)).toBe('registered');
  });

  it('로컬 설정에 다른 커뮤니티만 있으면 이 커뮤니티는 아직 아니다 — 등록한다', async () => {
    const d = deps({ listLocal: async () => ({ communities: [{ baseUrl: 'https://other.test', registered: true }] }) });
    expect(await autoRegisterFirstOperator(d)).toBe('registered');
  });

  it('로컬 칸은 있지만 등록 전(registered: false)이면 등록한다', async () => {
    const d = deps({ listLocal: async () => ({ communities: [{ baseUrl: BASE, registered: false }] }) });
    expect(await autoRegisterFirstOperator(d)).toBe('registered');
  });

  it('이 기계가 이미 이 커뮤니티에 등록돼 있으면 하지 않고, 표시만 남긴다(나중에 빼도 되살리지 않게)', async () => {
    const d = deps({ listLocal: async () => ({ communities: [{ baseUrl: `${BASE}/`, registered: true }] }) });
    expect(await autoRegisterFirstOperator(d)).toBe('already-local');
    expect(d.register).not.toHaveBeenCalled();
    expect(d.markAutoRegistered).toHaveBeenCalledWith(BASE);
  });

  it('한 번 자동으로 세운 커뮤니티는 다시 하지 않는다 — 사람이 뺀 뒤에도', async () => {
    const listLocal = vi.fn(async () => ({ communities: [] }));
    const d = deps({ wasAutoRegistered: () => true, listLocal });
    expect(await autoRegisterFirstOperator(d)).toBe('done-before');
    expect(listLocal).not.toHaveBeenCalled();
    expect(d.mintCode).not.toHaveBeenCalled();
  });

  it('등록 능력이 없으면 하지 않는다', async () => {
    const d = deps({ canRegister: false });
    expect(await autoRegisterFirstOperator(d)).toBe('no-capability');
    expect(d.mintCode).not.toHaveBeenCalled();
  });

  it('member(operator.manage 없음)는 하지 않는다 — 기기 이름을 동의 없이 올리지 않는다', async () => {
    const listLocal = vi.fn(async () => ({ communities: [] }));
    const d = deps({ canManage: false, listLocal });
    expect(await autoRegisterFirstOperator(d)).toBe('no-capability');
    expect(listLocal).not.toHaveBeenCalled();
    expect(d.mintCode).not.toHaveBeenCalled();
    expect(d.register).not.toHaveBeenCalled();
  });

  it('로컬 설정을 못 읽으면 모르는 채로 등록하지 않고 표시도 남기지 않는다', async () => {
    const d = deps({ listLocal: async () => { throw new Error('socket'); } });
    expect(await autoRegisterFirstOperator(d)).toBe('unknown');
    expect(d.mintCode).not.toHaveBeenCalled();
    expect(d.markAutoRegistered).not.toHaveBeenCalled();
  });

  it('등록이 실패하면 표시하지 않는다 — 다음 기동에 다시 시도한다', async () => {
    const d = deps({ register: vi.fn(async () => { throw new Error('코드 만료'); }) });
    await expect(autoRegisterFirstOperator(d)).rejects.toThrow('코드 만료');
    expect(d.markAutoRegistered).not.toHaveBeenCalled();
  });

  it('서버 주소가 없으면 하지 않는다', async () => {
    expect(await autoRegisterFirstOperator(deps({ baseUrl: null }))).toBe('no-server');
  });

  it('자동 등록은 hostname 이 아니라 중립 이름을 넘긴다(security #1651 F1)', async () => {
    const d = deps();
    await autoRegisterFirstOperator(d);
    const name = (d.register as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[2];
    expect(name).toBe('Harkroom desktop');
    expect(typeof name === 'string' && /mac|book|'s|의/i.test(name)).toBe(false);
  });
});
