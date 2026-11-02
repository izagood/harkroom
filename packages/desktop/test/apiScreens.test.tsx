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
  authKind: 'bearer', authHeader: null, secretId: 's1', tokenUrl: null, tokenForm: null, methods: ['GET', 'POST'], createdAt: '', updatedAt: '', grantCount: 0, ...over,
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
    listGrants: vi.fn(async () => []),
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

  it('토큰 교환: 키가 가는 곳(다른 호스트면 경고)·보내는 값 미리보기·몸체에 토큰 칸', async () => {
    const c = setup({}, []);
    render(<ConnectorsSection secrets={[secret]} enabled onChanged={async () => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ API 연결 만들기' }));
    const form = screen.getByTestId('connector-form');
    const [name, url] = within(form).getAllByRole('textbox');
    fireEvent.change(name!, { target: { value: 'lab-api' } });
    fireEvent.change(url!, { target: { value: 'https://api.example.com' } });
    fireEvent.click(within(form).getByRole('radio', { name: '토큰 교환' }));
    const tok = within(form).getByTestId('connector-token');
    // 키 고르기는 토큰 묶음 안으로 옮겨진다.
    fireEvent.change(within(tok).getByLabelText('키'), { target: { value: 's1' } });
    // client_id 가 비어 있으면 토큰 주소를 맞게 적은 뒤 왜 [만들기]가 꺼졌는지 보인다(designer 고칠 것 1).
    fireEvent.change(within(tok).getByLabelText('토큰 주소'), { target: { value: 'https://auth.example.com/t' } });
    expect(within(tok).getByText(/client_id 를 넣는다/)).toBeTruthy();
    fireEvent.change(within(tok).getByLabelText('client_id'), { target: { value: 'lab-cli' } });
    expect(within(tok).queryByText(/client_id 를 넣는다/)).toBeNull();
    fireEvent.change(within(tok).getByLabelText('토큰 주소'), { target: { value: 'https://auth.example.com/oauth/token?x=1' } });
    expect(within(tok).getByText(/https 주소만 쓴다/)).toBeTruthy();
    expect(within(tok).queryByTestId('connector-token-dest')).toBeNull();
    expect((within(form).getByRole('button', { name: '만들기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(tok).getByLabelText('토큰 주소'), { target: { value: 'https://auth.example.com/oauth/token' } });
    const dest = within(tok).getByTestId('connector-token-dest');
    expect(dest.textContent).toContain('https://auth.example.com');
    expect(dest.textContent).toContain('다른 호스트');
    expect(within(tok).getByTestId('connector-token-preview').textContent).toContain('grant_type=client_credentials&client_id=lab-cli&client_secret=••••');
    // 예약된 칸 이름은 바로 경고하고 [만들기]를 끈다.
    fireEvent.change(within(tok).getByLabelText('키를 담을 칸'), { target: { value: 'client_id' } });
    expect(within(tok).getByText(/grant_type·client_id 가 아닌/)).toBeTruthy();
    expect((within(form).getByRole('button', { name: '만들기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(tok).getByLabelText('키를 담을 칸'), { target: { value: 'api_key' } });
    fireEvent.click(within(form).getByRole('button', { name: '만들기' }));
    await waitFor(() => expect(c.createConnector).toHaveBeenCalledWith({
      name: 'lab-api', baseUrl: 'https://api.example.com', authKind: 'token_exchange', authHeader: null, secretId: 's1', methods: ['GET'],
      tokenUrl: 'https://auth.example.com/oauth/token', tokenForm: { grantType: 'client_credentials', clientId: 'lab-cli', keyField: 'api_key' },
    }));
  });

  it('토큰 교환 고치기: 칸이 채워지고, Bearer 로 바꿨다 돌아와도 입력이 남고, 보내는 값을 바꾸면 확인창을 거친다', async () => {
    const tx = conn({ baseUrl: 'https://api.example.com', authKind: 'token_exchange', grantCount: 1, tokenUrl: 'https://api.example.com/auth/token', tokenForm: { grantType: 'password', clientId: 'cli', keyField: 'api_key' } });
    const c = setup({}, [tx]);
    render(<ConnectorsSection secrets={[secret]} enabled onChanged={async () => {}} />);
    expect((await screen.findByTestId('connector-lab-api')).textContent).toContain('토큰 교환 → api.example.com');
    fireEvent.click(screen.getByRole('button', { name: '고치기' }));
    const form = screen.getByTestId('connector-form');
    const tok = within(form).getByTestId('connector-token');
    expect((within(tok).getByLabelText('client_id') as HTMLInputElement).value).toBe('cli');
    expect(within(tok).getByTestId('connector-token-dest').textContent).toContain('기본 주소와 같다');
    fireEvent.click(within(form).getByRole('radio', { name: 'Bearer' }));
    expect(within(form).queryByTestId('connector-token')).toBeNull();
    fireEvent.click(within(form).getByRole('radio', { name: '토큰 교환' }));
    expect((within(form).getByLabelText('client_id') as HTMLInputElement).value).toBe('cli');
    fireEvent.change(within(form).getByLabelText('client_id'), { target: { value: 'cli2' } });
    fireEvent.click(within(form).getByRole('button', { name: '저장' }));
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('보내는 값');
    fireEvent.click(within(dlg).getByRole('button', { name: '바꾸고 멈추기' }));
    await waitFor(() => expect(c.patchConnector).toHaveBeenCalledWith(tx.id, expect.objectContaining({ tokenForm: { grantType: 'password', clientId: 'cli2', keyField: 'api_key' } })));
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
    const yes = screen.getByRole('radio', { name: '사람이 시킨 턴에서만' });
    expect(yes.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: '에이전트가 시킨 턴에서도' }).getAttribute('aria-checked')).toBe('false');
    expect((screen.getByRole('button', { name: '주기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(yes);
    fireEvent.click(screen.getByRole('button', { name: '주기' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    const body = (c.putGrant.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(body).toMatchObject({ limits: { methods: ['GET', 'POST'] }, writeNeedsHumanCause: true });
    expect(body.expiresAt).not.toBeNull();
  });

  it('설정 화면(allowWriteNoExpiry): 읽기+쓰기에도 「없음」이 생기고, 경고·확인 체크를 지나야 [주기]가 켜지며 expiresAt null 을 보낸다', async () => {
    const c = setup();
    render(<ApiGrantForm allowWriteNoExpiry agentId="agent-1" connectors={[conn()]} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '읽기+쓰기 (GET·POST)' }));
    fireEvent.click(screen.getByRole('radio', { name: '에이전트가 시킨 턴에서도' }));
    fireEvent.click(screen.getByRole('radio', { name: '없음' }));
    const warn = screen.getByTestId('api-grant-no-expiry-warning');
    expect(warn.textContent).toContain('거둘 때까지 POST');
    // 「쓰기는 사람 글 턴만」이 꺼져 있으면 다른 에이전트·예약 턴도 적는다(security 조건 3).
    expect(warn.textContent).toContain('예약 턴');
    expect((screen.getByRole('button', { name: '주기' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(warn).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '주기' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    const body = (c.putGrant.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(body).toMatchObject({ limits: { methods: ['GET', 'POST'] }, writeNeedsHumanCause: false, expiresAt: null });
  });

  it('경고가 넓어지거나 다시 뜨면 확인 체크가 빈 칸으로 돌아간다(designer 고칠 것 1)', () => {
    setup();
    render(<ApiGrantForm allowWriteNoExpiry agentId="agent-1" connectors={[conn()]} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '읽기+쓰기 (GET·POST)' }));
    fireEvent.click(screen.getByRole('radio', { name: '사람이 시킨 턴에서만' }));
    fireEvent.click(screen.getByRole('radio', { name: '없음' }));
    const give = () => screen.getByRole('button', { name: '주기' }) as HTMLButtonElement;
    fireEvent.click(within(screen.getByTestId('api-grant-no-expiry-warning')).getByRole('checkbox'));
    expect(give().disabled).toBe(false);
    // 「사람 글 턴만」 yes → no: 「예약 턴에서도」가 붙는다 → 다시 확인해야 한다.
    fireEvent.click(screen.getByRole('radio', { name: '에이전트가 시킨 턴에서도' }));
    expect((within(screen.getByTestId('api-grant-no-expiry-warning')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(give().disabled).toBe(true);
    // 만료 없음 → 7일 → 없음: 경고가 다시 뜨면 빈 체크로 시작한다.
    fireEvent.click(within(screen.getByTestId('api-grant-no-expiry-warning')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('radio', { name: '7일' }));
    fireEvent.click(screen.getByRole('radio', { name: '없음' }));
    expect((within(screen.getByTestId('api-grant-no-expiry-warning')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(give().disabled).toBe(true);
  });

  it('「사람 글 턴만」을 켜면 경고에 다른 턴 문구가 빠진다 · 7일로 돌리면 경고가 사라진다', () => {
    setup();
    render(<ApiGrantForm allowWriteNoExpiry agentId="agent-1" connectors={[conn()]} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '읽기+쓰기 (GET·POST)' }));
    fireEvent.click(screen.getByRole('radio', { name: '사람이 시킨 턴에서만' }));
    fireEvent.click(screen.getByRole('radio', { name: '없음' }));
    expect(screen.getByTestId('api-grant-no-expiry-warning').textContent).not.toContain('예약 턴');
    fireEvent.click(screen.getByRole('radio', { name: '7일' }));
    expect(screen.queryByTestId('api-grant-no-expiry-warning')).toBeNull();
  });
});

describe('ApiGrantForm 고치기(editMode)', () => {
  const ex = (over: Record<string, unknown> = {}) => ({
    id: 'g1', accountId: 'agent-1', capability: 'api.call', scope: `connector:${conn().id}`, grantedBy: ME, grantedAt: '2026-11-01T00:00:00Z',
    expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' },
    writeNeedsHumanCause: true, suspendedAt: null, delegateDepth: 0, ...over,
  }) as never;

  it('경로·범위를 그 자리에서 바꾸고 바뀐 칸만 보인다 · 바뀐 것이 없으면 [저장]이 꺼진다', async () => {
    const c = setup();
    render(<ApiGrantForm editMode allowWriteNoExpiry agentId="agent-1" connectors={[conn()]} existing={ex()} onDone={() => {}} onCancel={() => {}} />);
    const save = () => screen.getByRole('button', { name: '저장' }) as HTMLButtonElement;
    expect(screen.getByTestId('api-grant-changes').textContent).toContain('바뀐 것이 없다');
    expect(save().disabled).toBe(true);
    const path = screen.getByLabelText('경로 (이것으로 시작하는 경로만)') as HTMLInputElement;
    expect(path.disabled).toBe(false);
    fireEvent.change(path, { target: { value: '/api/catalog/' } });
    expect(screen.getByTestId('api-grant-change-path').textContent).toContain('/api/ → /api/catalog/');
    expect(screen.queryByTestId('api-grant-change-scope')).toBeNull();
    fireEvent.click(save());
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    const body = (c.putGrant.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(body).toMatchObject({ limits: { methods: ['GET', 'POST'], pathPrefix: '/api/catalog/' }, writeNeedsHumanCause: true });
  });

  it('읽기만으로 좁히면 범위 줄이 서고 GET 만 보낸다 · 넘긴 하위 권한이 있으면 끊길 수 있다고 알린다', async () => {
    const c = setup();
    render(<ApiGrantForm editMode allowWriteNoExpiry delegatedCount={2} agentId="agent-1" connectors={[conn()]} existing={ex()} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '읽기만 (GET)' }));
    expect(screen.getByTestId('api-grant-change-scope').textContent).toContain('→');
    expect(screen.getByTestId('api-grant-children-warning').textContent).toContain('2');
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    expect((c.putGrant.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({ limits: { methods: ['GET'] } });
  });

  it('경로를 넓히기만 하면(새 경로가 옛 경로의 접두) 하위 권한 경고를 띄우지 않는다', () => {
    setup();
    render(<ApiGrantForm editMode allowWriteNoExpiry delegatedCount={2} agentId="agent-1" connectors={[conn()]} existing={ex({ limits: { methods: ['GET', 'POST'], pathPrefix: '/api/catalog/' } })} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText('경로 (이것으로 시작하는 경로만)'), { target: { value: '/api/' } });
    expect(screen.queryByTestId('api-grant-children-warning')).toBeNull();
    fireEvent.change(screen.getByLabelText('경로 (이것으로 시작하는 경로만)'), { target: { value: '/api/catalog/x/' } });
    expect(screen.getByTestId('api-grant-children-warning')).toBeTruthy();
    // 마디 경계가 아닌 글자 접두는 덮지 않는다(서버 pathCovered 와 같은 규칙).
    fireEvent.change(screen.getByLabelText('경로 (이것으로 시작하는 경로만)'), { target: { value: '/ap' } });
    expect(screen.getByTestId('api-grant-children-warning')).toBeTruthy();
  });

  it('멈춘 부여는 「저장하면 다시 켜진다」를 보이고 칸을 안 바꿔도 저장할 수 있다', () => {
    setup();
    render(<ApiGrantForm editMode allowWriteNoExpiry agentId="agent-1" connectors={[conn()]} existing={ex({ suspendedAt: '2026-11-02T00:00:00Z' })} onDone={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId('api-grant-resume-warning').textContent).toContain('다시 켜진다');
    // 「바뀐 것이 없다」 대신 「상태: 멈춤 → 켜짐」 줄(designer 고칠 것 1).
    expect(screen.getByTestId('api-grant-changes').textContent).not.toContain('바뀐 것이 없다');
    expect(screen.getByTestId('api-grant-change-state').textContent).toContain('멈춤 → 켜짐');
    expect((screen.getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('무기한 확인 체크는 연결을 바꿔도 빈 칸으로 돌아간다(확인 키에 연결)', () => {
    setup();
    const other = conn({ id: '22222222-2222-4222-8222-222222222222', name: 'other-api' });
    render(<ApiGrantForm allowWriteNoExpiry agentId="agent-1" connectors={[conn(), other]} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: '읽기+쓰기 (GET·POST)' }));
    fireEvent.click(screen.getByRole('radio', { name: '사람이 시킨 턴에서만' }));
    fireEvent.click(screen.getByRole('radio', { name: '없음' }));
    fireEvent.click(within(screen.getByTestId('api-grant-no-expiry-warning')).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('API 연결'), { target: { value: other.id } });
    // 연결을 바꾸면 범위가 읽기로 돌아가 경고가 사라진다 — 다시 쓰기·없음을 골라도 체크는 비어 있다.
    fireEvent.click(screen.getByRole('radio', { name: '읽기+쓰기 (GET·POST)' }));
    fireEvent.click(screen.getByRole('radio', { name: '사람이 시킨 턴에서만' }));
    fireEvent.click(screen.getByRole('radio', { name: '없음' }));
    expect((within(screen.getByTestId('api-grant-no-expiry-warning')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
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
    expect(firstSegment(null)).toBe('');
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

  it('경로를 모르면(L1) 경로 칸을 비우고 적기 전엔 [주기]가 꺼진다', async () => {
    setup();
    render(<BlockedCard message={msg({ path: null, lastRequest: 'GET (경로 생략)', code: 'path_not_allowed' })} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('blocked-card').textContent).toContain('GET (경로 생략)');
    fireEvent.click(screen.getByRole('button', { name: '권한 주기…' }));
    const form = await screen.findByTestId('api-grant-form');
    expect((within(form).getByLabelText('경로 (이것으로 시작하는 경로만)') as HTMLInputElement).value).toBe('');
    expect(within(form).getByTestId('api-grant-path-unknown')).toBeTruthy();
    expect((within(form).getByRole('button', { name: '주기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('이미 권한이 있으면(L2·D1) 「지금 → 바꿀 값」과 [바꾸기]를 보인다', async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
    setup({ listGrants: vi.fn(async () => [{ accountId: 'agent-1', capability: 'api.call', scope: `connector:${conn().id}`, grantedBy: ME, grantedAt: '', expiresAt: until,
      limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, writeNeedsHumanCause: false }]) });
    render(<BlockedCard message={msg({ path: '/admin/x', method: 'GET', code: 'path_not_allowed' })} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '권한 주기…' }));
    const box = await screen.findByTestId('api-grant-replace');
    expect(box.textContent).toContain('지금: 읽기+쓰기 (GET·POST) /api/');
    expect(box.textContent).toContain('바꿀 값: 읽기만 (GET) /admin/');
    expect(box.textContent).toContain('주면 지금 권한을 대신한다');
    expect(screen.getByRole('button', { name: '바꾸기' })).toBeTruthy();
  });

  it('cause_not_human(D2)은 [설정 바꾸기…] — 지금 grant 그대로 열고 만료는 유지가 기본', async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const c = setup({ listGrants: vi.fn(async () => [{ accountId: 'agent-1', capability: 'api.call', scope: `connector:${conn().id}`, grantedBy: ME, grantedAt: '', expiresAt: until,
      limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, writeNeedsHumanCause: true, delegateDepth: 2 }]) });
    render(<BlockedCard message={msg({ code: 'cause_not_human', method: 'POST', path: '/api/x' })} onOpenSettings={() => {}} />);
    expect(screen.getByTestId('blocked-card').textContent).toContain('이 권한은 사람이 시킨 턴에서만 쓸 수 있다');
    expect(screen.queryByRole('button', { name: '권한 주기…' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '설정 바꾸기…' }));
    const form = await screen.findByTestId('api-grant-form');
    expect((within(form).getByLabelText('경로 (이것으로 시작하는 경로만)') as HTMLInputElement).value).toBe('/api/');
    expect(within(form).getByRole('radio', { name: '사람이 시킨 턴에서만' }).getAttribute('aria-checked')).toBe('true');
    expect(within(form).getByRole('radio', { name: '지금 만료 유지' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(form).getByRole('radio', { name: '에이전트가 시킨 턴에서도' }));
    fireEvent.click(within(form).getByRole('button', { name: '바꾸기' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    expect((c.putGrant.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({
      limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, expiresAt: until, writeNeedsHumanCause: false, delegateDepth: 2,
    });
  });

  it('F1: [설정 바꾸기…]는 연결이 더 넓어도 기존 메서드를 그대로 보내고, 범위·경로는 잠근다', async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const wide = conn({ methods: ['GET', 'POST', 'PUT', 'DELETE'] });
    const c = setup({ listConnectors: vi.fn(async () => [wide]), listGrants: vi.fn(async () => [{ accountId: 'agent-1', capability: 'api.call', scope: `connector:${wide.id}`, grantedBy: ME, grantedAt: '', expiresAt: until,
      limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, writeNeedsHumanCause: true, delegateDepth: 0 }]) });
    render(<BlockedCard message={msg({ code: 'cause_not_human', method: 'POST', path: '/api/x' })} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '설정 바꾸기…' }));
    const form = await screen.findByTestId('api-grant-form');
    expect((within(form).getByLabelText('경로 (이것으로 시작하는 경로만)') as HTMLInputElement).disabled).toBe(true);
    expect((within(form).getByRole('radio', { name: '읽기만 (GET)' }) as HTMLButtonElement).disabled).toBe(true);
    const box = within(form).getByTestId('api-grant-replace').textContent ?? '';
    expect(box).toContain('바꿀 값: 읽기+쓰기 (GET·POST) /api/');
    expect(box).not.toContain('PUT');
    fireEvent.click(within(form).getByRole('radio', { name: '에이전트가 시킨 턴에서도' }));
    fireEvent.click(within(form).getByRole('button', { name: '바꾸기' }));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalled());
    expect((c.putGrant.mock.calls[0] as unknown as [string, { limits: { methods: string[] } }])[1].limits.methods).toEqual(['GET', 'POST']);
  });

  it('n5·[바꾸기]: 「바꿀 값」에 메서드와 고른 만료를 적는다', async () => {
    const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
    setup({ listGrants: vi.fn(async () => [{ accountId: 'agent-1', capability: 'api.call', scope: `connector:${conn().id}`, grantedBy: ME, grantedAt: '', expiresAt: until,
      limits: { methods: ['GET', 'POST'], pathPrefix: '/api/' }, writeNeedsHumanCause: false }]) });
    render(<BlockedCard message={msg({ path: '/admin/x', method: 'GET', code: 'path_not_allowed' })} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '권한 주기…' }));
    const box = await screen.findByTestId('api-grant-replace');
    expect(box.textContent).toContain('지금: 읽기+쓰기 (GET·POST) /api/');
    expect(box.textContent).toContain('바꿀 값: 읽기만 (GET) /admin/ · 7일');
    fireEvent.click(screen.getByRole('radio', { name: '30일' }));
    expect(screen.getByTestId('api-grant-replace').textContent).toContain('/admin/ · 30일');
  });

  it('대화상자를 닫았다 다시 열면 grant 를 새로 읽는다(security D1 메모)', async () => {
    const c = setup();
    render(<BlockedCard message={msg({})} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '권한 주기…' }));
    await screen.findByTestId('api-grant-form');
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByRole('button', { name: '권한 주기…' }));
    await screen.findByTestId('api-grant-form');
    expect(c.listGrants).toHaveBeenCalledTimes(2);
  });

  it('n4: 주고 나면 카드가 ✓ 한 줄로 접힌다', async () => {
    setup();
    render(<BlockedCard message={msg({})} onOpenSettings={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '권한 주기…' }));
    const form = await screen.findByTestId('api-grant-form');
    fireEvent.click(within(form).getByRole('button', { name: '주기' }));
    await waitFor(() => expect(screen.getByTestId('blocked-done').textContent).toContain('권한을 줬다'));
    expect(screen.queryByRole('button', { name: '권한 주기…' })).toBeNull();
    expect(screen.getByTestId('blocked-card').textContent).not.toContain('3번');
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
