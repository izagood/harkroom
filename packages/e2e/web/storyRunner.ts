/**
 * 화면 여정 러너 — 스토리보드(`../stories`)의 여정을 브라우저로 돈다. 결과는 「대체(브라우저)」다.
 *
 * 서버 쪽 러너(`packages/server/test/helpers/storyRunner.ts`)와 같은 동작 어휘를 쓰되, 여기서 보는 것은
 * **화면**이다: `ui.see`·`ui.notSee` 는 실제 버튼을 찾고, `withinSec` 가 있으면 그 안에 **재시작 없이**
 * 바뀌어야 한다(이번 사고 — 권한을 받아도 ⌘Q 전엔 버튼이 안 생김 — 을 잡는 자리).
 *
 * 권한·역할을 바꾸는 단계(`grant.*`·`role.set`)와 초대는 **API 로** 한다. 그 화면(설정 › 멤버)을 누르는
 * 시험은 아직 없다 — 결과표에 `via: api` 로 남긴다. 화면이 받아야 할 것은 그 뒤의 변화다.
 */
import { expect, type Browser, type Page } from '@playwright/test';
import type { Journey, Step } from '../src/stories.js';
import { loginAs, readSeed } from './session.js';

export interface WebStepResult { index: number; act: string; as: string; outcome: 'passed' | 'skipped'; detail: string }

interface State {
  browser: Browser;
  pages: Map<string, Page>;
  tokens: Map<string, string>;
  channel?: { id: string; name: string };
  invite?: string;
  /** 여정이 바꾼 권한·역할 — 끝에서 거꾸로 되돌린다(같은 서버를 다음 시험이 쓴다). */
  undo: Array<() => Promise<unknown>>;
}

/**
 * 화면 게이트 이름 → 찾는 법. 설정 안에 있는 것은 `settings` 로 그 칸을 열고(⌘, 와 같은 길), 보고 나면 되돌아 나온다.
 * [+ 에이전트 만들기]는 레일 Agents 칸이 아니라 설정 › 에이전트 목록(`AgentGrid`)에만 선다.
 */
const UI_TARGETS: Record<string, { testId: string; settings?: string; blocked?: string }> = {
  'channel-create': { testId: 'add-channel' },
  // `blocked`: 「없음」을 보기 전에 그 자리의 안내 칸이 서는 것을 먼저 본다 — 목록을 받기 전의 빈 화면에서
  // 「없음」이 거저 통과하지 않게.
  'agent-create': { testId: 'agent-create', settings: 'agents', blocked: 'agent-create-blocked' },
};

async function api<T>(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: T }> {
  const seed = readSeed();
  const res = await fetch(`${seed.server}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

async function token(s: State, persona: string): Promise<string> {
  const have = s.tokens.get(persona);
  if (have) return have;
  const seed = readSeed();
  const account = seed.accounts[persona];
  if (!account) throw new Error(`${persona} 는 시드되지 않았다`);
  const res = await fetch(`${seed.server}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId: account.handle, password: seed.password }),
  });
  const t = ((await res.json()) as { token: string }).token;
  s.tokens.set(persona, t);
  return t;
}

async function page(s: State, persona: string): Promise<Page> {
  const have = s.pages.get(persona);
  if (have) return have;
  const p = await loginAs(s.browser, persona);
  s.pages.set(persona, p);
  return p;
}

function targetId(step: Step): string {
  const id = readSeed().accounts[String(step.target)]?.id;
  if (!id) throw new Error(`target ${step.target} 는 시드되지 않았다`);
  return id;
}

async function ok(r: { status: number }, what: string): Promise<void> {
  if (r.status >= 300) throw new Error(`${what} → ${r.status}`);
}

type Handler = (s: State, step: Step) => Promise<string | null>;

const handlers: Partial<Record<Step['act'], Handler>> = {
  async login(s, step) {
    await page(s, step.as);
    return '로그인 → 주 화면';
  },
  async 'grant.give'(s, step) {
    const t = await token(s, step.as);
    const path = `/accounts/${targetId(step)}/grants`;
    await ok(await api('PUT', path, t, { capability: step.with?.capability }), 'grant 주기');
    // 여정 안에서 이미 거뒀으면(J4) 서버는 404 다 — 되돌릴 것이 없다는 뜻이라 실패로 치지 않는다.
    s.undo.push(async () => {
      const r = await api('DELETE', `${path}/${String(step.with?.capability)}`, t);
      if (r.status !== 404) await ok(r, '되돌리기: grant 거두기');
    });
    return `via api: ${step.target} ← ${String(step.with?.capability)}`;
  },
  async 'grant.revoke'(s, step) {
    await ok(await api('DELETE', `/accounts/${targetId(step)}/grants/${String(step.with?.capability)}`, await token(s, step.as)), 'grant 거두기');
    return `via api: ${step.target} ✕ ${String(step.with?.capability)}`;
  },
  async 'role.set'(s, step) {
    const t = await token(s, step.as);
    const persona = String(step.target);
    const before = readSeed().accounts[persona]?.role;
    await ok(await api('PUT', `/accounts/${targetId(step)}/role`, t, { role: step.with?.role }), '역할 바꾸기');
    if (before) s.undo.push(async () => ok(await api('PUT', `/accounts/${targetId(step)}/role`, t, { role: before }), '되돌리기: 역할'));
    return `via api: ${step.target} → ${String(step.with?.role)}`;
  },
  async 'channel.create'(s, step) {
    const name = `e2e-${Date.now().toString(36)}`;
    const r = await api<{ id: string }>('POST', '/channels', await token(s, step.as), { name, visibility: step.with?.visibility ?? 'public' });
    await ok(r, '채널 만들기');
    s.channel = { id: r.json.id, name };
    return `via api: 채널 ${name}`;
  },
  async 'channel.invite'(s, step) {
    if (!s.channel) throw new Error('앞 단계에서 만든 채널이 없다');
    await ok(await api('POST', `/channels/${s.channel.id}/members`, await token(s, step.as), { accountId: targetId(step) }), '채널 초대');
    // 초대받은 사람의 열린 화면에 재시작 없이 생겨야 한다(여정 J8 의 기대).
    const p = s.pages.get(String(step.target));
    if (p) await expect(channelRow(p, s.channel.id)).toBeVisible({ timeout: 10_000 });
    return `via api 초대 → ${p ? '열린 화면에 채널이 생김' : '화면 없음'}`;
  },
  async 'ui.see'(s, step) { return seeOrNot(s, step, true); },
  async 'ui.notSee'(s, step) { return seeOrNot(s, step, false); },
};

/**
 * 사이드바의 채널 줄. 이름 글자로 찾지 않는다 — 비공개 줄은 🔒·안 읽음 표지가 같은 버튼 안에 있어
 * `getByText(이름, { exact })` 가 맞지 않고, 그러면 「없음」을 보는 단계가 늘 거짓으로 통과한다.
 */
function channelRow(p: Page, channelId: string) {
  return p.locator(`[data-channel-row="${channelId}"]`);
}

async function seeOrNot(s: State, step: Step, visible: boolean): Promise<string | null> {
  if (step.on && step.on !== 'desktop') return null;
  const p = await page(s, step.as);
  if (step.target === 'private-channel') {
    if (!s.channel) throw new Error('앞 단계에서 만든 채널이 없다');
    await expect(channelRow(p, s.channel.id)).toHaveCount(visible ? 1 : 0);
    return `사이드바 ${s.channel.name} ${visible ? '있음' : '없음'}`;
  }
  const t = UI_TARGETS[String(step.target)];
  if (!t) return null;
  if (t.settings) {
    await p.keyboard.press('ControlOrMeta+Comma');
    await p.getByTestId(`settings-nav-${t.settings}`).click();
  }
  const timeout = Number(step.with?.withinSec ?? 0) * 1000 || 3_000;
  const loc = p.getByTestId(t.testId);
  // 재시작 없이 바뀌는지 본다 — 페이지를 다시 읽지 않는다.
  try {
    if (visible) await expect(loc.first()).toBeVisible({ timeout });
    else {
      if (t.blocked) await expect(p.getByTestId(t.blocked)).toBeVisible({ timeout });
      await expect(loc).toHaveCount(0, { timeout });
    }
  } finally {
    if (t.settings) await p.getByTestId('settings-back').click();
  }
  return `${t.testId} ${visible ? '보임' : '없음'}${step.with?.withinSec ? `(${String(step.with.withinSec)}초 안, 재시작 없이)` : ''}`;
}

/** 여정 하나를 돈다. 화면으로 옮길 수 없는 단계는 건너뛴다. 실패는 그대로 던진다(Playwright 가 trace 를 남긴다). */
export async function runWebJourney(browser: Browser, journey: Journey): Promise<WebStepResult[]> {
  const s: State = { browser, pages: new Map(), tokens: new Map(), undo: [] };
  const out: WebStepResult[] = [];
  let failure: unknown;
  try {
    for (const [index, step] of journey.steps.entries()) {
      const base = { index, act: step.act, as: step.as };
      const handler = handlers[step.act];
      if (!handler || !readSeed().accounts[step.as]) {
        out.push({ ...base, outcome: 'skipped', detail: handler ? `${step.as} 미시드` : '브라우저 핸들러 없음' });
        continue;
      }
      const detail = await handler(s, step);
      out.push({ ...base, outcome: detail === null ? 'skipped' : 'passed', detail: detail ?? '이 기기/대상은 브라우저 몫 아님' });
    }
  } catch (e) {
    failure = e;
  }
  // 되돌리기는 화면을 닫기 **전에** 돈다(닫힌 뒤엔 실패해도 그 화면의 trace 가 없다). 되돌리기 오류는 모아 두고,
  // 여정이 이미 실패했으면 **원래 실패를 던진다** — 되돌리기 오류가 원래 실패를 덮으면 무엇이 깨졌는지 못 본다.
  const undoErrors: string[] = [];
  for (const u of s.undo.reverse()) {
    try { await u(); } catch (e) { undoErrors.push((e as Error).message); }
  }
  for (const p of s.pages.values()) await p.context().close().catch(() => undefined);
  if (failure !== undefined) {
    if (undoErrors.length && failure instanceof Error) failure.message += `\n(되돌리기도 실패: ${undoErrors.join(' · ')})`;
    throw failure;
  }
  if (undoErrors.length) throw new Error(`되돌리기 실패: ${undoErrors.join(' · ')}`);
  return out;
}
