-- 오퍼레이터 신원(스펙 2026-09-20-operator-and-permissions §3). 오퍼레이터는 사람의 기기다 —
-- 계정이 아니라 계정에 속한다. 토큰은 사람 세션과도 에이전트 PAT 과도 다른 종류라 테이블이
-- 따로다: 한 표에 섞으면 "이 토큰이 무엇을 할 수 있나"가 행마다 갈린다.
create table operator (
  id               uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null references account(id) on delete cascade,
  -- 사람이 붙인 이름: "맥북", "빌드 서버". 같은 사람이 여럿을 가질 수 있다.
  name             text not null,
  token_hash       text not null unique,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz,
  -- 폐기. 행은 남긴다 — 감사가 가리키는 대상이 사라지면 안 된다.
  revoked_at       timestamptz
);
create index operator_owner_idx on operator (owner_account_id);
