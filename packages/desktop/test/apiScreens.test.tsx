/**
 * 외부 API 권한 C안 P4b 화면 — API 연결 절 · 권한 주기 폼 · 막힘 카드. 판정은 전부 서버다. 여기서 재는 것:
 * 연결 만들기가 서버 몸체 그대로 가는가 · 권한이 있는 연결의 주소를 바꾸면 확인창을 거치는가 · 폼이 「쓰기는 사람 글 턴만」을
 * 기본값 없이 고르게 하는가 · 읽기+쓰기에 「만료 없음」이 없는가 · 카드 버튼은 소유자 사람에게만 서고 막힌 요청보다 넓게 채우지 않는가.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { ApiConnectorView, MessageRow } from '@harkroom/shared';
import { ConnectorsSection } from '../src/components/settings/ConnectorsSection';
import { ApiGrantForm } from '../src/components/settings/ApiGrantForm';
import { BlockedCard, firstSegment } from '../src/components/BlockedCard';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import type { SecretView } from '../src/lib/api';
import { acc } from './helpers/fakeApi';

const ME = 'owner-1';
const conn = (over: Partial<ApiConnectorView> = {}): ApiConnectorView => ({
  id: '11111111-1111-4111-8111-111111111111', name: 'lab-api', ownerAccountId: ME, baseUrl: 'https://api.example.internal',
  authKind: 'bearer', authHeader: null, secretId: 's1', methods: ['GET', 'POST'], createdAt: '', updatedAt: '', grantCount: 0, ...over,
});
const secret: SecretView = {
  id: 's1', name: 'api-token', kind: 'text', filename: null, description: '', ownerAccountId: ME,
  expiresAt: null, createdAt: '', updatedAt: '', version: 1, sizeBytes: 10, grantCount: 0,
};

function setup(over: Record<string, unknown> = {}, rows: ApiConnectorView[] = [conn()]) {
  const c = {
    listConnectors: vi.fn(async () => rows),
    createConnector: vi.fn(async () => conn()),
    patchConnector: vi.fn(async () => ({ connector: conn(), suspendedGrants: 1 })),
    deleteConnector: vi.fn(async () => undefined),
    putGrant: vi.fn(async () => []),
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
    accounts: { [ME]: acc(ME, 'owner'), 'agent-1': acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME }), other: acc('other', 'carol') },
  });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('ConnectorsSection', () => {
  it('만들기: https origin·내 비밀·메서드가 서버 몸체 그대로 간다', async () => {
    const c = setup({}, []);
    render(<ConnectorsSection secrets={[secret]} enabled onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ API 연결 만들기' }));
    const form = screen.getByTestId('connector-form');
    const [name, url] = within(form).getAllByRole('textbox');
    fireEvent.change(name!, { target: { value: 'lab-api' } });
    fireEvent.change(url!, { target: { value: 'https://api.example.internal/v1' } });
    expect((within(form).getByRole('button', { name: '만들기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(url!, { target: { value: 'https://api.example.internal' } });
    fireEvent.change(within(form).getByLabelText('키'), { target: { value: 's1' } });
    fireEvent.click(within(form).getByLabelText('POST'));
    fireEvent.click(within(form).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(c.createConnector).toHaveBeenCalledWith({
      name: 'lab-api', baseUrl: 'https://api.example.internal', authKind: 'bearer', authHeader: null, secretId: 's1', methods: ['GET', 'POST'],
    }));
  });

  it('권한이 있는 연결의 주소를 바꾸면 확인창을 거치고, 멈춘 수를 알린다', async () => {
    const c = setup({}, [conn({ grantCount: 2 })]);
    render(<ConnectorsSection secrets={[secret]} enabled onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '고치기' }));
    const form = screen.getByTestId('connector-form');
    fireEvent.change(within(form).getAllByRole('textbox')[0]!, { target: { value: 'https://other.example.internal' } });
    fireEvent.click(within(form).getByRole('button', { name: '저장' }));
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('2');
    expect(c.patchConnector).not.toHaveBeenCalled();
    fireEvent.click(within(dlg).getByRole('button', { name: '바꾸고 멈추기' }));
    await waitFor(() => expect(c.patchConnector).toHaveBeenCalled());
    expect((await screen.findByTestId('connectors-notice')).textContent).toContain('1');
  });

  it('메서드만 바꾸면 확인창 없이 저장한다', async () => {
    const c = setup({}, [conn({ grantCount: 2 })]);
    render(<ConnectorsSection secrets={[secret]} enabled onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '고치기' }));
    fireEvent.click(within(screen.getByTestId('connector-form')).getByLabelText('DELETE'));
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(c.patchConnector).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ApiGrantForm', () => {
  it('읽기만: GET·경로·만료 7일 기본, 「없음」도 고를 수 있다', async () => {
    const c = setup();
    render(<ApiGrantForm agentId="agent-1" connectors={[conn()]} onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('radio', { name: '없음' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('경로 (이것으로 시작하는 경로만)'), { target: { value: '/api/' } });
    fireEvent.click(screen.getByRole('button', { name: '주기' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    const body = (c.putGrant.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(body).toMatchObject({ capability: 'api.call', scope: `connector:${conn().id}`, limits: { methods: ['GET'], pathPrefix: '/api/' } });
    expect(body.writeNeedsHumanCause).toBeUndefined();
    expect(Date.parse(body.expiresAt as string) - Date.now()).toBeGreaterThan(6 * 86_400_000);
  });

  it('읽기+쓰기: 「만료 없음」이 사라지고, 「쓰기는 사람 글 턴만」을 고르기 전에는 [주기]가 꺼져 있다(기본값 없음)', async () => {
    const c = setup();
    render(<ApiGrantForm agentId="agent-1" connectors={[conn()]} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '읽기+쓰기 (GET·POST)' }));
    expect(screen.queryByRole('radio', { name: '없음' })).toBeNull();
    const yes = screen.getByRole('radio', { name: '예' });
    expect(yes.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: '아니오 — 에이전트 글 턴도' }).getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('button', { name: '주기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(yes);
    fireEvent.click(screen.getByRole('button', { name: '주기' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    const body = (c.putGrant.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(body).toMatchObject({ limits: { methods: ['GET', 'POST'] }, writeNeedsHumanCause: true });
    expect(body.expiresAt).not.toBeNull();
  });
});

describe('BlockedCard', () => {
  const msg = (blocked: Record<string, unknown>): MessageRow => ({
    id: 'm1', channelId: 'c1', threadRootId: 't1', authorId: 'agent-1', body: '🔒', kind: 'system',
    meta: { blocked: { kind: 'api', agentId: 'agent-1', ownerAccountId: ME, code: 'not_granted', count: 3, lastAt: '2026-10-03T04:08:00Z',
      connectorId: conn().id, connectorName: 'lab-api', method: 'GET', path: '/api/capacity/x', ...blocked } },
  } as unknown as MessageRow);

  it('첫 마디까지만 자른다', () => {
    expect(firstSegment('/api/capacity/x')).toBe('/api/');
    expect(firstSegment('/x')).toBe('/x');
    expect(firstSegment(null)).toBe('/');
  });

  it('소유자 사람에게만 [권한 주기…] — 대화상자는 막힌 GET 을 읽기만·첫 마디로 채운다', async () => {
    setup();
    render(<BlockedCard message={msg({})} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('blocked-card').textContent).toContain('3번');
    fireEvent.click(screen.getByRole('button', { name: '권한 주기…' }));
    const form = await screen.findByTestId('api-grant-form');
    expect(within(form).getByRole('radio', { name: '읽기만 (GET)' }).getAttribute('aria-checked')).toBe('true');
    expect((within(form).getByLabelText('경로 (이것으로 시작하는 경로만)') as HTMLInputElement).value).toBe('/api/');
  });

  it('소유자가 아니면 버튼 없이 「소유자만」', () => {
    setup();
    useActiveStore.getState().set({ me: acc('other', 'carol') });
    render(<BlockedCard message={msg({})} onOpenSettings={() => {}} />);
    expect(screen.queryByRole('button', { name: '권한 주기…' })).toBeNull();
    expect(screen.getByTestId('blocked-owner-only').textContent).toContain('@owner');
  });

  it('키가 없으면 [새 값 넣기…] 가 설정을 연다 · 없는 연결은 [API 연결 만들기…]', () => {
    setup();
    const open = vi.fn();
    const { unmount } = render(<BlockedCard message={msg({ code: 'no_secret' })} onOpenSettings={open} />);
    fireEvent.click(screen.getByRole('button', { name: '새 값 넣기…' }));
    expect(open).toHaveBeenCalledWith('secrets');
    unmount();
    render(<BlockedCard message={msg({ code: 'no_connector', connectorId: null, connectorName: null })} onOpenSettings={open} />);
    expect(screen.queryByRole('button', { name: '권한 주기…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'API 연결 만들기…' }));
  });
});
