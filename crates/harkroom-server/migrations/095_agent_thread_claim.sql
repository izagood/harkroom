-- (에이전트, 스레드) 턴 임대(스레드 harkroom://message/ca992991-0107-4c66-bf05-ec91a955428f, jaebin 안 B).
--
-- 앱을 업데이트하면 옛 러너가 하던 턴을 마저 끝내는 동안 새 러너가 이미 인박스를 본다(#866). 그 사이
-- 같은 스레드에 새 멘션이 오면 새 러너가 같은 스레드·같은 하네스 세션에 **두 번째 턴**을 띄웠다 —
-- 스레드 잠금이 러너 프로세스 안에만 있어서다. 그 잠금을 서버로 옮긴 것이 이 표다: 같은
-- (에이전트, 스레드)에는 임대를 쥔 러너(holder) 하나만 턴을 띄운다.
--
-- holder 는 러너가 기동 때 지은 무작위 id 다(같은 에이전트의 러너 둘을 가른다 — 둘 다 같은 에이전트
-- 자격으로 붙으므로 계정 id 로는 못 가른다). 러너는 턴 동안 짧은 주기로 expires_at 을 밀고(하트비트),
-- 턴이 끝나면 지운다. 러너가 죽으면 하트비트가 끊겨 expires_at 이 지나고, 그때 다른 러너가 넘겨받는다.
--
-- channel_id·thread_root_id 에 FK 를 걸지 않는다: 행은 길어야 몇 분 사는 임대라 남는 것은 만료된 행뿐이고
-- (claim 이 그 에이전트의 오래된 행을 치운다), FK 는 지워진 채널의 멘션을 마저 처리하는 턴을 500 으로 만든다.
create table agent_thread_claim (
  agent_id uuid not null references account(id) on delete cascade,
  channel_id uuid not null,
  thread_root_id uuid not null,
  holder text not null,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (agent_id, channel_id, thread_root_id)
);
