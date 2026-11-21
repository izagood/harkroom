-- 메시지 리액션. (message_id, account_id, emoji) 가 PK 인 이유는 같은 사람이 같은 이모지를
-- 두 번 눌러도 하나여야 하기 때문이다 — 더블클릭·재전송으로 흔히 생긴다.
create table if not exists message_reaction (
  message_id uuid not null references message(id) on delete cascade,
  account_id uuid not null references account(id) on delete cascade,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, account_id, emoji)
);

-- 메시지 목록을 그릴 때마다 채널 한 페이지분의 리액션을 message_id 로 모아 온다.
create index if not exists message_reaction_message_idx on message_reaction (message_id);
