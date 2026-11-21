-- 사람이 붙이는 오퍼레이터 이름(설정 › Operators 의 이름 바꾸기, 스레드 e12e6780).
--
-- `name` 을 덮어쓰지 않고 열을 따로 두는 이유: `name` 은 등록할 때 그 머신이 댄 이름(`--name` 이나
-- `hostname()`)이다. 사람이 바꾼 이름을 거기 쓰면 원래 호스트명을 보여 줄 수도, 그리로 되돌릴 수도
-- 없다. 화면은 `label ?? name` 을 보인다. null 은 "바꾼 적 없음"이다 — 빈 문자열은 두지 않는다.
--
-- 같은 머신을 다시 등록하면(`replaces`) 새 행이 생기므로 claim 이 옛 행의 label 을 새 행으로 옮긴다.
alter table operator add column label text;
