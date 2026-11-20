//! s39 A — 요청 수·지연 히스토그램(TS `metrics.ts` 의 `observeRequest`·`render` 와 같은 이름·라벨·버킷).
//!
//! **카디널리티**: 라벨은 `method`·`route`·`status` 셋이다. `route` 는 원시 URL 이 아니라 **경로 틀**(axum `MatchedPath`,
//! `/channels/{id}` → TS 꼴 `/channels/:id`)이고, 틀에 맞지 않은 요청(앞단 fallback → TS 넘김)은 `unmatched` 하나로 묶는다.
//! `method` 는 아는 낱말 아홉 개 밖이면 `OTHER`. 그래서 계열 수는 「옮긴 경로 표 × 메서드 × 상태 코드」로 닫혀 있다.
//!
//! 지연은 응답 머리가 나갈 때까지다(본문 스트리밍 시간은 넣지 않는다). 응답 글자·status 는 건드리지 않는다.
use axum::extract::{MatchedPath, Request};
use axum::middleware::Next;
use axum::response::Response;
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::Mutex;
use std::time::Instant;

/// TS `BUCKETS`(초).
pub const BUCKETS: [f64; 11] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];
const BUCKET_LABELS: [&str; 11] = [
    "0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10",
];

#[derive(Default)]
struct Hist {
    counts: [u64; 11],
    sum: f64,
    total: u64,
}

type Key = (&'static str, String, u16);

static REG: Mutex<BTreeMap<Key, Hist>> = Mutex::new(BTreeMap::new());

fn method_word(m: &axum::http::Method) -> &'static str {
    match m.as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        "CONNECT" => "CONNECT",
        "TRACE" => "TRACE",
        _ => "OTHER",
    }
}

/// axum 틀(`/x/{id}`·`/x/{*rest}`) → TS 틀(`/x/:id`·`/x/*`).
pub fn ts_route(axum_path: &str) -> String {
    let mut out = String::with_capacity(axum_path.len());
    let mut rest = axum_path;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let Some(j) = rest[i..].find('}') else {
            out.push_str(&rest[i..]);
            return out;
        };
        let name = &rest[i + 1..i + j];
        if name.starts_with('*') {
            out.push('*');
        } else {
            out.push(':');
            out.push_str(name);
        }
        rest = &rest[i + j + 1..];
    }
    out.push_str(rest);
    out
}

/// 합친 라우터 바깥(`main.rs`)에 거는 층 — 모든 요청을 센다. `Router::layer` 는 경로마다 감싸므로 요청에 맞은 틀이 실려 있다.
pub async fn observe(req: Request, next: Next) -> Response {
    let method = method_word(req.method());
    let route = req
        .extensions()
        .get::<MatchedPath>()
        .map_or_else(|| "unmatched".to_string(), |m| ts_route(m.as_str()));
    let start = Instant::now();
    let res = next.run(req).await;
    record(
        method,
        route,
        res.status().as_u16(),
        start.elapsed().as_secs_f64(),
    );
    res
}

fn record(method: &'static str, route: String, status: u16, secs: f64) {
    let mut reg = REG.lock().unwrap_or_else(|e| e.into_inner());
    let h = reg.entry((method, route, status)).or_default();
    for (i, b) in BUCKETS.iter().enumerate() {
        if secs <= *b {
            h.counts[i] += 1;
        }
    }
    h.sum += secs;
    h.total += 1;
}

fn esc(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// TS `render()` 와 같은 꼴 — 머리 둘과 계열들. `/metrics` 맨 앞에 싣는다.
pub fn render(out: &mut String) {
    let reg = REG.lock().unwrap_or_else(|e| e.into_inner());
    let labels: Vec<(String, &Hist)> = reg
        .iter()
        .map(|((m, r, s), h)| {
            (
                format!("method=\"{m}\",route=\"{}\",status=\"{s}\"", esc(r)),
                h,
            )
        })
        .collect();
    out.push_str("# HELP harkroom_http_requests_total total http requests\n# TYPE harkroom_http_requests_total counter\n");
    for (l, h) in &labels {
        let _ = writeln!(out, "harkroom_http_requests_total{{{l}}} {}", h.total);
    }
    out.push_str("# HELP harkroom_http_request_duration_seconds request duration\n# TYPE harkroom_http_request_duration_seconds histogram\n");
    for (l, h) in &labels {
        for (i, le) in BUCKET_LABELS.iter().enumerate() {
            let _ = writeln!(
                out,
                "harkroom_http_request_duration_seconds_bucket{{{l},le=\"{le}\"}} {}",
                h.counts[i]
            );
        }
        let _ = writeln!(
            out,
            "harkroom_http_request_duration_seconds_bucket{{{l},le=\"+Inf\"}} {}",
            h.total
        );
        let _ = writeln!(
            out,
            "harkroom_http_request_duration_seconds_sum{{{l}}} {}",
            h.sum
        );
        let _ = writeln!(
            out,
            "harkroom_http_request_duration_seconds_count{{{l}}} {}",
            h.total
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_template_is_ts_shaped() {
        assert_eq!(
            ts_route("/channels/{id}/messages"),
            "/channels/:id/messages"
        );
        assert_eq!(ts_route("/a/{x}/{y}"), "/a/:x/:y");
        assert_eq!(ts_route("/files/{*rest}"), "/files/*");
        assert_eq!(ts_route("/healthz"), "/healthz");
    }

    #[test]
    fn unknown_method_is_one_label() {
        let m = axum::http::Method::from_bytes(b"PURGE").unwrap();
        assert_eq!(method_word(&m), "OTHER");
    }

    #[test]
    fn buckets_are_cumulative() {
        record("GET", "/t/:unit".into(), 200, 0.03);
        let mut out = String::new();
        render(&mut out);
        let l = r#"method="GET",route="/t/:unit",status="200""#;
        assert!(
            out.contains(&format!(
                "harkroom_http_request_duration_seconds_bucket{{{l},le=\"0.025\"}} 0\n"
            )),
            "{out}"
        );
        assert!(
            out.contains(&format!(
                "harkroom_http_request_duration_seconds_bucket{{{l},le=\"0.05\"}} 1\n"
            )),
            "{out}"
        );
        assert!(
            out.contains(&format!(
                "harkroom_http_request_duration_seconds_bucket{{{l},le=\"+Inf\"}} 1\n"
            )),
            "{out}"
        );
        assert!(
            out.contains(&format!("harkroom_http_requests_total{{{l}}} 1\n")),
            "{out}"
        );
    }
}
