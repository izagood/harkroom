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

describe('SecretsSettings', () => {
  it('목록: 이름·쓰는 곳·만료를 앉히고 값은 어디에도 없다', async () => {
    setup();
    render(<SecretsSettings />);
    const row = await screen.findByTestId('secret-api-token');
    expect(row.textContent).toContain('api-token');
    expect(row.textContent).toContain('쓰는 곳: 에이전트 1');
    expect(row.textContent).toContain('만료 없음');
  });

  it('만료된 비밀은 표시되고 [주기] 가 없다', async () => {
    setup({}, [secret('old', { expiresAt: '2026-01-01T00:00:00Z' })]);
    render(<SecretsSettings />);
    const row = await screen.findByTestId('secret-old');
    expect(row.textContent).toContain('만료됨');
    fireEvent.click(within(row).getByRole('button', { name: '받을 에이전트' }));
    await screen.findByTestId('secret-grants');
    expect(screen.queryByRole('button', { name: '주기' })).toBeNull();
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
    fireEvent.click(await screen.findByRole('button', { name: '비밀 api-token 지우기' }));
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('다음 턴부터 멈춘다');
    expect(c.deleteSecret).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: '지우기' }));
    await waitFor(() => expect(c.deleteSecret).toHaveBeenCalledWith('id-api-token'));
  });

  it('받을 에이전트: 소유자는 주고, 거두기는 확인창을 거친다', async () => {
    const c = setup();
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '받을 에이전트' }));
    await screen.findByTestId('secret-grant-alpha');
    fireEvent.change(screen.getByLabelText('에이전트'), { target: { value: 'agent-3' } });
    fireEvent.click(screen.getByRole('button', { name: '주기' }));
    await waitFor(() => expect(c.putSecretGrant).toHaveBeenCalledWith('id-api-token', { agentId: 'agent-3', channelId: null, operator: 'current' }));
    fireEvent.click(screen.getByRole('button', { name: '@alpha 에게서 거두기' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '거두기' }));
    await waitFor(() => expect(c.deleteSecretGrant).toHaveBeenCalledWith('id-api-token', 'g1'));
  });

  it('부여 패널: 모든 채널 경고, 내 에이전트만 고를 수 있고, 어느 오퍼레이터든 경고', async () => {
    setup();
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '받을 에이전트' }));
    await screen.findByTestId('secret-grant-alpha');
    expect(screen.getByTestId('secret-grants-all-channels').textContent).toContain('모든 스레드에서');
    const sel = screen.getByLabelText('에이전트');
    expect(within(sel).getByRole('group', { name: '내 에이전트' }).textContent).toContain('@alpha');
    // 남의 에이전트(@beta, 소유자 carol)는 목록에 없다 — 서버도 not_own_agent 로 거절한다.
    expect(sel.textContent).not.toContain('@beta');
    expect(screen.queryByTestId('secret-grant-any-warn')).toBeNull();
    fireEvent.change(screen.getByLabelText('오퍼레이터'), { target: { value: 'any' } });
    expect(screen.getByTestId('secret-grant-any-warn').textContent).toContain('앞으로 배정되는 머신');
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
    setup({}, [secret('made', { createdByAgentId: 'agent-1', valueSetByAgentId: 'agent-1' })]);
    render(<SecretsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '받을 에이전트' }));
    await screen.findByTestId('secret-grant-alpha');
    // 고르기 전에는 안내가 없다(designer n2 — 폼 위에 세 줄이 겹치지 않게).
    expect(screen.queryByTestId('secret-adopt-note')).toBeNull();
    expect(screen.queryByTestId('secret-widen-warn')).toBeNull();
    fireEvent.change(screen.getByLabelText('에이전트'), { target: { value: 'agent-1' } });
    expect(screen.getByTestId('secret-adopt-note').textContent).toContain('@alpha 는 이 비밀을 더 이상 회전할 수 없다');
    expect(screen.queryByTestId('secret-widen-warn')).toBeNull();
    fireEvent.change(screen.getByLabelText('에이전트'), { target: { value: 'agent-3' } });
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
    expect(within(row).queryByRole('button', { name: '값 바꾸기' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: '받을 에이전트' }));
    await screen.findByTestId('secret-grants');
    expect(screen.queryByRole('button', { name: '주기' })).toBeNull();
  });

  it('보관소가 꺼진 서버면 그렇게 말하고 넣기가 없다', async () => {
    setup({}, [], false);
    render(<SecretsSettings />);
    await screen.findByTestId('secrets-disabled');
    expect(screen.queryByRole('button', { name: '+ 비밀 넣기' })).toBeNull();
  });
});
