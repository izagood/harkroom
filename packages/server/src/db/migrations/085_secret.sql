-- 비밀 보관소(085) — 사람이 넣은 키·토큰·파일을 **권한을 받은 에이전트만** 쓰게 한다.
-- 계획·보안 검토: 스레드 bc98df3a(2026-10-01, jaebin "시큐리티 안대로 진행").
--
-- 이 마이그레이션은 **저장**만 한다. 에이전트가 값을 받는 길(턴 임대·reveal·secret.mount)은
-- 다음 PR 이다 — 그 전까지는 값이 서버 밖으로 나가는 경로가 없다.
--
-- 값은 `secretKeyring.ts` 의 v2 봉투로만 들어간다: 키(KEK)는 파일 마운트로 읽고, 버전마다
-- HKDF 로 키를 따로 끌어내며, AAD 에 (secret_id, version, kind, kid) 를 묶는다. 그래서 DB 쓰기
-- 권한만으로 암호문을 다른 행에 옮겨 붙이면 풀리지 않는다(보안 검토 M3).
create table secret (
  id               uuid primary key default gen_random_uuid(),
  -- 에이전트가 `secret.mount(name)` 으로 부를 이름. 워크스페이스 안에서 하나다.
  name             text not null unique check (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  kind             text not null check (kind in ('text', 'file')),
  -- file 일 때 마운트할 때 알려 줄 원래 이름(경로로는 쓰지 않는다 — 파일 이름은 id 다, M5).
  filename         text null,
  description      text not null default '',
  -- 부여는 **소유자만** 한다(D4). admin 은 회수·삭제만.
  owner_account_id uuid not null references account(id) on delete cascade,
  expires_at       timestamptz null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 값의 판. 값을 바꾸면 새 판이 생기고, 옛 판의 암호문은 그 자리에서 지운다(sealed = null).
-- 이미 마운트된 파일은 그 턴이 끝날 때까지 산다 — 그것은 러너 쪽 수명이다.
create table secret_version (
  secret_id   uuid not null references secret(id) on delete cascade,
  version     int not null check (version > 0),
  sealed      text null,
  size_bytes  int not null check (size_bytes >= 0),
  created_by  uuid null references account(id) on delete set null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz null,
  primary key (secret_id, version)
);

-- 누가 받을 수 있나: 에이전트 × (채널, 선택) × 오퍼레이터(M1).
-- - channel_id null = 어느 채널의 턴에서든. 화면이 경고한다(M6).
-- - operator_id = 부여할 때 그 에이전트가 배정돼 있던 오퍼레이터. null 은 "어느 오퍼레이터든"
--   이고 소유자가 명시적으로 고른 경우뿐이다. grant 의 경계는 오퍼레이터다(H2).
-- - suspended_at: 배정·지시문·하네스가 바뀌면 정지된다(다음 PR). 소유자가 다시 주면 풀린다.
create table secret_grant (
  id             uuid primary key default gen_random_uuid(),
  secret_id      uuid not null references secret(id) on delete cascade,
  agent_id       uuid not null references account(id) on delete cascade,
  channel_id     uuid null references channel(id) on delete cascade,
  operator_id    uuid null references operator(id) on delete cascade,
  granted_by     uuid not null references account(id),
  granted_at     timestamptz not null default now(),
  suspended_at   timestamptz null,
  suspend_reason text null
);
create unique index secret_grant_uniq on secret_grant
  (secret_id, agent_id, coalesce(channel_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index secret_grant_agent_idx on secret_grant (agent_id);

-- 누가 언제 받았나 — 거절도 남긴다. **값도 값의 해시도 넣지 않는다**(짧은 토큰은 해시로
-- 역산된다). 비밀을 지워도 기록은 남아야 하므로 secret 에 외래 키를 걸지 않는다.
create table secret_access_log (
  id             bigserial primary key,
  secret_id      uuid not null,
  secret_name    text not null,
  version        int null,
  agent_id       uuid null,
  operator_id    uuid null,
  turn_id        uuid null,
  channel_id     uuid null,
  thread_root_id uuid null,
  result         text not null check (result in ('granted', 'denied')),
  reason         text null,
  at             timestamptz not null default now()
);
create index secret_access_log_secret_idx on secret_access_log (secret_id, at desc);
