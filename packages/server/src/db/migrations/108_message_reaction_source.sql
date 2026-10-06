-- 스레드 상태를 **진짜 리액션**으로 단다(2026-10-06, jaebin — 088 의 D안을 고친다).
--
-- 왜: 상태가 `thread_status` 에만 있으면 그것을 따로 그리는 프론트엔드(데스크톱)에서만 보인다.
-- 모바일·웹은 리액션만 그리므로 상태를 몰랐다. 상태를 리액션으로 달면 모든 화면이 이미 그리는
-- 그대로 같게 보인다. `thread_status` 는 판정 결과의 저장소로 남는다(Inbox 보드·operator 정리기가 읽는다).
--
-- 088 이 리액션을 피한 이유(사람 👀 와 상태 👀 를 가를 수 없다)는 `source` 로 푼다:
--   - `user`   — 사람·에이전트가 REST·MCP 로 단 것. 지금까지의 모든 행.
--   - `status` — 서버가 상태 주인 에이전트 이름으로 단 것(`services/threadStatus.ts`). 상태가 바뀌면
--                서버가 이 행만 떼고 새로 단다. 사람 API 로는 지워지지 않고, 20개 상한에도 안 센다.
-- 같은 (메시지, 계정, 이모지)는 여전히 한 행이다 — 에이전트가 손으로 단 👀 가 이미 있으면 상태 행은
-- 새로 생기지 않고, 손으로 다시 달면 `user` 로 올라간다(상태가 바뀌어도 남는다).
alter table message_reaction
  add column source text not null default 'user' check (source in ('user', 'status'));

-- 상태가 바뀔 때 루트의 상태 행만 찾는다.
create index message_reaction_status on message_reaction (message_id) where source = 'status';

-- 이미 판정된 스레드를 채운다. ✅(done)는 달지 않는다 — 끝나면 상태 리액션을 뗀다(jaebin B2):
-- ✅ 는 사람이 "치움"으로 누르는 이모지라 상태 ✅ 와 한 칩으로 섞인다. 주인 모름(null)도 달지 않는다.
insert into message_reaction (message_id, account_id, emoji, source)
select ts.root_id, ts.account_id, ts.emoji, 'status'
from thread_status ts join message m on m.id = ts.root_id
where ts.status <> 'done' and ts.account_id is not null and m.deleted_at is null
on conflict do nothing;
