-- 기존 본문의 `@handle` 을 `<@id>` 로 **한 번** 바꾼다(#271).
--
-- 일회성 형식 전환이다. 이 뒤로 handle 이 바뀌어도 본문은 다시 쓰지 않는다 — 읽는
-- 가장자리(데스크탑 화면, MCP 응답, 검색어)가 현재 handle 로 매핑한다. 그래서 이
-- 마이그레이션은 "이름을 따라가게 만드는" 것이 아니라 "정본 형식을 맞추는" 것이다.
--
-- **사람과 에이전트를 모두 바꾼다.** 사람만 바꾸면 `@forge` 같은 에이전트 멘션이 옛
-- 형식으로 남고, 그 뒤에 올라온 메시지만 `<@id>` 가 되어 같은 워크스페이스에 두 형식이
-- 공존한다. 에이전트 handle 은 바꿀 수 없지만(러너 상태가 handle 스코프, #167) 형식은
-- 하나여야 한다 — 읽는 쪽이 두 형식을 다 알아야 하는 상태를 남기지 않는다.
--
-- **경계 검사가 핵심이다.** `@handlex` 는 `@handle` 이 아니다. `MENTION_PATTERN`
-- (`shared/src/index.ts`)과 같은 조건을 쓴다: 앞은 `(^|[^a-zA-Z0-9_-])`, 뒤는
-- `(?![a-zA-Z0-9_-])`. 뒤 조건을 빼면 `@handlex` 의 앞부분이 잘려 `<@id>x` 가 되고,
-- 그것은 되돌릴 수 없다.
--
-- #230 그룹 멘션(`@그룹`)은 계정이 아니므로 이 순회에 들어오지 않고 글자 그대로 남는다.
-- `@channel`(#225)도 같다 — 그 이름의 계정이 실제로 있을 때만 바뀐다.
--
-- 코드 블록 안의 `@handle` 은 여기서 **구분하지 않는다.** SQL 로 코드 판정을 다시 구현하면
-- `shared` 의 `splitCode` 와 두 벌이 되고, 그 둘이 갈라지는 것이 코드 안 멘션을 잘못 다루는
-- 것보다 나쁘다. 결과는 이미 올라온 본문에 한해 코드 안의 `@handle` 도 토큰이 되는 것인데,
-- 화면에는 코드로 그려지므로(#298 의 `splitCode` 가 그 구간을 코드로 판정한다) 알림이 새로
-- 가지도 않는다 — 알림은 발화 시점에 이미 정해졌고 본문을 다시 읽지 않는다.
do $$
declare
  acc record;
  msg_total int := 0;
  doc_total int := 0;
  n int;
begin
  for acc in select id, handle from account loop
    -- 앞 경계는 캡처해서 되돌려 놓는다(`\1`). 소비하지 않으면 `a@handle` 의 `a` 가 사라진다.
    update message
    set body = regexp_replace(
      body,
      '(^|[^a-zA-Z0-9_-])@(' || acc.handle || ')(?![a-zA-Z0-9_-])',
      '\1<@' || acc.id || '>',
      'g'
    )
    where body ~ ('(^|[^a-zA-Z0-9_-])@(' || acc.handle || ')(?![a-zA-Z0-9_-])');
    get diagnostics n = row_count;
    msg_total := msg_total + n;

    -- 채널 문서(#188)도 본문을 그리는 자리다 — 같은 형식이어야 화면이 한 함수로 그린다.
    update channel_doc
    set body = regexp_replace(
      body,
      '(^|[^a-zA-Z0-9_-])@(' || acc.handle || ')(?![a-zA-Z0-9_-])',
      '\1<@' || acc.id || '>',
      'g'
    )
    where body ~ ('(^|[^a-zA-Z0-9_-])@(' || acc.handle || ')(?![a-zA-Z0-9_-])');
    get diagnostics n = row_count;
    doc_total := doc_total + n;
  end loop;

  -- 바꾼 행 수를 남긴다. 이 마이그레이션은 되돌릴 수 없으므로, 무엇을 얼마나 건드렸는지가
  -- 로그에만 남는다(한 행이 여러 handle 에 걸리면 그만큼 중복해서 센다).
  raise notice '034: mention tokens rewritten — message updates=%, channel_doc updates=%',
    msg_total, doc_total;
end $$;
