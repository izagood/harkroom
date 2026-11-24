-- 위임 글의 열린 목록(`message.meta.delegation.open`)을 의무 표에 다시 맞춘다.
--
-- 그 목록은 「아직 답하지 않은 담당」이다 — 화면의 대기 사슬과 스레드 머리의 `openAskLinks` 가 읽는다. 서버는 결과 글·기한·중단으로
-- 의무가 닫힐 때만 이 값을 줄였고, 넘긴 쪽이 닫음(`delegator_close`)·새 위임으로 대체(`superseded`)·나이(`max_age`)로 닫힌 의무는
-- 글에 그대로 남았다. 이 판부터 서버가 그 세 길에서도 줄인다. 여기서는 이미 어긋난 글을 한 번 맞춘다.
--
-- 기준은 서버(`turn_settle::SYNC_OPEN_SQL`)와 같다: 그 글에 묶인 의무 가운데 `outcome is null` 인 담당.
-- - 글의 목록에 **이미 닫힌 담당이 들어 있는 글만** 고친다(`<@` — 순서만 다른 글·이미 맞는 글은 건드리지 않는다).
-- - 의무 행이 없는 옛 위임 글(v0 이전)과 `open` 칸이 없거나 배열이 아닌 글은 그대로 둔다.
-- - 지운 글은 건드리지 않는다.
--
-- 다시 돌려도 같다(두 번째는 고칠 글이 없다). 이벤트는 내지 않는다 — 화면은 다음에 읽을 때 맞는 값을 받는다.
-- 쓰기 역할 GRANT: 새로 줄 것 없음(`message.meta` UPDATE 는 이미 있다).
update message m
   set meta = jsonb_set(m.meta, '{delegation,open}', s.open)
  from (select d.message_id,
               coalesce(jsonb_agg(i.delegate_account_id::text order by i.delegate_account_id)
                        filter (where i.outcome is null), '[]'::jsonb) as open
          from team_delegation d
          left join team_delegation_item i on i.delegation_id = d.id
         group by d.message_id) s
 where m.id = s.message_id
   and m.deleted_at is null
   and m.meta->>'kind' = 'delegation'
   and jsonb_typeof(m.meta->'delegation'->'open') = 'array'
   and not (m.meta->'delegation'->'open' <@ s.open);
