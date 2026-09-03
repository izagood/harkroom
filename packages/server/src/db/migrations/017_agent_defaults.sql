-- 새 에이전트를 만들 때 쓰는 '기본값'(#171). 운영자가 harness·model·effort 를 매번 다시
-- 고르지 않도록, 다음에 만들 것의 서식을 한 곳에 둔다.
--
-- **해석된 복사본이지 참조가 아니다.** 생성 시점의 기본값을 그 에이전트의 agent_config 행에
-- 그대로 박고, 나중에 여기를 바꿔도 이미 만들어진 에이전트는 따라 바뀌지 않는다.
-- 참조로 두면 안 되는 이유: harness·model 은 러너가 매 턴 읽어서 실제로 프로세스를 띄우는
-- 값이다. 운영자가 기본값을 고치는 순간 **돌고 있는 에이전트의 하네스가 중간에 바뀐다.**
-- "같은 사실이 두 곳에 산다" 는 여기 해당하지 않는다 — 기본값은 에이전트에 대한 사실이
-- 아니라 다음에 만들 것의 서식이고, 서식과 그것으로 만든 것이 독립인 것은 중복이 아니다.
--
-- 행이 하나뿐인 테이블이다. `id boolean primary key check (id)` 가 그것을 강제하는 관용구다 —
-- 키가 될 수 있는 값이 true 하나뿐이라 PK 유일성이 두 번째 행을 막고, check 가 false 행을
-- 막는다. 행이 둘이 되면 "기본값이 무엇인가" 에 답이 둘이 되고, 어느 쪽을 읽느냐가
-- 정렬 순서 같은 우연에 달리게 된다.
create table agent_defaults (
  id boolean primary key default true check (id),
  -- 값 검증은 애플리케이션이 한다 — 004_agent_config.sql 의 harness 와 같은 이유로,
  -- harness 목록은 코드와 함께 늘어나므로 스키마 제약으로 굳히지 않는다.
  harness text not null default 'claude-code',
  -- null 이면 'harness 기본값 사용'. agent_config 의 model·effort 와 같은 뜻이다.
  model text,
  effort text
);

-- 읽는 쪽이 "행이 없다" 를 따로 다루지 않도록 처음부터 한 행을 둔다.
insert into agent_defaults (id) values (true);
