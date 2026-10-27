-- 연쇄 한도 재설계 ④(2026-10-27): 상한 기본값 8 → 100. 루프는 정체 홉(146, `HARKROOM_STALL_BLOCK`)이 잡고, 이 값은 그것으로
-- 못 잡는 루프를 받는 백스톱이다(147 카드로 풀린다).
-- 행은 078 이 워크스페이스마다 하나 심어 두었다(기본값 8). 8 그대로인 행은 손대지 않은 기본값으로 보고 100 으로 옮긴다 —
-- 일부러 8 을 고른 곳과 가를 길은 없지만, 8 은 옛 기본값이라 그렇게 읽는다. 다른 값(예: 50)은 admin 이 고른 것이라 그대로 둔다.
alter table mention_policy alter column chain_limit set default 100;
update mention_policy set chain_limit = 100 where chain_limit = 8;
