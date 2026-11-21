-- 살아 있는 러너 세션(S5.3 C6c-2, Rust 전환). TS `ws/relay.ts` 가 메모리에 든 세션 목록을 DB 에도 남겨, 릴레이가 없는
-- 프로세스(Rust 위임 기한 C5f 등)가 「그 에이전트의 턴이 아직 도는가」를 같은 답으로 읽게 한다.
--
-- 칸은 허용 목록뿐이다(security C6c ①): 계정·풀 **이름**(폴더 이름이라 사람 이름일 수 있다, #1039)·프레임 원문(jsonb)·
-- viewKey/writerKey·바이트 수는 넣지 않는다.
--
-- 유령 행(security C6c ①″): 서버가 비정상으로 죽으면 「러너가 끊기면 지운다」가 돌지 않는다. 그래서 행마다 그 행을 쓴 허브
-- 인스턴스(`hub_epoch`)를 싣고, 허브는 `relay_hub.seen_at` 을 주기적으로 갱신한다. 읽는 쪽은 seen_at 이 TTL 안인 허브의 행만
-- 보고, 쓸기는 seen_at 이 TTL 을 넘긴 허브 줄만 지운다(행은 cascade). 살아 있는 다른 허브의 줄은 짐작으로 지우지 않는다.
create table if not exists relay_hub (
  hub_epoch uuid primary key,
  impl text not null check (impl in ('ts', 'rust')),
  started_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);

create table if not exists agent_session_live (
  session_id text primary key check (length(session_id) between 1 and 128),
  -- 주인은 프레임 본문이 아니라 **인증된 러너 링크**에서 온다(①′). 다른 에이전트의 러너가 같은 session_id 를 보내도
  -- 쓰는 쪽이 `where agent_account_id = excluded.agent_account_id` 로 막는다.
  agent_account_id uuid not null references account(id) on delete cascade,
  operator_id uuid references operator(id) on delete cascade,
  channel_id uuid not null,
  thread_root_id uuid,
  harness text not null check (length(harness) between 1 and 32),
  mode text check (mode in ('mention', 'interactive')),
  -- 러너 시계(AgentSessionView.startedAt). 못 읽으면 null.
  started_at timestamptz,
  status text not null default 'running' check (status in ('running')),
  claude_pool_rank integer check (claude_pool_rank >= 1),
  claude_account_rank integer check (claude_account_rank >= 1),
  hub_epoch uuid not null references relay_hub(hub_epoch) on delete cascade,
  updated_at timestamptz not null default now()
);

create index if not exists agent_session_live_agent_idx on agent_session_live (agent_account_id);
create index if not exists agent_session_live_hub_idx on agent_session_live (hub_epoch);
