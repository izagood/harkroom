//! avcs 서버에 붙는 HTTP 클라이언트 — 투영 루프(`loops::projection`)와 협업 탭 읽기(`core::collab_read`)가 같이 쓴다.
//!
//! 주소의 scheme 으로 연결을 고른다(TS `avcs/client.ts` 의 `fetch` 와 같은 범위):
//! - `http://` — 평문 TCP. 로컬·클러스터 안 avcs 용으로 그대로 둔다.
//! - `https://` — TCP 위에 TLS(rustls·ring). 서버 이름은 주소의 host 로 검증한다. 포트가 없으면 443.
//! - 그 밖의 scheme — 연결하지 않고 오류.
//!
//! TLS 루트는 **바이너리에 묶인 Mozilla 루트(`webpki-roots`)** 다 — 이미지 안 CA 묶음(`/etc/ssl/certs`)은 읽지 않는다.
//! 링크 미리보기·APNs 와 같은 근원이다. 사설 CA 로 서명한 avcs 는 붙지 않는다(그때는 오류로 남고 백오프한다).
//! ALPN 은 걸지 않는다 — HTTP/1.1 이다(TS `fetch` 와 같다).
use http_body_util::Full;
use hyper::Uri;
use hyper::body::Bytes;
use hyper::rt::{Read, ReadBufCursor, Write};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection, HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

/// avcs 요청 클라이언트.
pub type AvcsClient = Client<AvcsConnector, Full<Bytes>>;

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// 운영용 — 묶인 Mozilla 루트로 검증한다.
pub fn client() -> AvcsClient {
    client_with(default_tls())
}

/// 루트를 바꿔 끼운 클라이언트(시험이 자체 CA 를 넣는다).
pub fn client_with(tls: Arc<rustls::ClientConfig>) -> AvcsClient {
    Client::builder(TokioExecutor::new()).build(AvcsConnector::new(tls))
}

fn default_tls() -> Arc<rustls::ClientConfig> {
    static T: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    T.get_or_init(|| {
        tls_with_roots(rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        })
    })
    .clone()
}

/// 주어진 루트로 검증하는 TLS 설정(ring, 안전 기본 판).
pub fn tls_with_roots(roots: rustls::RootCertStore) -> Arc<rustls::ClientConfig> {
    Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("tls versions")
        .with_root_certificates(roots)
        .with_no_client_auth(),
    )
}

/// scheme 을 보고 평문/TLS 를 고르는 커넥터.
#[derive(Clone)]
pub struct AvcsConnector {
    http: HttpConnector,
    tls: Arc<rustls::ClientConfig>,
}

impl AvcsConnector {
    fn new(tls: Arc<rustls::ClientConfig>) -> Self {
        let mut http = HttpConnector::new();
        // `https://` 도 TCP 는 이 커넥터가 연다(기본 포트 443 포함). TLS 는 아래에서 얹는다.
        http.enforce_http(false);
        Self { http, tls }
    }
}

impl tower_service::Service<Uri> for AvcsConnector {
    type Response = AvcsStream;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<AvcsStream, BoxError>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        self.http.poll_ready(cx).map_err(Into::into)
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let mut http = self.http.clone();
        let tls = self.tls.clone();
        Box::pin(async move {
            let https = match uri.scheme_str() {
                Some("http") => false,
                Some("https") => true,
                other => return Err(format!("avcs: unsupported scheme {other:?}").into()),
            };
            let host = uri
                .host()
                .ok_or("avcs: no host")?
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_owned();
            let tcp = http.call(uri).await?;
            if !https {
                return Ok(AvcsStream::Plain(tcp));
            }
            let name = rustls::pki_types::ServerName::try_from(host)?;
            let stream = tokio_rustls::TlsConnector::from(tls)
                .connect(name, tcp.into_inner())
                .await?;
            Ok(AvcsStream::Tls(Box::new(TokioIo::new(stream))))
        })
    }
}

/// 평문 또는 TLS 연결.
pub enum AvcsStream {
    Plain(TokioIo<TcpStream>),
    Tls(Box<TokioIo<TlsStream<TcpStream>>>),
}

impl Connection for AvcsStream {
    fn connected(&self) -> Connected {
        match self {
            Self::Plain(s) => s.connected(),
            Self::Tls(s) => s.inner().get_ref().0.connected(),
        }
    }
}

impl Read for AvcsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl Write for AvcsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_flush(cx),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }

    fn is_write_vectored(&self) -> bool {
        match self {
            Self::Plain(s) => s.is_write_vectored(),
            Self::Tls(s) => s.is_write_vectored(),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(s) => Pin::new(s).poll_write_vectored(cx, bufs),
            Self::Tls(s) => Pin::new(s.as_mut()).poll_write_vectored(cx, bufs),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const BODY: &str = r#"{"cursor":3,"oids":[]}"#;

    /// 요청 머리를 읽고 JSON 한 덩이로 답한다. 받은 요청 줄을 돌려준다.
    async fn answer<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut s: S) -> String {
        let mut buf = vec![];
        let mut chunk = [0u8; 1024];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = s.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let res = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{BODY}",
            BODY.len()
        );
        s.write_all(res.as_bytes()).await.unwrap();
        s.shutdown().await.ok();
        String::from_utf8_lossy(&buf)
            .lines()
            .next()
            .unwrap_or("")
            .to_owned()
    }

    async fn get(client: &AvcsClient, url: String) -> Result<String, String> {
        let req = hyper::Request::get(url)
            .body(Full::new(Bytes::new()))
            .unwrap();
        let res = client.request(req).await.map_err(|e| format!("{e:?}"))?;
        assert_eq!(res.status(), 200);
        let b = res.into_body().collect().await.unwrap().to_bytes();
        Ok(String::from_utf8(b.to_vec()).unwrap())
    }

    /// 시험용 CA 와 그 CA 가 서명한 `127.0.0.1`·`localhost` 서버 인증서. 키는 실행 때마다 새로 만든다(저장소에 키를 두지 않는다).
    fn test_pki() -> (
        rustls::RootCertStore,
        Vec<rustls::pki_types::CertificateDer<'static>>,
        rustls::pki_types::PrivateKeyDer<'static>,
    ) {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let mut leaf =
            rcgen::CertificateParams::new(vec!["localhost".to_owned(), "127.0.0.1".to_owned()])
                .unwrap();
        leaf.subject_alt_names
            .push(rcgen::SanType::IpAddress("127.0.0.1".parse().unwrap()));
        let leaf_cert = leaf.signed_by(&leaf_key, &ca_cert, &ca_key).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca_cert.der().clone()).unwrap();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into());
        (roots, vec![leaf_cert.der().clone()], key)
    }

    async fn tls_server(
        chain: Vec<rustls::pki_types::CertificateDer<'static>>,
        key: rustls::pki_types::PrivateKeyDer<'static>,
    ) -> (u16, tokio::task::JoinHandle<Option<String>>) {
        let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            let (tcp, _) = l.accept().await.unwrap();
            // 핸드셰이크가 실패하면(클라이언트가 인증서를 거절하면) None.
            let tls = acceptor.accept(tcp).await.ok()?;
            Some(answer(tls).await)
        });
        (port, h)
    }

    #[tokio::test]
    async fn https_url_speaks_tls_and_verifies_server() {
        let (roots, chain, key) = test_pki();
        let (port, server) = tls_server(chain, key).await;
        let client = client_with(tls_with_roots(roots));
        let body = get(
            &client,
            format!("https://127.0.0.1:{port}/o/r/sync?since=0"),
        )
        .await
        .unwrap();
        assert_eq!(body, BODY);
        assert_eq!(
            server.await.unwrap().as_deref(),
            Some("GET /o/r/sync?since=0 HTTP/1.1"),
            "서버가 TLS 위에서 요청을 받았다"
        );
    }

    #[tokio::test]
    async fn https_rejects_untrusted_certificate() {
        // 운영 루트(webpki-roots)에는 시험 CA 가 없다 — 검증을 끄지 않았음을 본다.
        let (_, chain, key) = test_pki();
        let (port, server) = tls_server(chain, key).await;
        let err = get(&client(), format!("https://127.0.0.1:{port}/"))
            .await
            .unwrap_err();
        assert!(err.to_lowercase().contains("certificate"), "{err}");
        assert_eq!(server.await.unwrap(), None);
    }

    #[tokio::test]
    async fn http_url_stays_plain() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (tcp, _) = l.accept().await.unwrap();
            answer(tcp).await
        });
        let body = get(
            &client(),
            format!("http://127.0.0.1:{port}/o/r/sync?since=0"),
        )
        .await
        .unwrap();
        assert_eq!(body, BODY);
        assert_eq!(server.await.unwrap(), "GET /o/r/sync?since=0 HTTP/1.1");
    }

    #[tokio::test]
    async fn other_scheme_is_refused() {
        let err = get(&client(), "ftp://127.0.0.1:1/".to_owned())
            .await
            .unwrap_err();
        assert!(err.contains("unsupported scheme"), "{err}");
    }
}
