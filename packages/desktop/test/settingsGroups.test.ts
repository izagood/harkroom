import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * 설정 목차는 **"누구에게 적용되나"** 네 묶음이다(UX ⑥a). 묶음 이름이 곧 범위라, 줄 하나가
 * 엉뚱한 묶음에 서면 그 약속이 깨진다 — 전에는 이 기기 설정(연결)이 `개인` 에, 워크스페이스
 * 전체(초대)와 이 기기(업데이트)가 `앱` 에 섞여 있었다(designer L2).
 */
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('설정 목차 네 묶음 (UX ⑥a)', () => {
  it('나 · 이 기기 · 워크스페이스 · 에이전트 순서이고, 줄마다 정해진 묶음에 선다', async () => {
    const { SETTINGS_GROUPS } = await import('../src/components/settings/sections');
    const byGroup = Object.fromEntries(SETTINGS_GROUPS.map((g) => [g.id, g.items.map((i) => i.id)]));
    expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual(['me', 'device', 'workspace', 'agents']);
    expect(byGroup.me).toEqual(['profile', 'notifications', 'messages', 'appearance']);
    expect(byGroup.device).toEqual(['communities', 'connection', 'updates', 'this-operator']);
    expect(byGroup.workspace).toEqual(['workspace', 'invite', 'handle-groups', 'mcp-servers']);
    expect(byGroup.agents!.filter((id) => id !== 'gallery'))
      .toEqual(['agents', 'agent-defaults', 'claude-accounts', 'operators', 'skills', 'automations']);
  });

  /** 한 줄이 두 묶음에 서거나 빠지면 그 페이지로 가는 길이 둘이거나 없다. */
  it('줄은 한 번씩만 선다', async () => {
    const { SETTINGS_GROUPS } = await import('../src/components/settings/sections');
    const ids = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  /** 개발자용 갤러리는 배포 빌드의 목차에 서지 않는다(designer L1). 화면 자체는 남는다. */
  it('배포 빌드에서는 Component gallery 가 목차에 없고, 개발 빌드에서는 맨 끝에 선다', async () => {
    vi.stubEnv('DEV', false);
    vi.resetModules();
    const prod = await import('../src/components/settings/sections');
    expect(prod.SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id))).not.toContain('gallery');
    expect(prod.isSectionId('gallery')).toBe(false);

    vi.unstubAllEnvs();
    vi.resetModules();
    const dev = await import('../src/components/settings/sections');
    const agents = dev.SETTINGS_GROUPS.find((g) => g.id === 'agents')!;
    expect(agents.items[agents.items.length - 1]!.id).toBe('gallery');
  });
});
