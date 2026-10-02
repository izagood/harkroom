-- 모바일 푸시 P1(designer 개선안 harkroom://message/5afd59e0-9e38-4273-8e9a-2aebcc426d55, jaebin D1):
-- 에이전트의 보통 답은 **스레드마다 10분에 첫 한 번만** 소리를 낸다. 그 "마지막으로 울린 때"를
-- (받는 사람, 묶음 키) 별로 든다. 묶음 키는 APNs `thread-id` 와 같은 값(스레드 루트 id)이다.
-- 서버가 여러 개 떠도 같은 값을 보게 메모리가 아니라 표에 둔다. 사람이 지워지면 함께 지운다.
create table push_thread_sound (
  account_id uuid not null references account(id) on delete cascade,
  thread_key text not null,
  sounded_at timestamptz not null,
  primary key (account_id, thread_key)
);
