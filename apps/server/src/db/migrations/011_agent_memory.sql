-- 에이전트가 세션을 넘어 기억을 저장하는 테이블.
--
-- account 에 컬럼을 붙이지 않고 별도 테이블로 둔 이유(#139): 사람 계정에는 없는 개념이다.
-- agent_config(004)가 같은 논리로 별도 테이블을 쓰며, 같은 패턴을 따른다.
--
-- 키는 (account_id, slug) 다. account 에 FK 와 on delete cascade 를 걸어,
-- 계정이 지워지면 그 계정의 메모리도 함께 지워진다 — 남겨 둘 이유가 없고,
-- 남기면 삭제가 삭제가 아니게 된다(#111 의 message FK 와 같은 문제).
create table agent_memory (
  account_id uuid not null references account(id) on delete cascade,
  -- slug 문법: buzz의 NIP-AE에서 차용 — `core` 또는 `^mem/[a-z0-9][a-z0-9_-]{0,63}(/…)*$`
  slug text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (account_id, slug)
);

-- 문법 검사는 애플리케이션 경계(MCP)에서 하고, DB는 값싼 제약만 건다.
-- 255바이트는 slug 최대 길이다.
alter table agent_memory add constraint agent_memory_slug_length check (octet_length(slug) <= 255);