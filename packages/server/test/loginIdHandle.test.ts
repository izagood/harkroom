// #271 회귀선 — 로그인 ID 분리와 멘션의 정본화. **전부 서버를 통과한다.**
//
// 순수 함수(`normalizeMentions` 등)만 단언하면 라우트가 그 함수를 부르지 않아도 초록이고,
// 그것이 이 작업에서 실제로 났던 사고다: 정규화가 채널 멤버 목록으로 좁혀져 있어서 public
// 채널의 멘션이 통째로 알림을 잃었는데, 함수 자체는 멀쩡했다. 그래서 여기서는 메시지를
// 올리고 **저장된 본문**과 **inbox 행**을 본다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let pool: Pool;
let stop: () => Promise<void>;
let adminToken: string;
let adminId: string;
let fizzToken: string;
let fizzId: string;
let buzzId: string;
let forgeId: string;
let forgePat: string;
let channelId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** 초대 → 가입 → 로그인. 로그인 ID 와 handle 을 **따로** 준다(요구 2). */
async function register(
  loginId: string, handle: string,
): Promise<{ id: string; token: string }> {
  const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
  const created = await app.inject({
    method: 'POST', url: '/auth/register',
    payload: {
      handle, loginId, displayName: handle, password: 'pw123456',
      inviteToken: inv.json().token as string,
    },
  });
  expect(created.statusCode).toBe(201);
  const login = await app.inject({
    method: 'POST', url: '/auth/login', payload: { loginId, password: 'pw123456' },
  });
  expect(login.statusCode).toBe(200);
  return { id: created.json().id as string, token: login.json().token as string };
}

async function post(token: string, body: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(token), payload: { body },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 저장된 **정본**. REST 응답이 아니라 DB 를 본다 — 응답만 보면 라우트가 응답에서만 고쳐도 통과한다. */
async function storedBody(messageId: string): Promise<string> {
  const res = await pool.query<{ body: string }>(`select body from message where id = $1`, [messageId]);
  return res.rows[0]!.body;
}

async function inboxIds(token: string, messageId: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/inbox', headers: auth(token) });
  expect(res.statusCode).toBe(200);
  return (res.json().entries as { messageId: string }[]).filter((e) => e.messageId === messageId).length;
}

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
  app = await buildServer({ pool });
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));

  ({ id: fizzId, token: fizzToken } = await register('fizz-login', 'fizz'));
  ({ id: buzzId } = await register('buzz-login', 'buzz'));
  ({ accountId: forgeId, pat: forgePat } = await createAgent(app, adminToken, 'forge'));

  // **public standard 채널**이다. 이 선택이 핵심이다: public 채널에는 `channel_member` 행이
  // 아예 없으므로(`createChannel` 은 private 에만 첫 멤버를 넣는다), 정규화가 멤버 목록으로
  // 좁혀져 있으면 여기서 멘션이 통째로 사라진다.
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'talk' },
  });
  expect(ch.statusCode).toBe(201);
  channelId = ch.json().id as string;
});
afterAll(async () => { await app.close(); await stop(); });

describe('#271-1 로그인은 login_id 로만 한다', () => {
  it('로그인 ID 로 로그인된다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'fizz-login', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('**handle 로는 로그인되지 않는다**', async () => {
    // 이 선이 1부 전체의 값이다. handle 로도 되면 이름을 바꿀 때 로그인이 함께 흔들린다.
    const res = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'fizz', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('로그인 ID 는 대소문자를 무시한다', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'FIZZ-Login', password: 'pw123456' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('같은 로그인 ID 는 대소문자를 달리해도 두 번 만들어지지 않는다', async () => {
    const inv = await app.inject({ method: 'POST', url: '/invites', headers: auth(adminToken) });
    const dup = await app.inject({
      method: 'POST', url: '/auth/register',
      payload: {
        handle: 'someoneelse', loginId: 'Fizz-Login', displayName: 'X', password: 'pw123456',
        inviteToken: inv.json().token as string,
      },
    });
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('#271-5 저장되는 정본은 <@id> 다', () => {
  it('public 채널에서도 @handle 이 <@id> 로 저장된다', async () => {
    const id = await post(adminToken, '@fizz 이거 봐줘');
    expect(await storedBody(id)).toBe(`<@${fizzId}> 이거 봐줘`);
  });

  it('없는 handle 은 글자 그대로 남는다 — 오타를 멘션처럼 보이지 않게', async () => {
    const id = await post(adminToken, '@nobodyhere 안녕');
    expect(await storedBody(id)).toBe('@nobodyhere 안녕');
  });

  it('코드 블록 안의 @handle 은 바뀌지 않는다 (#298 과 같은 판정)', async () => {
    // **같은 handle 을 평문과 코드에 둘 다 둔다.** 코드에만 두면 그 handle 이 애초에
    // 대상 목록에 들어오지 않아(`mentionedHandles` 가 코드를 걷어낸다) 정규화가 코드를
    // 보든 말든 결과가 같다 — 그러면 이 줄은 아무것도 지키지 않는다. 평문에 같은 이름이
    // 있어야 목록에 들어오고, 그때 코드 안의 것까지 바뀌는지가 비로소 드러난다.
    const body = '평문 @fizz\n```\n@fizz 는 코드다\n```\n`@fizz` 도 코드다';
    const id = await post(adminToken, body);
    expect(await storedBody(id)).toBe(
      `평문 <@${fizzId}>\n\`\`\`\n@fizz 는 코드다\n\`\`\`\n\`@fizz\` 도 코드다`,
    );
    // 알림은 한 번이다 — 평문 하나가 부른 것이고, 코드 두 개는 부른 것이 아니다.
    expect(await inboxIds(fizzToken, id)).toBe(1);
  });

  it('코드 **안에만** 있는 @handle 은 정규화도 알림도 없다', async () => {
    const id = await post(adminToken, '```\n@buzz 는 코드 안에만 있다\n```');
    expect(await storedBody(id)).toBe('```\n@buzz 는 코드 안에만 있다\n```');
  });

  it('수정도 같은 정규화를 탄다', async () => {
    const id = await post(adminToken, '처음에는 아무도');
    const res = await app.inject({
      method: 'PATCH', url: `/channels/${channelId}/messages/${id}`, headers: auth(adminToken),
      payload: { body: '이제 @fizz 를 부른다' },
    });
    expect(res.statusCode).toBe(200);
    expect(await storedBody(id)).toBe(`이제 <@${fizzId}> 를 부른다`);
  });
});

describe('#271-6 알림은 <@id> 에서 판정된다', () => {
  it('public 채널의 멘션이 inbox 를 만든다', async () => {
    const id = await post(adminToken, '@fizz 와 @buzz 둘 다');
    expect(await inboxIds(fizzToken, id)).toBe(1);
    const stored = await storedBody(id);
    expect(stored).toContain(`<@${fizzId}>`);
    expect(stored).toContain(`<@${buzzId}>`);
  });

  it('작성자 자신은 알림을 받지 않는다', async () => {
    const id = await post(fizzToken, '@fizz 혼잣말');
    expect(await inboxIds(fizzToken, id)).toBe(0);
  });
});

describe('#271-9 MCP 는 @현재handle 로 역정규화해 준다', () => {
  it('에이전트가 읽는 본문에는 <@id> 가 없다', async () => {
    const id = await post(adminToken, '@fizz 확인해줘');
    // 에이전트는 handle 로 생각한다 — 토큰을 그대로 주면 에이전트가 그것을 되받아 쓴다.
    const rows = await pool.query<{ body: string }>(`select body from message where id = $1`, [id]);
    expect(rows.rows[0]!.body).toContain('<@');

    const { denormalizeBodies } = await import('../src/services/mentions.js');
    const [out] = await denormalizeBodies(pool, [{ body: rows.rows[0]!.body }]);
    expect(out!.body).toBe('@fizz 확인해줘');
  });
});

describe('#271-10 검색어의 @handle 도 정본에 맞춘다', () => {
  it('@handle 로 검색하면 <@id> 로 저장된 메시지를 찾는다', async () => {
    const id = await post(adminToken, '@buzz 검색용 메시지 zzqq');
    const res = await app.inject({
      method: 'GET', url: '/search?q=' + encodeURIComponent('@buzz'), headers: auth(adminToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().messages as { id: string }[]).some((m) => m.id === id)).toBe(true);
  });
});

describe('#271-11 handle 변경', () => {
  it('사람은 자기 handle 을 바꾼다 — 본문 행은 그대로다', async () => {
    const id = await post(adminToken, '@buzz 이름 바뀌기 전');
    const before = await storedBody(id);

    const res = await app.inject({
      method: 'PATCH', url: '/accounts/me/handle', headers: auth(fizzToken), payload: { handle: 'fizzy' },
    });
    expect(res.statusCode).toBe(200);

    // 이름 변경은 본문을 **건드리지 않는다**. 이것이 2부 전체의 값이다 — 건드리면
    // 메시지가 많은 워크스페이스에서 이름 한 번 바꾸는 데 전수 갱신이 필요해진다.
    expect(await storedBody(id)).toBe(before);

    // 그리고 로그인 ID 는 그대로다 — handle 을 바꾼다고 로그인이 흔들리면 안 된다(1부).
    const login = await app.inject({
      method: 'POST', url: '/auth/login', payload: { loginId: 'fizz-login', password: 'pw123456' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('바꾼 뒤에는 새 이름으로 부를 수 있고 옛 이름은 계정이 아니다', async () => {
    const now = await post(adminToken, '@fizzy 새 이름으로');
    expect(await storedBody(now)).toBe(`<@${fizzId}> 새 이름으로`);
    const old = await post(adminToken, '@fizz 옛 이름으로');
    expect(await storedBody(old)).toBe('@fizz 옛 이름으로');
  });

  it('**에이전트 handle 변경은 400 이다** — 러너 상태가 handle 스코프다(#167)', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/accounts/me/handle', headers: auth(forgePat), payload: { handle: 'forge2' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('agent_handle_immutable');

    const admin = await app.inject({
      method: 'PATCH', url: `/accounts/${forgeId}/handle`, headers: auth(adminToken),
      payload: { handle: 'forge2' },
    });
    expect(admin.statusCode).toBe(400);
    expect(admin.json().error.code).toBe('agent_handle_immutable');
  });

  it('남의 handle 은 admin 만 바꾼다', async () => {
    const theirs = await app.inject({
      method: 'PATCH', url: `/accounts/${buzzId}/handle`, headers: auth(fizzToken),
      payload: { handle: 'stolen' },
    });
    expect(theirs.statusCode).toBe(403);

    const byAdmin = await app.inject({
      method: 'PATCH', url: `/accounts/${buzzId}/handle`, headers: auth(adminToken),
      payload: { handle: 'buzzz' },
    });
    expect(byAdmin.statusCode).toBe(200);
  });

  it('이미 쓰는 이름이면 409 다', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/accounts/me/handle', headers: auth(fizzToken), payload: { handle: 'buzzz' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('handle_taken');
  });

  it('대문자가 섞인 handle 은 형식에서 걸린다 — 유니크 검사까지 가지 않는다', async () => {
    // 충돌 검사는 `lower(handle)` 로 하지만(그래야 저장된 값이 어떤 대소문자든 안전하다),
    // 입력 형식 자체가 소문자만 허용한다. 그 둘이 다른 층이라는 것을 여기 고정한다 —
    // 형식 검사를 느슨하게 풀면 `Buzzz` 가 만들어져 `@buzzz` 와 같은 이름이 둘이 된다.
    const res = await app.inject({
      method: 'PATCH', url: '/accounts/me/handle', headers: auth(fizzToken), payload: { handle: 'BUZZZ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('감사에 from·to 가 남는다', async () => {
    const res = await pool.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where action = 'account.handle.changed' order by id`,
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows[0]!.detail).toEqual({ from: 'fizz', to: 'fizzy' });
  });

  it('admin 자신도 바꿀 수 있다 — 부트스트랩 계정이 예외가 아니다', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/accounts/me/handle', headers: auth(adminToken), payload: { handle: 'boss' },
    });
    expect(res.statusCode).toBe(200);
    const row = await pool.query<{ handle: string }>(`select handle from account where id = $1`, [adminId]);
    expect(row.rows[0]!.handle).toBe('boss');
  });
});
