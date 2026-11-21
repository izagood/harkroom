-- Inbox 상태 보드(C안) 2/2 — **나만의** 스레드 처리 상태: 완료(치움)·나중에.
--
-- 왜 thread_status(088) 에 넣지 않는가: 그 표는 스레드마다 **하나**인 서버 판정(모두가 같은 값을
-- 본다)이다. 완료·나중에는 사람마다 다르다 — 내가 치운 일을 남의 보드에서 지우면 안 된다.
-- 그래서 키가 (계정, 루트)다.
--
-- 왜 리액션(✅)이 아닌가: 1/2 는 머리에 단 ✅ 를 "치움"으로 읽었다. 그것은 **남에게 보이는**
-- 표시라 개인 정리가 대화에 흔적을 남기고, 다른 뜻으로 단 ✅ 와 갈리지 않는다.
--
-- `until` 은 나중에의 깨어날 시각이다(완료면 null). 새 말이 오면 다시 서는 판정은 화면이
-- `updated_at` 과 항목 시각을 견주어 한다 — 서버는 사실만 둔다.
create table inbox_thread_state (
  account_id uuid not null references account(id) on delete cascade,
  root_id uuid not null references message(id) on delete cascade,
  state text not null check (state in ('done', 'later')),
  until timestamptz null,
  updated_at timestamptz not null default now(),
  primary key (account_id, root_id),
  check ((state = 'later') = (until is not null))
);
