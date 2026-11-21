-- 스레드 상태 리액션(D안). 스레드 루트마다 **하나**만 있는 서버 판정 결과다.
--
-- 왜 message_reaction 에 넣지 않는가: 그 표의 키는 (메시지, 계정, 이모지)라 "루트에 언제나
-- 하나"를 표가 지켜 주지 못하고, 사람이 단 ✅ 와 상태 ✅ 가 같은 행 모양이라 화면·Inbox
-- 집계가 둘을 가를 수 없다. 여기서는 키가 루트 하나이므로 바뀌면 덮어쓰는 것이 곧
-- "이전 것을 뗀다"이고, 사람 리액션은 아예 건드리지 않는다.
--
-- 판정 규칙은 shared/src/threadStatus.ts::decideThreadStatus 하나다. 이 표는 그 결과의
-- 저장소일 뿐이다 — 목록이 매번 판정하지 않아도 되고, 바뀐 순간만 이벤트로 나간다.
create table thread_status (
  root_id uuid primary key references message(id) on delete cascade,
  status text not null check (status in ('received', 'running', 'waiting', 'my-turn', 'stuck', 'done')),
  emoji text not null,
  account_id uuid null references account(id) on delete set null,
  reason text null,
  updated_at timestamptz not null default now()
);

-- presence 가 바뀌면 그 에이전트가 주인인 스레드만 다시 판정한다(services/threadStatus.ts).
create index thread_status_account on thread_status (account_id);
