-- 메시지를 나중에 볼 것으로 담는다(#219). **개인 전용** — 남이 볼 수 없다.
-- 모든 라우트가 요청자 자신의 행만 다룬다.
--
-- 상태는 둘 — `open` / `done`. 보관 상태는 두지 않는다(#219 결정 1).
-- 메시지가 삭제되어도 "삭제된 메시지" 로 남는다(#219 결정 3).
-- FK 는 message(id) 그대로 — 하드 삭제가 없다(009 주석).
create table saved_message (
  account_id uuid not null references account(id) on delete cascade,
  message_id uuid not null references message(id),
  state text not null default 'open' check (state in ('open','done')),
  created_at timestamptz not null default now(),
  done_at timestamptz null,
  primary key (account_id, message_id)
);

-- 내 저장된 메시지 조회 — state 로 필터한다.
create index saved_message_account_state_idx on saved_message (account_id, state, created_at desc);
