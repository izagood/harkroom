/**
 * 설정 › 나 › 비밀과 API — 비밀 절(외부 API 권한 C안 P1). 판정은 전부 서버다. 여기서 재는 것:
 * 목록이 응답을 앉히는가, 넣기가 서버 몸체 그대로 가고 **값이 화면에 다시 나오지 않는가**, 설명 거절이 사람 말로
 * 보이는가, 지우기·거두기가 확인창을 거치는가, 소유자가 아니면 [주기] 가 없는가, 보관소가 꺼진 서버를 말하는가.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { SecretsSettings } from '../src/components/settings/SecretsSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError, type SecretView } from '../src/lib/api';
import { acc } from './helpers/fakeApi';

const ME = 'owner-1';
const secret = (name: string, over: Partial<SecretView> = {}): SecretView => ({
  id: `id-${name}`, name, kind: 'text', filename: null, description: '', ownerAccountId: ME,
  expiresAt: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', version: 1, sizeBytes: 10, grantCount: 0, ...over,
});

function setup(over: Partial<Record<string, unknown>> = {}, initial: SecretView[] = [secret('api-token', { description: 'API token', grantCount: 1 })], enabled = true) {
  let rows = initial;
  const c = {
    listSecrets: vi.fn(async () => ({ enabled, secrets: rows })),
    createSecret: vi.fn(async (b: { name: string }) => { const s = secret(b.name); rows = [...rows, s]; return s; }),
    replaceSecretValue: vi.fn(async () => rows[0]),
    deleteSecret: vi.fn(async (id: string) => { rows = rows.filter((s) => s.id !== id); }),
    listSecretGrants: vi.fn(async () => [{ id: 'g1', agentId: 'agent-1', channelId: null, operatorId: 'op-1', grantedBy: ME, grantedAt: '2026-10-02T00:00:00Z', suspendedAt: null, suspendReason: null }]),
    putSecretGrant: vi.fn(async () => undefined),
    deleteSecretGrant: vi.fn(async () => undefined),
    listSecretAccess: vi.fn(async () => []),
    ...over,
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({
    me: acc(ME, 'owner'),
    accounts: { [ME]: acc(ME, 'owner'), 'agent-1': acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME }), 'agent-2': acc('agent-2', 'beta', 'agent', false, { ownerAccountId: 'other-1' }), 'other-1': acc('other-1', 'carol'), 'agent-3': acc('agent-3', 'gamma', 'agent', false, { ownerAccountId: ME }) },
  });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

/** 줄을 펼친다(받는 에이전트 탭이 먼저 열린다 — designer 시안 v1 D2). */
async function expand(name: string) {
  fireEvent.click(await screen.findByTestId(`secret-expand-${name}`));
}
/** ⋯ 메뉴에서 항목을 고른다(값 바꾸기·접근 기록·지우기… — D1). */
async function menu(name: string, item: string) {
  fireEvent.click(await screen.findByTestId(`secret-more-${name}`));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}

/** 「+ 에이전트 추가」 팝오버에서 handle 로 고른다(OS select 대신 — designer 시안 v1 #1). */
function pickAgent(handle: string) {
  if (!screen.queryByTestId('secret-agent-picker')) fireEvent.click(screen.getByTestId('secret-agent-add'));
  fireEvent.click(screen.getByTestId(`secret-agent-option-${handle}`));
}

describe('SecretsSettings', () => {
  it('목록: 이름·쓰는 곳·만료를 앉히고 값은 어디에도 없다', async () => {
    setup();
    render(<SecretsSettings />);
    const row = await screen.findByTestId('secret-api-token');
    expect(row.textContent).toContain('api-token');
    expect(row.textContent).toContain('에이전트 1');
    expect(screen.getByTestId('secret-used-api-token').getAttribute('title')).toBe('쓰는 곳: 에이전트 1');
    expect(row.textContent).toContain('만료 없음');
    // designer m1: 줄마다 따로 격자라 열 폭을 고정해야 쓰는 곳·만료 열이 줄끼리 맞는다(auto 금지).
    const line = screen.getByTestId('secret-expand-api-token').parentElement as HTMLElement;
    expect(line.className).toContain('sm:grid-cols-[16px_minmax(0,1fr)_7.5rem_7.5rem]');
    expect(line.className).not.toMatch(/sm:grid-cols-\[[^\]]*_auto/);
  });

  it('만료된 비밀은 표시되고 [주기] 가 없다', async () => {
    setup({}, [secret('old', { expiresAt: '2026-01-01T00:00:00Z' })]);
    render(<SecretsSettings />);
    const row = await screen.findByTestId('secret-old');
    expect(row.textContent).toContain('만료됨');
    await expand('old');
    await screen.findByTestId('secret-grants');
    expect(screen.queryByTestId('secret-agent-add')).toBeNull();
  });

  it('넣기: 서버 몸체 그대로 보내고, 보낸 뒤 값 칸을 비운다', async () => {
    const c = setup({}, []);
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '+ 비밀 넣기' }));
    const form = screen.getByTestId('secret-create');
    fireEvent.change(within(form).getAllByRole('textbox')[0]!, { target: { value: 'api-token' } });
    const value = within(form).getByLabelText('값') as HTMLInputElement;
    expect(value.type).toBe('password');
    fireEvent.change(value, { target: { value: 's3cr3t-value' } });
    fireEvent.click(within(form).getByRole('radio', { name: '없음' }));
    fireEvent.click(within(form).getByRole('button', { name: '넣기' }));
    await waitFor(() => expect(c.createSecret).toHaveBeenCalledWith({ name: 'api-token', kind: 'text', description: '', expiresAt: null, value: 's3cr3t-value' }));
    await waitFor(() => expect(screen.queryByTestId('secret-create')).toBeNull());
    expect(document.body.textContent).not.toContain('s3cr3t-value');
  });

  it('이름 규칙에 어긋나면 [넣기] 가 꺼진다', async () => {
    setup({}, []);
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '+ 비밀 넣기' }));
    const form = screen.getByTestId('secret-create');
    fireEvent.change(within(form).getAllByRole('textbox')[0]!, { target: { value: 'Bad.Name' } });
    fireEvent.change(within(form).getByLabelText('값'), { target: { value: 'v' } });
    expect((within(form).getByRole('button', { name: '넣기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('설명 거절(secret_in_description)을 사람 말로 옮긴다', async () => {
    setup({ createSecret: vi.fn(async () => { throw new ApiError(400, 'secret_in_description', 'x'); }) }, []);
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '+ 비밀 넣기' }));
    const form = screen.getByTestId('secret-create');
    fireEvent.change(within(form).getAllByRole('textbox')[0]!, { target: { value: 'k' } });
    fireEvent.change(within(form).getByLabelText('값'), { target: { value: 'v' } });
    fireEvent.click(within(form).getByRole('button', { name: '넣기' }));
    expect((await screen.findByTestId('secrets-error')).textContent).toContain('설명은 에이전트에게 보이니');
  });

  it('지우기는 확인창을 거치고, 쓰는 곳이 있으면 멈춘다고 말한다', async () => {
    const c = setup();
    render(<SecretsSettings />);
    await menu('api-token', '지우기…');
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('다음 턴부터 멈춘다');
    expect(c.deleteSecret).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(c.deleteSecret).toHaveBeenCalledWith('id-api-token'));
  });

  it('받을 에이전트: 소유자는 주고, 거두기는 확인창을 거친다', async () => {
    const c = setup();
    render(<SecretsSettings />);
    await expand('api-token');
    await screen.findByTestId('secret-grant-alpha');
    pickAgent('gamma');
    fireEvent.click(screen.getByRole('button', { name: '주기' }));
    await waitFor(() => expect(c.putSecretGrant).toHaveBeenCalledWith('id-api-token', { agentId: 'agent-3', channelId: null, operator: 'current' }));
    // C: 받는 에이전트 줄 — 범위는 칩 둘(「모든 채널」「이 머신만」), [거두기]는 hover·포커스·터치에서만 드러난다.
    const grantRow = screen.getByTestId('secret-grant-alpha');
    expect(within(grantRow).getByTestId('secret-grant-scope').textContent).toBe('모든 채널');
    expect(within(grantRow).getByTestId('secret-grant-machine').textContent).toBe('이 머신만');
    const revoke = screen.getByRole('button', { name: '@alpha 에게서 거두기' });
    expect(revoke.className).toContain('opacity-0');
    expect(revoke.className).toContain('group-hover:opacity-100');
    expect(revoke.className).toContain('focus-visible:opacity-100');
    expect(revoke.className).toContain('[@media(hover:none)]:opacity-100');
    fireEvent.click(revoke);
    // 확인창 문구는 그대로다(security C 확인 항목).
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('@alpha 에게 api-token 주기를 멈출까?');
    expect(dlg.textContent).toContain('다음 마운트부터 받지 못한다.');
    fireEvent.click(within(dlg).getByRole('button', { name: '거두기' }));
    await waitFor(() => expect(c.deleteSecretGrant).toHaveBeenCalledWith('id-api-token', 'g1'));
  });

  it('#1156 앞의 옛 줄: 받는 에이전트의 소유자가 비밀 주인과 다르면 「소유자가 달라 막힘」 배지', async () => {
    setup({ listSecretGrants: vi.fn(async () => [
      { id: 'g1', agentId: 'agent-1', channelId: null, operatorId: null, grantedBy: ME, grantedAt: '2026-10-02T00:00:00Z', suspendedAt: null, suspendReason: null },
      { id: 'g2', agentId: 'agent-2', channelId: null, operatorId: null, grantedBy: ME, grantedAt: '2026-10-02T00:00:00Z', suspendedAt: null, suspendReason: null },
    ]) });
    render(<SecretsSettings />);
    await expand('api-token');
    await screen.findByTestId('secret-grant-beta');
    expect(screen.getByTestId('secret-grant-not-own-beta').textContent).toContain('소유자가 달라 막힘');
    expect(screen.queryByTestId('secret-grant-not-own-alpha')).toBeNull();
  });

  it('부여: 고르기 전엔 경고가 없고, 고른 뒤 확인 줄에 「모든 스레드」 한 줄 — 어느 오퍼레이터든이면 한 줄 더', async () => {
    const c = setup();
    render(<SecretsSettings />);
    await expand('api-token');
    await screen.findByTestId('secret-grant-alpha');
    expect(screen.queryByTestId('secret-grants-all-channels')).toBeNull();
    expect(screen.queryByRole('button', { name: '주기' })).toBeNull();
    pickAgent('gamma');
    const confirm = screen.getByTestId('secret-grant-confirm');
    expect(within(confirm).getByText('@gamma 에게')).toBeTruthy();
    const note = screen.getByTestId('secret-grants-all-channels');
    // security #1266 n3: 경고가 [주기] 보다 먼저 읽힌다(문서 순서).
    expect(note.compareDocumentPosition(within(confirm).getByRole('button', { name: '주기' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.textContent).toContain('모든 스레드에서');
    expect(within(note).getByText('모든 스레드').tagName).toBe('STRONG');
    expect(screen.queryByTestId('secret-grant-any-warn')).toBeNull();
    // designer n1: 고른 뒤 초점은 세그먼트의 골라진 칸 — 여는 단추도 [주기]도 아니다.
    const cur = within(confirm).getByRole('radio', { name: '이 머신만' });
    expect(document.activeElement).toBe(cur);
    expect(cur.tabIndex).toBe(0);
    // designer n3: ←→ 로 옮긴다.
    fireEvent.keyDown(cur, { key: 'ArrowRight' });
    const any = within(confirm).getByRole('radio', { name: '어느 머신이든' });
    expect(any.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(any);
    expect(cur.tabIndex).toBe(-1);
    expect(screen.getByTestId('secret-grant-any-warn').textContent).toContain('앞으로 배정되는 머신');
    fireEvent.click(within(confirm).getByRole('button', { name: '주기' }));
    await waitFor(() => expect(c.putSecretGrant).toHaveBeenCalledWith('id-api-token', { agentId: 'agent-3', channelId: null, operator: 'any' }));
    // [취소] 는 확인 줄을 닫는다.
    pickAgent('gamma');
    fireEvent.click(within(screen.getByTestId('secret-grant-confirm')).getByRole('button', { name: '취소' }));
    expect(screen.queryByTestId('secret-grant-confirm')).toBeNull();
  });

  it('고르기 팝오버: 내 에이전트만, 이미 받는 에이전트는 「받는 중」으로 못 고르고, 검색·↑↓·Enter·Esc', async () => {
    setup();
    render(<SecretsSettings />);
    await expand('api-token');
    await screen.findByTestId('secret-grant-alpha');
    const trigger = screen.getByTestId('secret-agent-add');
    expect(trigger.textContent).toBe('+ 에이전트 추가');
    fireEvent.click(trigger);
    const pop = screen.getByTestId('secret-agent-picker');
    const list = within(pop).getByRole('listbox', { name: '내 에이전트' });
    // 남의 에이전트(@beta, 소유자 carol)는 목록에 없다 — 서버도 not_own_agent 로 거절한다.
    expect(list.textContent).not.toContain('@beta');
    const alpha = screen.getByTestId('secret-agent-option-alpha');
    expect(alpha.getAttribute('aria-disabled')).toBe('true');
    expect(alpha.textContent).toContain('받는 중');
    fireEvent.click(alpha);
    expect(screen.queryByTestId('secret-grant-confirm')).toBeNull();
    // 첫 고를 수 있는 줄이 활성 — Enter 면 @gamma.
    const input = within(pop).getByRole('combobox', { name: '에이전트 찾기' });
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId('secret-agent-option-gamma').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByTestId('secret-agent-option-gamma').getAttribute('aria-selected')).toBe('true');
    // 검색: 맞는 것이 없으면 그렇게 말한다.
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(pop.textContent).toContain('맞는 에이전트가 없다.');
    fireEvent.change(input, { target: { value: '@gam' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByTestId('secret-agent-picker')).toBeNull();
    expect(within(screen.getByTestId('secret-grant-confirm')).getByText('@gamma 에게')).toBeTruthy();
    // Esc 는 닫고 초점을 여는 단추로 돌린다.
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('combobox', { name: '에이전트 찾기' }), { key: 'Escape' });
    expect(screen.queryByTestId('secret-agent-picker')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // 에이전트가 만든 비밀(서버 102, security L2): 값을 정한 에이전트는 값을 안다 — 배지와, 다른 에이전트에게 넓힐 때 경고.
  it('L2: 값을 에이전트가 정했으면 「값을 @x 가 정함」, 사람이 바꿨으면 「@x 가 만듦」, 사람 비밀·옛 서버는 배지 없음', async () => {
    setup({}, [
      secret('made', { createdByAgentId: 'agent-1', valueSetByAgentId: 'agent-1' }),
      secret('adopted', { createdByAgentId: 'agent-1', valueSetByAgentId: null }),
      secret('human', { createdByAgentId: null, valueSetByAgentId: null }),
      secret('legacy'),
    ]);
    render(<SecretsSettings />);
    const made = await screen.findByTestId('secret-made');
    expect(within(made).getByTestId('secret-value-by-agent').textContent).toBe('값을 @alpha 가 정함');
    expect(within(screen.getByTestId('secret-adopted')).getByTestId('secret-by-agent').textContent).toBe('@alpha 가 만듦');
    expect(within(screen.getByTestId('secret-adopted')).queryByTestId('secret-value-by-agent')).toBeNull();
    for (const n of ['human', 'legacy']) {
      expect(within(screen.getByTestId(`secret-${n}`)).queryByTestId('secret-by-agent')).toBeNull();
      expect(within(screen.getByTestId(`secret-${n}`)).queryByTestId('secret-value-by-agent')).toBeNull();
    }
  });

  it('L2: 값을 정한 에이전트가 아닌 에이전트에게 주려 하면 경고한다 — 그 에이전트 자신에게는 경고하지 않는다', async () => {
    // @alpha 가 아직 받지 않은 비밀 — 받는 중이면 고르기에서 흐리게 막힌다.
    setup({ listSecretGrants: vi.fn(async () => []) }, [secret('made', { createdByAgentId: 'agent-1', valueSetByAgentId: 'agent-1' })]);
    render(<SecretsSettings />);
    await expand('made');
    await screen.findByText('아직 받는 에이전트가 없다.');
    // 고르기 전에는 안내가 없다(designer n2 — 폼 위에 세 줄이 겹치지 않게).
    expect(screen.queryByTestId('secret-adopt-note')).toBeNull();
    expect(screen.queryByTestId('secret-widen-warn')).toBeNull();
    pickAgent('alpha');
    expect(screen.getByTestId('secret-adopt-note').textContent).toContain('@alpha 는 이 비밀을 더 이상 회전할 수 없다');
    expect(screen.queryByTestId('secret-widen-warn')).toBeNull();
    pickAgent('gamma');
    expect(screen.getByTestId('secret-widen-warn').textContent).toBe('@alpha 가 정한 값이라 @alpha 도 알고 있다. 다른 에이전트에게 주기 전에 [값 바꾸기]를 권한다.');
  });

  it('n3: targetId 로 열면 그 비밀 줄로 스크롤하고 잠깐 강조한다 — 없는 id 면 아무것도 안 한다', async () => {
    const scroll = vi.fn();
    const orig = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scroll;
    try {
      setup({}, [secret('a'), secret('b')]);
      render(<SecretsSettings targetId="id-b" />);
      const b = await screen.findByTestId('secret-b');
      await waitFor(() => expect(b.getAttribute('data-flash')).toBe('true'));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(b);
      expect(screen.getByTestId('secret-a').getAttribute('data-flash')).toBeNull();
      cleanup();
      scroll.mockClear();
      setup({}, [secret('a')]);
      render(<SecretsSettings targetId="gone" />);
      await screen.findByTestId('secret-a');
      expect(scroll).not.toHaveBeenCalled();
      expect(screen.getByTestId('secret-a').getAttribute('data-flash')).toBeNull();
    } finally {
      HTMLElement.prototype.scrollIntoView = orig;
    }
  });

  it('가린 입력은 new-password 로 자동 채우기를 막는다', async () => {
    setup({}, []);
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '+ 비밀 넣기' }));
    expect(screen.getByLabelText('값').getAttribute('autocomplete')).toBe('new-password');
  });

  it('남의 비밀(admin 이 보는 것)에는 값 바꾸기·주기가 없다', async () => {
    setup({}, [secret('theirs', { ownerAccountId: 'someone' })]);
    render(<SecretsSettings />);
    const row = await screen.findByTestId('secret-theirs');
    fireEvent.click(within(row).getByTestId('secret-more-theirs'));
    expect(screen.queryByRole('menuitem', { name: '값 바꾸기' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: '접근 기록' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await expand('theirs');
    await screen.findByTestId('secret-grants');
    expect(screen.queryByTestId('secret-agent-add')).toBeNull();
  });

  it('API 연결 빈 상태는 한 문단으로 무엇이 좋은지 말한다 — 설명 줄은 목록이 있을 때만', async () => {
    setup({ listConnectors: vi.fn(async () => []) });
    render(<SecretsSettings />);
    const none = await screen.findByTestId('connectors-none');
    expect(none.textContent).toContain('키를 보지 않고도');
    expect(screen.getByTestId('connectors').textContent).not.toContain('연결 이름과 경로만 쓴다');
  });

  it('보관소가 꺼진 서버면 그렇게 말하고 넣기가 없다', async () => {
    setup({}, [], false);
    render(<SecretsSettings />);
    await screen.findByTestId('secrets-disabled');
    expect(screen.queryByRole('button', { name: '+ 비밀 넣기' })).toBeNull();
  });
});
