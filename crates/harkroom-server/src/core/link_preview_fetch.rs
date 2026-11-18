//! S5.4 — 링크 미리보기 가져오기(TS `services/linkPreview.ts` 의 `queueLinkPreviewFetch`·`fetchLinkPreview`·`checkFetchable`·
//! `httpFetchHop`·`parseHtml`). SSRF 방어는 TS 와 같다: 이름 차단(`BLOCKED_HOST_SUFFIXES`) → 해석된 **모든** 주소 검사
//! (사설·루프백·링크로컬·CGNAT·문서용·멀티캐스트·IPv4 매핑/NAT64/6to4) → 검사한 주소로 **고정 접속**(DNS 재바인딩 없음) →
//! 리다이렉트마다 다시 검사(최대 3회, 제자리면 실패) → hop 당 총 5초 · 본문 512KB.
//! 쓰기 권한은 [`LINK_PREVIEW_WRITE_PRIVILEGES`](+ `event_outbox` 는 `write.rs` 기본 묶음).
use super::link_preview_read::normalize_preview_url;
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use serde_json::json;
use sqlx::PgPool;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const LINK_PREVIEW_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("link_preview.url", "SELECT"),
    ("link_preview.status", "SELECT"),
    ("link_preview.fetched_at", "SELECT"),
    ("link_preview.url", "INSERT"),
    ("link_preview.title", "INSERT"),
    ("link_preview.description", "INSERT"),
    ("link_preview.image_url", "INSERT"),
    ("link_preview.site_name", "INSERT"),
    ("link_preview.status", "INSERT"),
    ("link_preview.fetched_at", "INSERT"),
    ("link_preview.title", "UPDATE"),
    ("link_preview.description", "UPDATE"),
    ("link_preview.image_url", "UPDATE"),
    ("link_preview.site_name", "UPDATE"),
    ("link_preview.status", "UPDATE"),
    ("link_preview.fetched_at", "UPDATE"),
];

const MAX_BODY_BYTES: usize = 512 * 1024;
const TIMEOUT: Duration = Duration::from_millis(5_000);
const MAX_REDIRECTS: usize = 3;
const MAX_FIELD_LENGTH: usize = 200;
const USER_AGENT: &str = "harkroom-link-preview";
const BLOCKED_HOST_SUFFIXES: &[&str] = &[
    "localhost",
    "localdomain",
    "local",
    "internal",
    "metadata.google.internal",
    "kubernetes.default.svc",
];

fn blocked_host_name(host: &str) -> bool {
    BLOCKED_HOST_SUFFIXES
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51)
        || (a == 203 && b == 0)
        || a >= 224
}

fn blocked_v6(ip: Ipv6Addr) -> bool {
    let g = ip.segments();
    let embedded = || Ipv4Addr::new((g[6] >> 8) as u8, g[6] as u8, (g[7] >> 8) as u8, g[7] as u8);
    if g[..5].iter().all(|x| *x == 0) && (g[5] == 0xffff || g[5] == 0) {
        if g[6] == 0 && (g[7] == 0 || g[7] == 1) {
            return true;
        }
        return blocked_v4(embedded());
    }
    if g[0] == 0x64 && g[1] == 0xff9b && g[2..6].iter().all(|x| *x == 0) {
        return blocked_v4(embedded());
    }
    let f = g[0];
    (f & 0xfe00) == 0xfc00
        || (f & 0xffc0) == 0xfe80
        || (f & 0xff00) == 0xff00
        || (f == 0x2001 && g[1] == 0x0db8)
        || f == 0x2002
        || (f == 0x0100 && g[1] == 0 && g[2] == 0 && g[3] == 0)
}

/// TS `isBlockedAddress`.
pub(crate) fn blocked_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => blocked_v4(v),
        IpAddr::V6(v) => blocked_v6(v),
    }
}

enum Verdict {
    Ok { host: String, ip: IpAddr },
    No(&'static str),
}

/// TS `checkFetchable`.
async fn check_fetchable(raw: &str) -> Verdict {
    let Some(n) = normalize_preview_url(raw) else {
        return Verdict::No("blocked");
    };
    let Ok(u) = url::Url::parse(&n) else {
        return Verdict::No("blocked");
    };
    let host = u
        .host_str()
        .unwrap_or("")
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_lowercase();
    if host.is_empty() || blocked_host_name(&host) {
        return Verdict::No("blocked");
    }
    let addrs: Vec<IpAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![ip]
    } else {
        match tokio::net::lookup_host((host.as_str(), 0)).await {
            Ok(it) => {
                // TS: resolve4 다음 resolve6 순서.
                let all: Vec<IpAddr> = it.map(|s| s.ip()).collect();
                let mut v: Vec<IpAddr> = all.iter().copied().filter(IpAddr::is_ipv4).collect();
                v.extend(all.iter().copied().filter(IpAddr::is_ipv6));
                v.dedup();
                v
            }
            Err(_) => return Verdict::No("failed"),
        }
    };
    if addrs.is_empty() {
        return Verdict::No("failed");
    }
    if addrs.iter().any(|ip| blocked_address(*ip)) {
        return Verdict::No("blocked");
    }
    Verdict::Ok { host, ip: addrs[0] }
}

fn tls() -> Arc<rustls::ClientConfig> {
    static T: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    T.get_or_init(|| {
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        Arc::new(
            rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("tls versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
        )
    })
    .clone()
}

struct Hop {
    status: u16,
    location: Option<String>,
    body: String,
}

/// TS `httpFetchHop` — 검사한 `ip` 로만 접속한다(SNI·Host 는 이름). 총 시한이 지나면 status 0.
async fn fetch_hop(cur: &url::Url, host: &str, ip: IpAddr) -> Result<Hop, ()> {
    let https = cur.scheme() == "https";
    let port = cur.port().unwrap_or(if https { 443 } else { 80 });
    let mut path = cur.path().to_owned();
    if let Some(q) = cur.query() {
        path.push('?');
        path.push_str(q);
    }
    let authority = match cur.port() {
        Some(p) => format!("{}:{p}", cur.host_str().unwrap_or(host)),
        None => cur.host_str().unwrap_or(host).to_owned(),
    };
    let work = async {
        let tcp = tokio::net::TcpStream::connect((ip, port))
            .await
            .map_err(|_| ())?;
        let req = hyper::Request::get(path)
            .header(hyper::header::HOST, authority)
            .header(hyper::header::USER_AGENT, USER_AGENT)
            .header(hyper::header::ACCEPT, "text/html,application/xhtml+xml")
            .body(http_body_util::Empty::<bytes::Bytes>::new())
            .map_err(|_| ())?;
        let res = if https {
            let name = rustls::pki_types::ServerName::try_from(host.to_owned()).map_err(|_| ())?;
            let s = tokio_rustls::TlsConnector::from(tls())
                .connect(name, tcp)
                .await
                .map_err(|_| ())?;
            send(TokioIo::new(s), req).await?
        } else {
            send(TokioIo::new(tcp), req).await?
        };
        Ok::<_, ()>(res)
    };
    match tokio::time::timeout(TIMEOUT, work).await {
        Ok(r) => r,
        Err(_) => Ok(Hop {
            status: 0,
            location: None,
            body: String::new(),
        }),
    }
}

async fn send<I>(io: I, req: hyper::Request<http_body_util::Empty<bytes::Bytes>>) -> Result<Hop, ()>
where
    I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut tx, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|_| ())?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let res = tx.send_request(req).await.map_err(|_| ())?;
    let status = res.status().as_u16();
    let location = res
        .headers()
        .get(hyper::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    if (300..400).contains(&status) && location.is_some() {
        return Ok(Hop {
            status,
            location,
            body: String::new(),
        });
    }
    let mut body = res.into_body();
    let mut buf: Vec<u8> = vec![];
    while buf.len() < MAX_BODY_BYTES {
        match body.frame().await {
            Some(Ok(f)) => {
                if let Ok(d) = f.into_data() {
                    let room = MAX_BODY_BYTES - buf.len();
                    buf.extend_from_slice(&d[..d.len().min(room)]);
                }
            }
            Some(Err(_)) => return Err(()),
            None => break,
        }
    }
    Ok(Hop {
        status,
        location: None,
        body: String::from_utf8_lossy(&buf).into_owned(),
    })
}

#[derive(Debug, PartialEq)]
pub(crate) struct Preview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image_url: Option<String>,
    pub site_name: Option<String>,
    pub status: &'static str,
}

fn blocked_preview(url: &str, status: &'static str) -> Preview {
    Preview {
        url: url.to_owned(),
        title: None,
        description: None,
        image_url: None,
        site_name: None,
        status,
    }
}

/// TS `fetchLinkPreview`.
async fn fetch_link_preview(raw: &str) -> Option<Preview> {
    let normalized = normalize_preview_url(raw)?;
    let mut current = normalized.clone();
    for _ in 0..=MAX_REDIRECTS {
        let (host, ip) = match check_fetchable(&current).await {
            Verdict::Ok { host, ip } => (host, ip),
            Verdict::No(s) => return Some(blocked_preview(&normalized, s)),
        };
        let Ok(cur) = url::Url::parse(&current) else {
            return Some(blocked_preview(&normalized, "failed"));
        };
        let Ok(res) = fetch_hop(&cur, &host, ip).await else {
            return Some(blocked_preview(&normalized, "failed"));
        };
        if (300..400).contains(&res.status)
            && let Some(loc) = res.location.as_deref().filter(|l| !l.is_empty())
        {
            {
                let Ok(next) = cur.join(loc) else {
                    return Some(blocked_preview(&normalized, "failed"));
                };
                let next = next.to_string();
                if next == current {
                    return Some(blocked_preview(&normalized, "failed"));
                }
                current = next;
                continue;
            }
        }
        if !(200..300).contains(&res.status) || res.body.is_empty() {
            return Some(blocked_preview(&normalized, "failed"));
        }
        return Some(parse_html(&res.body, &normalized));
    }
    Some(blocked_preview(&normalized, "failed"))
}

fn meta_content(html: &str, attr: &str, key: &str) -> Option<String> {
    let k = regex::escape(key);
    let a = regex::Regex::new(&format!(
        r#"(?i)<meta[^>]+{attr}=["']{k}["'][^>]*content=["']([^"']*)["']"#
    ))
    .ok()?;
    if let Some(c) = a.captures(html).and_then(|c| c.get(1))
        && !c.as_str().is_empty()
    {
        return Some(c.as_str().to_owned());
    }
    let b = regex::Regex::new(&format!(
        r#"(?i)<meta[^>]+content=["']([^"']*)["'][^>]*{attr}=["']{k}["']"#
    ))
    .ok()?;
    b.captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

fn title_tag(html: &str) -> Option<String> {
    static R: OnceLock<regex::Regex> = OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"(?i)<title[^>]*>([^<]*)</title>").expect("title"))
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_owned())
}

fn safe_cp(n: Option<u32>) -> String {
    n.filter(|n| *n > 0)
        .and_then(char::from_u32)
        .map(String::from)
        .unwrap_or_default()
}

fn decode_entities(s: &str) -> String {
    static HEX: OnceLock<regex::Regex> = OnceLock::new();
    static DEC: OnceLock<regex::Regex> = OnceLock::new();
    let hex = HEX.get_or_init(|| regex::Regex::new(r"(?i)&#x([0-9a-f]+);").expect("hex"));
    let dec = DEC.get_or_init(|| regex::Regex::new(r"&#(\d+);").expect("dec"));
    let s = hex.replace_all(s, |c: &regex::Captures| {
        safe_cp(u32::from_str_radix(&c[1], 16).ok())
    });
    let s = dec.replace_all(&s, |c: &regex::Captures| safe_cp(c[1].parse::<u32>().ok()));
    let mut out = s.into_owned();
    for (from, to) in [
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&quot;", "\""),
        ("&apos;", "'"),
        ("&nbsp;", " "),
        ("&amp;", "&"),
    ] {
        let r = regex::Regex::new(&format!("(?i){from}")).expect("entity");
        out = r.replace_all(&out, regex::NoExpand(to)).into_owned();
    }
    out
}

fn clean(raw: Option<String>) -> Option<String> {
    static TAG: OnceLock<regex::Regex> = OnceLock::new();
    static WS: OnceLock<regex::Regex> = OnceLock::new();
    let raw = raw?;
    let t = TAG
        .get_or_init(|| regex::Regex::new(r"<[^>]*>").expect("tag"))
        .replace_all(&decode_entities(&raw), "")
        .into_owned();
    let t = WS
        .get_or_init(|| regex::Regex::new(r"\s+").expect("ws"))
        .replace_all(&t, " ")
        .trim()
        .to_owned();
    if t.is_empty() {
        return None;
    }
    // JS `slice(0, 200)` — UTF-16 단위.
    let mut n = 0;
    let mut out = String::new();
    for c in t.chars() {
        n += c.len_utf16();
        if n > MAX_FIELD_LENGTH {
            break;
        }
        out.push(c);
    }
    Some(out)
}

/// TS `parseHtml`.
pub(crate) fn parse_html(html: &str, url: &str) -> Preview {
    Preview {
        url: url.to_owned(),
        title: clean(meta_content(html, "property", "og:title").or_else(|| title_tag(html))),
        description: clean(
            meta_content(html, "property", "og:description")
                .or_else(|| meta_content(html, "name", "description")),
        ),
        image_url: clean(meta_content(html, "property", "og:image")),
        site_name: clean(meta_content(html, "property", "og:site_name")),
        status: "ok",
    }
}

fn in_flight() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashSet::new()))
}

const FRESH_SQL: &str = "select (case when status = 'ok' then clock_timestamp() - fetched_at <= interval '7 days' \
     else clock_timestamp() - fetched_at <= interval '1 hour' end) from link_preview where url = $1";

const SAVE_SQL: &str = "insert into link_preview (url, title, description, image_url, site_name, status, fetched_at) \
     values ($1, $2, $3, $4, $5, $6, clock_timestamp()) on conflict (url) do update set \
     title = excluded.title, description = excluded.description, image_url = excluded.image_url, \
     site_name = excluded.site_name, status = excluded.status, fetched_at = excluded.fetched_at";

/// TS `queueLinkPreviewFetch` — 같은 URL 은 한 번에 하나, 신선하면 건너뛴다. 저장하면 `link_preview.ready`.
pub(crate) async fn queue_fetch(pool: PgPool, url: String) {
    let Some(n) = normalize_preview_url(&url) else {
        return;
    };
    if !in_flight()
        .lock()
        .map(|mut s| s.insert(n.clone()))
        .unwrap_or(false)
    {
        return;
    }
    let run = async {
        let fresh: Option<bool> = sqlx::query_scalar(FRESH_SQL)
            .bind(&n)
            .fetch_optional(&pool)
            .await?;
        if fresh == Some(true) {
            return Ok(());
        }
        let Some(p) = fetch_link_preview(&n).await else {
            return Ok(());
        };
        sqlx::query(SAVE_SQL)
            .bind(&p.url)
            .bind(&p.title)
            .bind(&p.description)
            .bind(&p.image_url)
            .bind(&p.site_name)
            .bind(p.status)
            .execute(&pool)
            .await?;
        let mut conn = pool.acquire().await?;
        crate::write::emit_event(
            &mut conn,
            &json!({ "type": "link_preview.ready", "url": p.url, "audience": "all" }),
        )
        .await?;
        Ok::<_, sqlx::Error>(())
    };
    if let Err(e) = run.await {
        eprintln!(
            "front: link preview fetch failed: {}",
            e.as_database_error().map_or("io", |_| "db")
        );
    }
    if let Ok(mut s) = in_flight().lock() {
        s.remove(&n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssrf_like_ts() {
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "127.0.0.1",
            "100.64.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "fd00::1",
            "fe90::1",
            "ff02::1",
            "2001:db8::1",
            "2002::1",
            "100::1",
        ] {
            assert!(blocked_address(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "172.32.0.1"] {
            assert!(!blocked_address(ip.parse().unwrap()), "{ip}");
        }
        assert!(blocked_host_name("localhost"));
        assert!(blocked_host_name("a.internal"));
        assert!(!blocked_host_name("notlocalhost"));
    }

    #[test]
    fn parse_like_ts() {
        let h = r#"<html><head><title>T &amp; t</title><meta content="D" name="description">
            <meta property="og:image" content="https://x/i.png"></head>"#;
        let p = parse_html(h, "https://x/");
        assert_eq!(p.title.as_deref(), Some("T & t"));
        assert_eq!(p.description.as_deref(), Some("D"));
        assert_eq!(p.image_url.as_deref(), Some("https://x/i.png"));
        assert_eq!(p.site_name, None);
        assert_eq!(clean(Some("a".repeat(300))).map(|s| s.len()), Some(200));
    }
}
