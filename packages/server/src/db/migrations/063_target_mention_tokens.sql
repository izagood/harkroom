-- 집합·팀 멘션도 정본 토큰으로 바꾼다(#845) — 034 가 계정에 한 일을 나머지 둘에 한다.
--
-- ## 왜 지금인가
--
-- 034 는 `@handle` 을 `<@id>` 로 바꾸며 *"이름을 바꿔도 본문을 다시 쓰지 않는다"* 를 세웠다.
-- 그런데 바꾼 것은 **계정뿐**이었고, 같은 이름공간을 나눠 쓰는 집합과 팀은 글자 그대로
-- 남았다. 집합은 이름을 바꾸는 길이 아예 없어 안 터졌을 뿐이고, **팀은 `PATCH /teams/:id`
-- 로 이름이 바뀐다** — 바뀌는 순간 과거 본문의 `@옛팀이름` 은 아무것도 가리키지 않는
-- 글자가 된다. 알림은 이미 갔으니(inbox 행은 id 다) 조용히 화면과 프롬프트에서만 깨진다.
--
-- ## 접두를 다는 이유
--
-- 계정은 `<@id>`, 집합·팀은 `<@group:id>`·`<@team:id>` 다. 계정에 접두를 안 붙이는 것은
-- 이미 저장된 본문 전부를 다시 써야 하기 때문이고(034 가 세운 것을 무르는 일이다), 새
-- 종류만 구분되면 판정 경로(`mentionedIds`·`splitMentionCalls`)가 계정 id 만 내놓는다는
-- 약속이 그대로 산다.
--
-- ## 순서: 계정 > 집합 > 팀
--
-- 034 가 이미 돌았으므로 계정 이름은 여기 남아 있지 않다(같은 이름의 계정이 나중에
-- 생겼다면 아래 정규식이 그것을 집합으로 바꿀 수 있는데, 그 겹침 자체를 서버가 막는다).
-- 집합이 팀을 이기는 근거는 `services/messages.ts` 의 팬아웃 주석에 있다 — 집합을 먼저
-- 돌리면 겹친 이름은 이미 토큰이 되어 팀 회차의 `@이름` 정규식에 걸리지 않는다.
--
-- 코드 블록·인용 줄 안의 `@이름` 까지 바꾼다는 점은 034 와 같은 한계다. 034 가 그것을
-- 받아들였고(#298 은 그 뒤의 결정이다) 여기서 규칙을 달리하면 과거 본문이 두 규칙으로
-- 갈린다 — 한 벌로 틀린 편이 두 벌로 맞는 것보다 낫다.
do $$
declare
  t record;
  msg_total int := 0;
  doc_total int := 0;
  n int;
begin
  -- 집합 먼저(위 순서). 앞 경계는 캡처해서 되돌려 놓는다(`\1`) — 소비하면 `a@name` 의 `a` 가 사라진다.
  for t in
    select id, handle as name, 'group' as kind from handle_group
    union all
    select id, name, 'team' as kind from agent_team
    order by kind
  loop
    update message
    set body = regexp_replace(
      body,
      '(^|[^a-zA-Z0-9_-])@(' || t.name || ')(?![a-zA-Z0-9_-])',
      '\1<@' || t.kind || ':' || t.id || '>',
      'g'
    )
    where body ~ ('(^|[^a-zA-Z0-9_-])@(' || t.name || ')(?![a-zA-Z0-9_-])');
    get diagnostics n = row_count;
    msg_total := msg_total + n;

    update channel_doc
    set body = regexp_replace(
      body,
      '(^|[^a-zA-Z0-9_-])@(' || t.name || ')(?![a-zA-Z0-9_-])',
      '\1<@' || t.kind || ':' || t.id || '>',
      'g'
    )
    where body ~ ('(^|[^a-zA-Z0-9_-])@(' || t.name || ')(?![a-zA-Z0-9_-])');
    get diagnostics n = row_count;
    doc_total := doc_total + n;
  end loop;

  raise notice '063: 집합·팀 멘션 토큰화 — message % 행, channel_doc % 행', msg_total, doc_total;
end $$;
