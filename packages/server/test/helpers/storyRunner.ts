/**
 * API 여정 러너 — `@harkroom/e2e` 의 스토리보드(`packages/e2e/stories`)를 서버에 `app.inject` 로 돈다.
 *
 * 화면이 아니라 **서버 판정**을 본다: 같은 여정에서 사람마다 서버가 허락·거절하는지, 권한을 바꾼 뒤
 * `/auth/me` 의 `capabilities`(화면 게이트가 읽는 값)가 바뀌는지. 화면에만 뜻이 있는 단계(`ui.*` 중 API 로
 * 옮길 수 없는 것, 기기 조작)는 건너뛰고 「화면 몫」으로 센다 — 브라우저·모바일 러너가 본다.
 *
 * 동작마다 핸들러가 하나다. 핸들러가 없는 동작은 실패가 아니라 `skipped` 로 남는다 — 대신 시험이
 * "api 러너를 단 여정이 한 단계도 못 돌면" 실패시킨다(돌지 않는 러너를 "시험 있음"으로 세지 않으려고).
 */
import type { FastifyInstance } from 'fastify';
import type { Journey, Persona, Step } from '@harkroom/e2e';

export interface Actor { id: string; token: string; handle: string }
export interface RunState {
  app: FastifyInstance;
  actors: Map<string, Actor>;
  /** 여정 안에서 마지막으로 만든 채널 — `:channel` 자리에 들어간다. */
  channelId?: string;
  /** 여정 안에서 마지막으로 만든 초대 토큰 — `invite.accept` 가 쓴다. */
  inviteToken?: string;
  /** 시드 계정 공통 비밀번호(fixtures 와 같다) — step-up·가입에 쓴다. */
  password: string;
}
export interface StepResult { index: number; act: string; as: string; outcome: 'passed' | 'failed' | 'skipped'; detail: string }

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 화면 게이트 이름 → `/auth/me` capabilities 의 능력. 화면이 이 능력을 보고 버튼을 그린다. */
const UI_CAPABILITY: Record<string, string> = {
  'agent-create': 'agent.create',
  'channel-create': 'channel.create',
};

type Handler = (s: RunState, step: Step, actor: Actor) => Promise<string | null>;

function targetActor(s: RunState, step: Step): Actor {
  const t = s.actors.get(String(step.target));
  if (!t) throw new Error(`target ${step.target} 는 시드된 페르소나가 아니다`);
  return t;
}

/** "METHOD /path" 를 나눈다. `:channel` 은 여정의 마지막 채널, `:P<n>` 은 그 페르소나의 계정 id 로 바꾼다. */
function request(s: RunState, target: unknown): { method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; url: string } | null {
  const m = /^(GET|POST|PUT|DELETE|PATCH) (\/\S*)$/.exec(String(target ?? ''));
  if (!m) return null;
  const url = m[2]!
    .replace(':channel', s.channelId ?? 'missing-channel')
    .replace(/:(P\d+)/g, (_, id: string) => s.actors.get(id)?.id ?? `missing-${id}`);
  return { method: m[1] as 'GET', url };
}

async function capabilities(s: RunState, actor: Actor): Promise<string[]> {
  const me = await s.app.inject({ method: 'GET', url: '/auth/me', headers: auth(actor.token) });
  if (me.statusCode !== 200) throw new Error(`/auth/me ${me.statusCode}`);
  return (me.json().capabilities ?? []) as string[];
}

const handlers: Partial<Record<Step['act'], Handler>> = {
  async 'grant.give'(s, step, actor) {
    const target = targetActor(s, step);
    const res = await s.app.inject({ method: 'PUT', url: `/accounts/${target.id}/grants`, headers: auth(actor.token), payload: { capability: step.with?.capability } });
    if (res.statusCode !== 200) throw new Error(`grant 주기 ${res.statusCode} ${res.body}`);
    return `${target.handle} ← ${String(step.with?.capability)}`;
  },
  async 'grant.revoke'(s, step, actor) {
    const target = targetActor(s, step);
    const res = await s.app.inject({ method: 'DELETE', url: `/accounts/${target.id}/grants/${String(step.with?.capability)}`, headers: auth(actor.token) });
    if (res.statusCode >= 300) throw new Error(`grant 거두기 ${res.statusCode} ${res.body}`);
    return `${target.handle} ✕ ${String(step.with?.capability)}`;
  },
  async 'role.set'(s, step, actor) {
    const target = targetActor(s, step);
    const res = await s.app.inject({ method: 'PUT', url: `/accounts/${target.id}/role`, headers: auth(actor.token), payload: { role: step.with?.role } });
    if (res.statusCode !== 200) throw new Error(`역할 바꾸기 ${res.statusCode} ${res.body}`);
    return `${target.handle} → ${String(step.with?.role)}`;
  },
  async 'channel.create'(s, step, actor) {
    const res = await s.app.inject({
      method: 'POST', url: '/channels', headers: auth(actor.token),
      payload: { name: `e2e-${Date.now().toString(36)}`, visibility: step.with?.visibility ?? 'public' },
    });
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`채널 만들기 ${res.statusCode} ${res.body}`);
    s.channelId = res.json().id as string;
    return `채널 ${s.channelId}`;
  },
  async 'channel.invite'(s, step, actor) {
    const target = targetActor(s, step);
    const res = await s.app.inject({ method: 'POST', url: `/channels/${s.channelId}/members`, headers: auth(actor.token), payload: { accountId: target.id } });
    if (res.statusCode >= 300) throw new Error(`채널 초대 ${res.statusCode} ${res.body}`);
    return `${target.handle} 을 채널에`;
  },
  async 'api.denied'(s, step, actor) {
    const req = request(s, step.target);
    if (!req) return null;
    const res = await s.app.inject({ ...req, headers: auth(actor.token), payload: req.method === 'GET' ? undefined : {} });
    // 기본은 401·403 만 거절로 친다 — 404 를 받아 주면 없는 경로를 적어도 통과해 버린다. 404 가 뜻이 있는
    // 단계(볼 수 없는 채널 등)는 `with.status` 로 적는다.
    const allowed = (step.with?.status as number[] | undefined) ?? [401, 403];
    if (!allowed.includes(res.statusCode)) throw new Error(`${req.method} ${req.url} 가 거절되지 않았다: ${res.statusCode}`);
    // `with.code` 가 있으면 **거절 사유**까지 본다 — 403 이 맞아도 다른 문(예: 멤버십이 아니라 역할)에서 막혔으면
    // 그 여정이 보려던 판정이 아니다.
    const code = step.with?.code as string | undefined;
    if (code !== undefined) {
      const got = (res.json() as { error?: { code?: string } } | null)?.error?.code;
      if (got !== code) throw new Error(`${req.method} ${req.url} 거절 사유가 다르다: ${String(got)} (기대 ${code})`);
    }
    return `${req.method} ${req.url} → ${res.statusCode}${code ? ` ${code}` : ''}`;
  },
  async 'invite.create'(s, _step, actor) {
    const res = await s.app.inject({ method: 'POST', url: '/invites', headers: auth(actor.token) });
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`초대 ${res.statusCode} ${res.body}`);
    s.inviteToken = res.json().token as string;
    return '초대 토큰 발급';
  },
  async 'password.resetIssue'(s, step, actor) {
    const target = targetActor(s, step);
    // 비밀번호에 닿는 일이라 서버가 step-up(비밀번호 재확인)을 요구한다 — 화면도 같은 확인 창을 띄운다.
    const up = await s.app.inject({ method: 'POST', url: '/auth/step-up', headers: auth(actor.token), payload: { password: s.password } });
    if (up.statusCode >= 300) throw new Error(`step-up ${up.statusCode} ${up.body}`);
    const res = await s.app.inject({ method: 'POST', url: `/accounts/${target.id}/password-reset-code`, headers: auth(actor.token), payload: {} });
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`재설정 코드 ${res.statusCode} ${res.body}`);
    return `${target.handle} 재설정 코드`;
  },
  async 'ui.see'(s, step, actor) {
    const cap = UI_CAPABILITY[String(step.target)];
    if (!cap) return null;
    if (!(await capabilities(s, actor)).includes(cap)) throw new Error(`/auth/me 에 ${cap} 가 없다`);
    return `/auth/me ∋ ${cap}`;
  },
  async 'ui.notSee'(s, step, actor) {
    const cap = UI_CAPABILITY[String(step.target)];
    if (!cap) return null;
    if ((await capabilities(s, actor)).includes(cap)) throw new Error(`/auth/me 에 ${cap} 가 남아 있다`);
    return `/auth/me ∌ ${cap}`;
  },
};

/**
 * 초대받은 새 사람(시드되지 않은 페르소나)이 앞 단계의 토큰으로 가입한다. 가입한 사람은 이후 단계의 actor 가 된다.
 * actor 가 없는 단계라서 handlers 표 밖에 둔다.
 */
async function acceptInvite(s: RunState, step: Step, persona: Persona): Promise<string> {
  if (!s.inviteToken) throw new Error('앞 단계에서 만든 초대가 없다');
  const reg = await s.app.inject({
    method: 'POST', url: '/auth/register',
    payload: { inviteToken: s.inviteToken, handle: persona.handle, loginId: persona.handle, displayName: persona.title, password: s.password },
  });
  if (reg.statusCode !== 200 && reg.statusCode !== 201) throw new Error(`가입 ${reg.statusCode} ${reg.body}`);
  const login = await s.app.inject({ method: 'POST', url: '/auth/login', payload: { loginId: persona.handle, password: s.password } });
  if (login.statusCode !== 200) throw new Error(`가입 뒤 로그인 ${login.statusCode}`);
  s.actors.set(step.as, { id: reg.json().id as string, token: login.json().token as string, handle: persona.handle });
  return `${persona.handle} 가입·로그인`;
}

/** 여정 하나를 돈다. 핸들러가 없거나 API 로 옮길 수 없는 단계는 `skipped`. 첫 실패에서 멈춘다. */
export async function runJourney(s: RunState, journey: Journey, personas: Persona[]): Promise<StepResult[]> {
  const out: StepResult[] = [];
  let failed = false;
  for (const [index, step] of journey.steps.entries()) {
    const base = { index, act: step.act, as: step.as };
    if (!failed && step.act === 'invite.accept') {
      const persona = personas.find((p) => p.id === step.as);
      try {
        out.push({ ...base, outcome: 'passed', detail: await acceptInvite(s, step, persona!) });
      } catch (e) {
        failed = true;
        out.push({ ...base, outcome: 'failed', detail: (e as Error).message });
      }
      continue;
    }
    const handler = handlers[step.act];
    const actor = s.actors.get(step.as);
    if (failed || !handler || !actor) {
      out.push({ ...base, outcome: 'skipped', detail: failed ? '앞 단계 실패' : !handler ? '화면 몫(API 핸들러 없음)' : `${step.as} 미시드` });
      continue;
    }
    try {
      const detail = await handler(s, step, actor);
      out.push({ ...base, outcome: detail === null ? 'skipped' : 'passed', detail: detail ?? '화면 몫(API 로 옮길 수 없음)' });
    } catch (e) {
      failed = true;
      out.push({ ...base, outcome: 'failed', detail: (e as Error).message });
    }
  }
  return out;
}

/** 시드할 페르소나 — 역할이 있는 사람만. P1 은 bootstrap owner 라 따로 만든다. */
export function seedable(personas: Persona[]): Persona[] {
  return personas.filter((p) => p.id !== 'P1' && p.role !== 'none' && !p.roles);
}
