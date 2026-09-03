-- 기존 메시지의 @handle 멘션을 <@id> 로 한 번migration(#271).
-- 이 migration 은 일회성이다 — 이후(handle 변경 후) 본문을 다시 쓰지 않고
-- 화면에서 현재 handle 로 매핑한다.
--
-- #230 그룹 멘션(@그룹)은 이 작업 범위 밖이다.
--
-- 주의: 경계 검사를 정확히 해야 한다. @handlex 에서 @handle 부분을 바꾸면 안 된다.
-- MENTION_PATTERN 의 경계 조건: (^|[^a-zA-Z0-9_-])@handle

-- 각 계정의 handle 대해 순회하며 업데이트
do $$
declare
  acc record;
begin
  for acc in select id, handle from account where kind = 'human' loop
    update message
    set body = regexp_replace(
      body,
      '(^|[^a-zA-Z0-9_-])@(' || acc.handle || ')(?![a-zA-Z0-9_-])',
      '\1<@' || acc.id || '>',
      'g'
    )
    where body ~ ('(^|[^a-zA-Z0-9_-])@(' || acc.handle || ')(?![a-zA-Z0-9_-])');
  end loop;
  
  raise notice 'Migration 034 completed: mention tokens updated';
end $$;