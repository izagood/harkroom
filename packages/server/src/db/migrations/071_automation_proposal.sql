-- 자동화 제안(071) — 에이전트는 자동화를 **만들 수 없고 제안만** 한다.
--
-- 사람만 만들게 한 이유(064·#222)는 "에이전트가 나중에·반복해서 터뜨릴 일을 스스로 고르면 사람이
-- 그 발화를 예측할 수 없다"였다. 제안은 그 원칙을 깨지 않는다: 글은 **승인한 사람의 이름**으로
-- 나가고, 승인 전에는 시계도 입구도 돌지 않는다. 스킬 제안(037)과 같은 모양이다.
--
-- `approved_at` 의 기본값이 now() 인 이유: 사람이 직접 만든 자동화는 만든 순간 승인된 것이다.
-- 기존 행도 그렇게 채워진다. 제안만 null 로 들어간다.
alter table automation add column proposed_by uuid null references account(id);
alter table automation add column approved_at timestamptz null default now();
update automation set approved_at = created_at where approved_at is null;
