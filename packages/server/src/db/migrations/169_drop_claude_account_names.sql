-- 계정 칩 ②(2026-11-12): 서버에 남아 있던 claude 계정·풀 **이름**을 지운다.
--
-- 계정·풀 이름은 사람이 지은 폴더 이름이라 사람 이름일 수 있다(security #1039). 칩 ①(#1977)이 턴 줄에서 이름을
-- 순번으로 바꿨고, 이 마이그레이션이 남은 두 자리를 지운다. 러너는 칩 ②부터 두 자리에 이름을 보내지 않고, 서버는
-- 옛 러너가 보내도 받기만 하고 버린다(`message.fail` 의 `account`, `inbox.poll` 의 `claudeLane`).
--
-- ① 계정 관문 실패 카드의 이름표 `meta.failure.account`. 새 카드는 풀·계정 순번(`claudePoolRank`·
--    `claudeAccountRank`)만 싣는다. 지난 카드에서는 이름표만 빼고 나머지(차례 주인·코드)는 그대로 둔다 —
--    🙋 상태와 차례 주인 계산은 `code`·`awaitingAccountId` 만 읽으므로 바뀌지 않는다.
update message
   set meta = meta #- '{failure,account}'
 where meta->>'kind' = 'failure'
   and meta->'failure' ? 'account';

-- ② 러너가 기동 때 신고하던 계정 순서(044). 프로필의 「기동 때 읽은 claude 계정」 줄이 쓰던 표다.
--    이 기기의 풀 순서는 데스크톱 설정(에이전트 › 풀 순서)이 오퍼레이터에게서 직접 읽는다.
--    **표는 지우지 않고 비운다** — 판올림 중 아직 도는 옛 서버 파드가 `agents.ts` 에서 이 표를 left join 한다.
--    지우면 그 사이 에이전트 목록이 500 이 된다. 비우면 옛 서버는 「모른다」(null)로 그린다. 표 자체는 다음
--    마이그레이션에서 지운다(이 판이 운영에 나간 뒤).
truncate table agent_claude_lane;
