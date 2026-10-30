/**
 * 「머지·API·명령 권한」 절의 명령 허용 줄(시안 v1 결정 1~8). 판정은 서버가 다시 한다 — 여기서 재는 것은 폼이 shared
 * `validateToolRule` 로 틀린 줄을 줄 번호로 짚는가, 채널×규칙마다 `tool:<채널>:<규칙>` 으로 PUT 하는가, 위험 규칙은 「없음」을
 * 끄는가, 목록이 카드 7일 줄·상한 밖 위험 줄을 표시하고 [30일로] 가 같은 scope 로 다시 PUT 하는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView, ChannelRow, GrantRow } from '@harkroom/shared';
import { AgentGrantsSection } from '../src/components/settings/AgentGrantsSection';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

const ME_ID = 'owner-1';
const CH = '22222222-2222-4222-8222-222222222222';
const CH2 = '33333333-3333-4333-8333-333333333333';
const agent = (): AgentView => ({
  ...(acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME_ID }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, claudeLane: null, assignment: null, invokeScope: 'owner', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [],
});
const tool = (rule: string, over: Partial<GrantRow> = {}): GrantRow => ({
  accountId: 'agent-1', capability: 'tool.allow', scope: `tool:${CH}:${rule}`, grantedBy: ME_ID, grantedAt: '2026-10-02T00:00:00Z', expiresAt: null, allowAgentCause: false, ...over,
});
const READ_RULE = 'Bash(gh pr list -R izagood/harkroom --state open:*)';
/** 「원격 상태를 바꾼다」 경고가 붙는 규칙 — 만료 상한 대상. */
const RISKY_RULE = 'Bash(kubectl --kubeconfig /etc/k/ops.yaml --context ops delete pod:*)';

function setup(rows: GrantRow[] = []) {
  const c = {
    listGrants: vi.fn(async () => rows),
    listConnectors: vi.fn(async () => []),
    putGrant: vi.fn(async () => rows),
    deleteGrant: vi.fn(async () => {}),
    loadChannelMembers: vi.fn(async () => [{ accountId: 'agent-1' }]),
  };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  const ch = (id: string, name: string) => ({ id, name, kind: 'standard', archivedAt: null }) as unknown as ChannelRow;
  useActiveStore.getState().set({
    me: acc(ME_ID, 'owner'),
    accounts: { [ME_ID]: acc(ME_ID, 'owner'), 'agent-1': acc('agent-1', 'alpha', 'agent') },
    channels: [ch(CH, 'dev'), ch(CH2, 'ops')],
  } as never);
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); vi.useRealTimers(); });

async function openForm() {
  fireEvent.click(await screen.findByText('+ 권한 주기'));
  fireEvent.click(screen.getByRole('radio', { name: '명령 허용' }));
  return screen.findByTestId('agent-tool-allow-add');
}

describe('명령 허용 줄', () => {
  it('규칙 여러 줄 × 채널 여러 개를 30일(기본)로 PUT 한다', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await openForm();
    fireEvent.change(screen.getByLabelText('규칙(한 줄에 하나)'), { target: { value: `${READ_RULE}\n\nBash(gh pr view -R izagood/harkroom:*)` } });
    fireEvent.click(await screen.findByTestId(`tool-allow-chip-${CH}`));
    fireEvent.click(screen.getByTestId(`tool-allow-chip-${CH2}`));
    fireEvent.click(screen.getByText('주기'));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledTimes(4));
    const scopes = c.putGrant.mock.calls.map((a) => (a as unknown as [string, { scope: string; expiresAt: string }])[1]);
    expect(scopes.map((b) => b.scope)).toContain(`tool:${CH2}:${READ_RULE}`);
    const days = (Date.parse(scopes[0]!.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.01);
  });

  it('틀린 줄은 줄 번호와 사람 말로 짚고 [주기] 를 끈다', async () => {
    setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await openForm();
    fireEvent.change(screen.getByLabelText('규칙(한 줄에 하나)'), { target: { value: `${READ_RULE}\nBash(ls; rm -rf x)` } });
    fireEvent.click(await screen.findByTestId(`tool-allow-chip-${CH}`));
    expect(screen.getByTestId('tool-allow-bad').textContent).toContain('2번째 줄');
    expect((screen.getByText('주기') as HTMLButtonElement).disabled).toBe(true);
  });

  it('위험 경고 규칙은 「없음」을 끄고, 읽기 규칙의 「없음」은 경고 + 확인 대화를 거친다', async () => {
    const c = setup();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await openForm();
    const box = screen.getByLabelText('규칙(한 줄에 하나)');
    fireEvent.change(box, { target: { value: RISKY_RULE } });
    const none = () => screen.getByRole('radio', { name: '없음' }) as HTMLInputElement;
    expect(screen.getByTestId('tool-allow-capped')).toBeTruthy();
    expect(none().disabled).toBe(true);
    fireEvent.change(box, { target: { value: READ_RULE } });
    fireEvent.click(await screen.findByTestId(`tool-allow-chip-${CH}`));
    expect(none().disabled).toBe(false);
    fireEvent.click(none());
    expect(screen.getByTestId('tool-allow-none-warning')).toBeTruthy();
    fireEvent.click(screen.getByText('만료 없이 주기…'));
    expect(c.putGrant).not.toHaveBeenCalled();
    const dialogButtons = await screen.findAllByText('만료 없이 주기…');
    fireEvent.click(dialogButtons[dialogButtons.length - 1]!);
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledWith('agent-1', { capability: 'tool.allow', scope: `tool:${CH}:${READ_RULE}`, expiresAt: null }));
  });

  it('카드 7일 줄에는 「카드로」 뱃지와 [30일로] — 같은 scope 로 30일 다시 PUT', async () => {
    const at = new Date(Date.now() - 86_400_000);
    const row = tool(READ_RULE, { grantedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 7 * 86_400_000).toISOString() });
    const c = setup([row]);
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId(`agent-tool-allow-${READ_RULE}`);
    expect(screen.getByTestId(`tool-allow-card-${READ_RULE}`).textContent).toBe('카드로');
    expect(screen.getByTestId('agent-grants').textContent).toContain('#dev');
    fireEvent.click(screen.getByText('30일로'));
    await waitFor(() => expect(c.putGrant).toHaveBeenCalledWith('agent-1', expect.objectContaining({ capability: 'tool.allow', scope: row.scope })));
  });

  it('만료 없이 남은 위험 규칙 줄은 경고를 띄우고 [30일로] 를 준다(security 지적 2)', async () => {
    setup([tool(READ_RULE), tool(RISKY_RULE)]);
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId(`agent-tool-allow-${RISKY_RULE}`);
    expect(screen.queryByTestId(`tool-allow-uncapped-${READ_RULE}`)).toBeNull();
    expect(screen.getByTestId(`tool-allow-uncapped-${RISKY_RULE}`)).toBeTruthy();
    expect(screen.getByLabelText(`${RISKY_RULE} 을 오늘부터 30일로`)).toBeTruthy();
  });

  it('[30일로] 는 카드 줄·7일 안으로 남은 줄에만 — 설정에서 30일로 준 줄은 하루 지나도 달지 않는다 · 만료 없음·남은 날은 주황', async () => {
    const DAY = 86_400_000;
    const OTHER = 'Bash(gh pr view -R izagood/harkroom:*)';
    const SOON = 'Bash(gh pr checks -R izagood/harkroom:*)';
    setup([
      tool(READ_RULE),
      tool(OTHER, { grantedAt: new Date(Date.now() - 2 * DAY).toISOString(), expiresAt: new Date(Date.now() + 28 * DAY).toISOString() }),
      tool(SOON, { grantedAt: new Date(Date.now() - 27 * DAY).toISOString(), expiresAt: new Date(Date.now() + 3 * DAY - 60_000).toISOString() }),
    ]);
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId(`agent-tool-allow-${SOON}`);
    expect(screen.queryByLabelText(`${OTHER} 을 오늘부터 30일로`)).toBeNull();
    expect(screen.queryByLabelText(`${READ_RULE} 을 오늘부터 30일로`)).toBeNull();
    expect(screen.queryByTestId(`tool-allow-soon-${OTHER}`)).toBeNull();
    expect(screen.getByLabelText(`${SOON} 을 오늘부터 30일로`)).toBeTruthy();
    const soon = screen.getByTestId(`tool-allow-soon-${SOON}`);
    expect(soon.className).toContain('text-warning');
    expect(soon.textContent).toContain('3일 남음');
    expect(screen.getByTestId(`tool-allow-no-expiry-${READ_RULE}`).className).toContain('text-warning');
  });

  it('안내 띠에서 왔으면(openToolAllow) 명령 허용 폼이 연 채로 선다', async () => {
    setup();
    const opened = vi.fn();
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke openToolAllow onToolAllowOpened={opened} />);
    expect(await screen.findByTestId('agent-tool-allow-add')).toBeTruthy();
    expect(opened).toHaveBeenCalled();
  });

  it('명령 허용 줄만 있어도 절은 접히지 않는다', async () => {
    setup([tool(READ_RULE)]);
    render(<AgentGrantsSection agent={agent()} canGrant canRevoke />);
    await screen.findByTestId(`agent-tool-allow-${READ_RULE}`);
    expect(screen.getByTestId('agent-grants').textContent).not.toContain('준 권한 없음');
  });
});
