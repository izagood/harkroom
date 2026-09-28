-- 자동화 수신(ingress) — 외부 이벤트(GitHub webhook · 범용 hook)가 자동화를 부르는 입구.
--
-- **기본으로 꺼져 있다.** 켜면 키를 발급하고(원문은 그때 한 번만 보인다), 끄면 키를 지운다.
-- 꺼진 자동화의 `/hooks/*/:id` 는 404 다 — 존재조차 드러내지 않는다.
--
-- 키를 두 모양으로 두는 이유:
-- - `ingress_token_hash`: 범용 hook 의 `Authorization: Bearer <키>` 를 PAT 처럼 해시로 대조한다.
--   원문을 몰라도 된다.
-- - `ingress_secret_enc`: GitHub 은 서명(HMAC-SHA256)을 보낸다. 서명을 검증하려면 서버가 **원문**
--   을 알아야 하므로 해시로는 안 된다 — `HARKROOM_SECRET_KEY` 로 AES-256-GCM 암호화해 둔다.
--   그 env 가 없으면 이 열은 null 이고 GitHub 수신은 켤 수 없다.
alter table automation add column ingress_enabled_at timestamptz null;
alter table automation add column ingress_token_hash text null;
alter table automation add column ingress_secret_enc text null;
