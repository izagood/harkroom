/**
 * 시험 커뮤니티 시드 — 매 회 새로 띄운 서버에 페르소나 계정을 만든다(`stories/personas.yaml` 의 handle).
 *
 * 비밀번호는 **이 회차에서 새로 만든 난수**다. 서버가 회차마다 새로 뜨고 끝나면 지워지므로 저장소·CI
 * secrets 어디에도 둘 값이 없다. 시드 결과(계정 id·토큰·비밀번호)는 `web/.seed.json` 에만 쓰고
 * (gitignore), 시험이 읽는다. 실물 시험 테넌트(매일 회차)는 이 파일이 아니라 비밀로 받은 값을 쓴다.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { loadStoryboard } from '../src/stories.js';
import { SEED_FILE, type Seed } from './session.js';

/** 이 PR 에서 시드하는 페르소나. 여정 러너(PR4)가 늘린다. */
const SEEDED = ['P2', 'P4', 'P6'] as const;

async function call<T>(server: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${server}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

/** 서버 컨테이너는 떠도 마이그레이션이 끝나기 전엔 받지 않는다(compose 에 healthcheck 가 없다). */
async function waitHealthy(server: string, timeoutMs = 90_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${server}/healthz`)).ok) return;
    } catch { /* 아직 안 뜸 */ }
    if (Date.now() > until) throw new Error(`${server}/healthz 가 ${timeoutMs}ms 안에 뜨지 않았다`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export default async function seed(): Promise<void> {
  const server = process.env.E2E_SERVER;
  if (!server) throw new Error('E2E_SERVER 가 없다 — 새로 띄운 시험 서버 주소를 준다(예: http://127.0.0.1:3400)');
  await waitHealthy(server);
  const { personas } = loadStoryboard();
  const byId = new Map(personas.map((p) => [p.id, p]));
  const password = randomBytes(18).toString('base64url');
  const seedOut: Seed = { server, password, accounts: {} };

  // 새 서버의 첫 계정은 /bootstrap 으로만 만든다 — 이 사람이 owner 가 된다. 시험의 관리자(P2)를 owner 로
  // 두지 않으려고 별도의 시드 owner 를 먼저 만들고, P2 는 초대 → admin 승격으로 만든다.
  const owner = byId.get('P1')!;
  await call(server, 'POST', '/bootstrap', { handle: owner.handle, loginId: owner.handle, displayName: owner.title, password });
  const ownerLogin = await call<{ token: string }>(server, 'POST', '/auth/login', { loginId: owner.handle, password });

  for (const id of SEEDED) {
    const p = byId.get(id)!;
    const invite = await call<{ token: string }>(server, 'POST', '/invites', {}, ownerLogin.token);
    const reg = await call<{ id: string }>(server, 'POST', '/auth/register', {
      inviteToken: invite.token, handle: p.handle, loginId: p.handle, displayName: p.title, password,
    });
    if (p.role === 'admin' || p.role === 'guest') {
      await call(server, 'PUT', `/accounts/${reg.id}/role`, { role: p.role }, ownerLogin.token);
    }
    seedOut.accounts[id] = { id: reg.id, handle: p.handle };
  }
  writeFileSync(SEED_FILE, JSON.stringify(seedOut, null, 2));
}

