-- 거울 카드(`meta.ask.mirrorOf`, 2026-09-29)를 원본 id 로 찾는 색인.
--
-- 원본이 정해질 때마다(답·닫힘) `syncAskMirrors` 가 그 원본의 열린 거울을 찾는다 — 거울이
-- 없는 물음에서도 한 번 묻는다. 색인이 없으면 그 한 번이 message 전체를 훑는다.
-- 부분 색인이라 거울이 아닌 메시지는 색인에 들어오지 않는다(거의 전부가 그렇다).
create index if not exists message_ask_mirror_idx
  on message ((meta->'ask'->>'mirrorOf'))
  where meta->'ask'->>'mirrorOf' is not null;
