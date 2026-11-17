//! S5.4 MS2c-2 — 「내 작업」 보드 `GET /inbox/board`(TS `routes/messageRoutes.ts`·`compressBody.ts`).
//!
//! - 문장은 TS 정본 그대로 — `golden/sql_fragments.json` 의 `inbox_board_version`(판)·`inbox_board_root_ids`(inbox 밖 머리)·
//!   `list_inbox_all`/`list_inbox_compact`(줄). 머리·처리 상태는 [`super::inbox_threads`] 를 같이 쓴다.
//! - 바인드 형: 판 `$1`=내 id(`&str` → `$1::uuid`), `$2`=30(`i32` → `$2::int`). 밖 머리 `$1`=내 id(`$1::uuid`), `$2`=30, `$3`=300
//!   (`$n::int`). 맨 `$n` 이 uuid 칸과 견주는 곳은 없다(#2316 교훈).
//! - **ETag 는 본문을 만들기 전에** 판에서 낸다: `sha256(계정 id \0 기동 판 \0 compact \0 판)` 의 base64url 앞 32자. 기동 판은 이
//!   프로세스가 뜰 때 한 번 뽑는 난수다(TS `BOARD_ETAG_BOOT` 와 같은 뜻 — 두 서버의 태그는 서로 맞지 않고, 맞지 않으면 200 일 뿐이다).
//!   `If-None-Match` 의 쉼표 목록에 같은 태그가 있으면 본문 조회 없이 304.
//! - 몸통이 1024 바이트 이상이고 `Accept-Encoding` 이 받으면 br(품질 4) → gzip(6) 순으로 압축한다(TS `pickEncoding` 과 같은 판정).
//! - **넘기는 것**(TS 로): 질의가 `compact=1` 하나(또는 없음)가 아니면(zod 400·모르는 꼴), 위임 v2 스위치 값이 없으면(`inbox_rest` 와 같다).
use crate::auth::RequireAccount;
use crate::core::inbox_list::{InboxQuery, InboxRow, list_inbox};
use crate::core::inbox_threads::{thread_heads, thread_states};
use crate::core::mcp::respond::minify;
use crate::directory::internal;
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

/// TS `BOARD_WINDOW_DAYS`·`BOARD_EXTRA_LIMIT`·`BOARD_COMPACT_BODY_CHARS`·`COMPRESS_MIN_BYTES`.
const WINDOW_DAYS: i32 = 30;
const EXTRA_LIMIT: i32 = 300;
const COMPACT_BODY_CHARS: usize = 500;
const COMPRESS_MIN_BYTES: usize = 1024;

pub struct InboxBoardState {
    /// 읽기 풀 — SELECT 만 한다.
    pub pool: PgPool,
    /// Rust 가 맡지 않는 요청을 넘길 TS.
    pub up: Upstream,
}

struct Sql {
    version: String,
    root_ids: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            version: frag("inbox_board_version"),
            // 안쪽이 `order by … limit $3 + 1` 로 자른다 — 겉은 단순 투영(순서는 머리 문장의 `m.seq` 가 정한다).
            root_ids: format!(
                "select r.id::text from ({}) r",
                frag("inbox_board_root_ids")
            ),
        }
    })
}

/// 서버 기동마다 한 번 뽑는 판(TS `BOARD_ETAG_BOOT = randomUUID()`).
fn boot() -> &'static str {
    static B: OnceLock<String> = OnceLock::new();
    B.get_or_init(|| {
        let mut b = [0u8; 16];
        getrandom::fill(&mut b).expect("os random");
        b.iter().map(|x| format!("{x:02x}")).collect()
    })
}

/// 질의: `None`(키 없음) 또는 `compact=1` 만 맡는다. 그 밖(값이 다르거나 되풀이)은 TS 로 — zod `enum(['1'])` 400 은 TS 가 낸다.
fn parse(raw: Option<&str>) -> Option<bool> {
    let mut compact = None;
    for (k, v) in url::form_urlencoded::parse(raw.unwrap_or("").as_bytes()) {
        if k == "compact" {
            if compact.is_some() || v != "1" {
                return None;
            }
            compact = Some(true);
        }
    }
    Some(compact.unwrap_or(false))
}

/// TS 라우트의 태그 — 따옴표까지 포함한 글자.
fn etag(account: &str, boot: &str, compact: bool, version: &str) -> String {
    let mut h = Sha256::new();
    for (i, part) in [account, boot, if compact { "1" } else { "" }, version]
        .iter()
        .enumerate()
    {
        if i > 0 {
            h.update(b"\0");
        }
        h.update(part.as_bytes());
    }
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize());
    format!("\"{}\"", &b64[..32])
}

/// `If-None-Match` 쉼표 목록에 그 태그가 있는가(TS: 머리가 문자열 하나일 때 `split(',')`·`trim`).
fn not_modified(headers: &HeaderMap, tag: &str) -> bool {
    let mut it = headers.get_all(header::IF_NONE_MATCH).iter();
    let (Some(v), None) = (it.next(), it.next()) else {
        return false;
    };
    v.to_str()
        .map(|s| s.split(',').any(|t| t.trim() == tag))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Coding {
    Br,
    Gzip,
}

/// TS `pickEncoding` — `q=0` 은 거절, `*` 는 이름이 없을 때의 값. br 먼저.
fn pick_encoding(headers: &HeaderMap) -> Option<Coding> {
    let raw: Vec<&str> = headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect();
    let raw = raw.join(",");
    let mut accepted: Vec<(String, f64)> = Vec::new();
    for part in raw.split(',') {
        let lower = part.trim().to_ascii_lowercase();
        let mut it = lower.split(';');
        let name = it.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let mut q = 1.0;
        for p in it {
            let mut kv = p.trim().splitn(2, '=');
            if let (Some("q"), Some(v)) = (kv.next(), kv.next()) {
                q = js_number(v).filter(|n| n.is_finite()).unwrap_or(0.0);
            }
        }
        // TS `Map.set` — 같은 이름은 뒤의 것이 이긴다.
        accepted.retain(|(n, _)| *n != name);
        accepted.push((name, q));
    }
    let get = |n: &str| accepted.iter().find(|(k, _)| k == n).map(|(_, q)| *q);
    let ok = |n: &str| get(n).or_else(|| get("*")).is_some_and(|q| q > 0.0);
    if ok("br") {
        Some(Coding::Br)
    } else if ok("gzip") {
        Some(Coding::Gzip)
    } else {
        None
    }
}

/// JS `Number(v)` 의 쓸 만한 부분 — 빈 글자는 0, 그 밖은 십진 소수. 못 읽으면 `None`(→ NaN → 0).
fn js_number(v: &str) -> Option<f64> {
    let t = v.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|_| {
        // Rust 는 "inf"·"nan" 도 읽는다 — JS 는 NaN(→ 0)이다. 결과가 유한인지는 부르는 쪽이 본다.
        t.bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'+' | b'-' | b'e' | b'E'))
    })
}

fn compress(coding: Coding, raw: &[u8]) -> std::io::Result<Vec<u8>> {
    match coding {
        Coding::Br => {
            let mut out = Vec::with_capacity(raw.len() / 4);
            {
                // node zlib 기본 창(lgwin 22), 품질 4(TS `BROTLI_PARAM_QUALITY: 4`).
                let mut w = brotli::CompressorWriter::new(&mut out, 4096, 4, 22);
                w.write_all(raw)?;
                w.flush()?;
            }
            Ok(out)
        }
        Coding::Gzip => {
            let mut w = flate2::write::GzEncoder::new(
                Vec::with_capacity(raw.len() / 4),
                flate2::Compression::new(6),
            );
            w.write_all(raw)?;
            w.finish()
        }
    }
}

/// 간추림 머리 본문 자르기 — TS `Array.from(body).slice(0, 500)`(코드 포인트). 머리 JSON 은 [`minify`] 를 거친 글자다.
/// 첫 `"body":` 는 언제나 머리 행의 칸이다 — 그 앞 칸들(id 들)의 문자열 안에서는 따옴표가 `\"` 로 이스케이프되어
/// `,"body":` 꼴이 나올 수 없다. 본문 문자열만 읽어 자르고 serde_json 의 문자열 이스케이프(=`JSON.stringify` 와 같은 꼴)로 다시 쓴다.
fn clip_head_body(head: &str) -> String {
    let Some(at) = head.find(",\"body\":\"") else {
        return head.to_string();
    };
    let start = at + ",\"body\":".len();
    let bytes = head.as_bytes();
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => break,
            _ => i += 1,
        }
    }
    let end = i + 1;
    let Some(token) = head.get(start..end) else {
        return head.to_string();
    };
    let Ok(body) = serde_json::from_str::<String>(token) else {
        return head.to_string();
    };
    if body.chars().count() <= COMPACT_BODY_CHARS {
        return head.to_string();
    }
    let cut: String = body.chars().take(COMPACT_BODY_CHARS).collect();
    let quoted = serde_json::to_string(&cut).unwrap_or_else(|_| token.to_string());
    format!("{}{}{}", &head[..start], quoted, &head[end..])
}

/// 처음 나온 차례로 겹침을 지운다.
fn uniq(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

async fn body_json(pool: &PgPool, me: &str, compact: bool, v2: bool) -> sqlx::Result<String> {
    let rows: Vec<InboxRow> = list_inbox(pool, me, InboxQuery::All { compact }, v2).await?;
    let extra: Vec<String> = sqlx::query_scalar(sql().root_ids.as_str())
        .bind(me)
        .bind(WINDOW_DAYS)
        .bind(EXTRA_LIMIT)
        .fetch_all(pool)
        .await?;
    let truncated = extra.len() > EXTRA_LIMIT as usize;
    let roots = uniq(
        rows.iter()
            .map(|r| r.root.clone())
            .chain(extra.into_iter().take(EXTRA_LIMIT as usize)),
    );
    let heads = thread_heads(pool, me, roots).await?;
    let ids: Vec<String> = heads.iter().map(|(_, id)| id.clone()).collect();
    let states = thread_states(pool, me, &ids).await?;
    let heads: Vec<String> = heads
        .into_iter()
        .map(|(b, _)| if compact { clip_head_body(&b) } else { b })
        .collect();
    let entries: Vec<String> = rows.iter().map(|r| minify(&r.body)).collect();
    Ok(format!(
        "{{\"entries\":[{}],\"threads\":[{}],\"threadStates\":[{}],\"truncated\":{truncated}}}",
        entries.join(","),
        heads.join(","),
        states.join(",")
    ))
}

async fn board(
    State(st): State<Arc<InboxBoardState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    RequireAccount(me, _): RequireAccount,
    req: Request,
) -> Response {
    let v2 = crate::core::msg_post::delegation_v2(
        std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref(),
    );
    let Some((compact, v2)) = parse(req.uri().query()).zip(v2) else {
        return crate::proxy::forward(State(st.up.clone()), ConnectInfo(peer), req).await;
    };
    let version: String = match sqlx::query_scalar(sql().version.as_str())
        .bind(&me.id)
        .bind(WINDOW_DAYS)
        .fetch_one(&st.pool)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let tag = etag(&me.id, boot(), compact, &version);
    let tag_h = HeaderValue::from_str(&tag).expect("base64url etag");
    let cache = HeaderValue::from_static("private, no-cache");
    if not_modified(req.headers(), &tag) {
        return (
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, tag_h), (header::CACHE_CONTROL, cache)],
        )
            .into_response();
    }
    let json = match body_json(&st.pool, &me.id, compact, v2).await {
        Ok(j) => j,
        Err(e) => return internal(e),
    };
    let raw = json.into_bytes();
    let coding = if raw.len() >= COMPRESS_MIN_BYTES {
        pick_encoding(req.headers())
    } else {
        None
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::ETAG, tag_h);
    headers.insert(header::CACHE_CONTROL, cache);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    let Some(coding) = coding else {
        return (StatusCode::OK, headers, raw).into_response();
    };
    // 압축은 CPU 일 — 런타임 일꾼을 막지 않게 blocking 풀에서 돈다(TS 는 libuv 풀).
    let packed = match tokio::task::spawn_blocking(move || compress(coding, &raw)).await {
        Ok(Ok(p)) => p,
        // 오류 원문은 싣지 않는다 — `internal` 이 같은 500 꼴로 낸다.
        Ok(Err(e)) => return internal(sqlx::Error::Io(e)),
        Err(e) => return internal(sqlx::Error::Io(std::io::Error::other(e))),
    };
    headers.insert(
        header::CONTENT_ENCODING,
        HeaderValue::from_static(match coding {
            Coding::Br => "br",
            Coding::Gzip => "gzip",
        }),
    );
    (StatusCode::OK, headers, packed).into_response()
}

/// 코어 라우터에 합칠 줄 — `inbox_rest.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: InboxBoardState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<InboxBoardState>>::new()
        .get("/inbox/board", board)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_sql_loads_with_typed_binds() {
        let s = sql();
        assert!(s.version.contains("i.account_id = $1::uuid"));
        assert!(s.version.contains("make_interval(days => $2::int)"));
        assert!(s.root_ids.contains("said.author_id = $1::uuid"));
        assert!(s.root_ids.contains("limit $3::int + 1"));
    }

    #[test]
    fn query_shapes() {
        assert_eq!(parse(None), Some(false));
        assert_eq!(parse(Some("x=1")), Some(false));
        assert_eq!(parse(Some("compact=1")), Some(true));
        assert_eq!(parse(Some("compact=0")), None);
        assert_eq!(parse(Some("compact=")), None);
        assert_eq!(parse(Some("compact=1&compact=1")), None);
    }

    #[test]
    fn etag_matches_ts_shape() {
        // node: createHash('sha256').update('a').update('\0').update('b').update('\0').update('1').update('\0').update('v')
        //   .digest('base64url').slice(0, 32)
        let t = etag("a", "b", true, "v");
        assert_eq!(t.len(), 34);
        assert!(t.starts_with('"') && t.ends_with('"'));
        let mut h = Sha256::new();
        h.update(b"a\0b\x001\0v");
        let want = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize());
        assert_eq!(t, format!("\"{}\"", &want[..32]));
        assert_ne!(etag("a", "b", false, "v"), t);
        assert_ne!(etag("c", "b", true, "v"), t);
    }

    #[test]
    fn if_none_match_list() {
        let mut h = HeaderMap::new();
        h.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_static("\"x\", \"t\""),
        );
        assert!(not_modified(&h, "\"t\""));
        assert!(!not_modified(&h, "\"y\""));
        assert!(!not_modified(&HeaderMap::new(), "\"t\""));
    }

    #[test]
    fn encoding_pick_matches_ts() {
        let pick = |v: &str| {
            let mut h = HeaderMap::new();
            h.insert(header::ACCEPT_ENCODING, HeaderValue::from_str(v).unwrap());
            pick_encoding(&h)
        };
        assert_eq!(pick("gzip, deflate, br"), Some(Coding::Br));
        assert_eq!(pick("gzip"), Some(Coding::Gzip));
        assert_eq!(pick("br;q=0, gzip"), Some(Coding::Gzip));
        assert_eq!(pick("*"), Some(Coding::Br));
        assert_eq!(pick("*;q=0"), None);
        assert_eq!(pick("identity"), None);
        assert_eq!(pick("br;q=abc"), None);
        assert_eq!(pick_encoding(&HeaderMap::new()), None);
    }

    #[test]
    fn compress_round_trips() {
        use std::io::Read;
        let raw = "{\"entries\":[]}".repeat(200).into_bytes();
        let g = compress(Coding::Gzip, &raw).unwrap();
        let mut back = Vec::new();
        flate2::read::GzDecoder::new(&g[..])
            .read_to_end(&mut back)
            .unwrap();
        assert_eq!(back, raw);
        let b = compress(Coding::Br, &raw).unwrap();
        let mut back = Vec::new();
        brotli::Decompressor::new(&b[..], 4096)
            .read_to_end(&mut back)
            .unwrap();
        assert_eq!(back, raw);
        assert!(b.len() < raw.len() && g.len() < raw.len());
    }

    #[test]
    fn clip_counts_code_points() {
        let long: String = "가".repeat(499) + "😀😀" + "\n끝";
        let head = format!(
            "{{\"id\":\"x\",\"channelId\":\"c\",\"body\":{},\"meta\":{{\"body\":\"keep\"}}}}",
            serde_json::to_string(&long).unwrap()
        );
        let cut = clip_head_body(&head);
        let want: String = "가".repeat(499) + "😀";
        assert_eq!(
            cut,
            format!(
                "{{\"id\":\"x\",\"channelId\":\"c\",\"body\":{},\"meta\":{{\"body\":\"keep\"}}}}",
                serde_json::to_string(&want).unwrap()
            )
        );
        let short = "{\"id\":\"x\",\"body\":\"a\\\"b\",\"meta\":{}}";
        assert_eq!(clip_head_body(short), short);
    }
}
