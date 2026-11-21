-- 에이전트 presence(S5.3 C6c-1, Rust 전환). TS `mcp/presence.ts` 의 메모리 상태를 DB 로도 남겨
-- Rust 앞단(`/ws` 의 presence.snapshot)이 TS 와 같은 에이전트 목록을 낼 수 있게 한다.
--
-- 칸은 계정 id·시각뿐이다(security C6c ①). 폴 내용·도구 이름·채널은 남기지 않는다.
-- - expires_at: 마지막으로 DB 에 쓴 폴의 만료 시각(쓴 때 now() + TTL). TS 는 같은 에이전트의 폴을 10초에 한 번만 쓴다 —
--   그래서 DB 의 만료는 TS 메모리보다 최대 10초 이르다. 판정은 `expires_at > now()`(DB 시계) 하나다.
-- - 오프라인이 된 시각은 따로 두지 않는다: `expires_at <= now()` 인 행의 expires_at 이 곧 그것이다(TS offlineSince 와 같은 기준점).
create table if not exists agent_presence (
  account_id uuid primary key references account(id) on delete cascade,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists agent_presence_expires_at_idx on agent_presence (expires_at);
