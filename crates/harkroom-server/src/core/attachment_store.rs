//! S5.4 결정 3 — 첨부 저장소의 **읽기·지우기**. TS `storage/local.ts`(`createLocalStorage` 의 `read`·`remove`, `pathFor`)와
//! `buildServer.ts`(`defaultAttachmentRoot`)를 옮긴다. 쓰기(`write`, 업로드 — [`LocalStorage::begin_write`])도 여기 있다.
//!
//! - 쓰기: 키는 TS 와 같은 `{uuid 앞 두 글자}/{uuid}`(사용자 파일명은 키에 넣지 않는다). TS 는 최종 경로에 바로 쓰지만
//!   여기서는 같은 디렉터리의 `.{uuid}.part` 에 쓰고 끝나면 rename 한다(원자적 — 반쯤 쓴 파일이 키로 보이지 않는다).
//!   제한(`maxBytes`)은 흐르는 중에 끊고, 끊거나 버리면 임시 파일을 지운다.
//!
//! - 키 → 경로: `path.resolve(root, key)` 와 같은 **글자 위** 해석(`..`·`.` 접기, 절대 키는 루트를 버린다)을 한 뒤,
//!   결과가 루트 자신이거나 `루트 + 구분자` 로 시작하지 않으면 거절한다(TS `pathFor` — 「storage key escapes the root」).
//!   심볼릭 링크는 따라가지 않는다(TS 도 `resolve` 만 쓴다).
//! - 읽기: 파일이 없으면(ENOENT) [`StoreError::Missing`] — 라우트가 404 로 바꾼다(TS `AttachmentMissingError`). 다른 오류는 그대로.
//! - 지우기: 없는 것을 지우는 것도 성공이다(TS `rm(…, { force: true })`).
//! - 루트: `ATTACHMENT_ROOT` 가 있으면 그것(상대경로면 cwd 기준 절대경로로 푼다). **없으면 `None`** — TS 의 기본값은
//!   TS 소스 파일 위치(`packages/server/.attachments`)라 Rust 바이너리가 같은 곳을 알 길이 없다. 다른 곳을 짐작하면
//!   "행은 있는데 파일이 없다"(#257)가 되므로 fail-closed: 저장소가 없으면 이것을 쓰는 줄은 TS 에 남는다.
use std::fmt;
use std::io;
use std::path::{Component, Path, PathBuf};

/// 저장소 오류. TS 의 `AttachmentMissingError`·`pathFor` 의 Error 와 같은 갈래.
#[derive(Debug)]
pub enum StoreError {
    /// 키가 루트를 벗어난다.
    Escapes(String),
    /// 파일이 저장소에 없다(→ 404).
    Missing {
        key: String,
        path: PathBuf,
    },
    Io(io::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Escapes(key) => write!(f, "storage key escapes the root: {key}"),
            StoreError::Missing { key, path } => {
                write!(f, "attachment not found: {key} at {}", path.display())
            }
            StoreError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// 로컬 볼륨 저장소(읽기·지우기).
#[derive(Clone, Debug)]
pub struct LocalStorage {
    root: PathBuf,
}

/// Node `path.resolve(base, key)` — 글자 위에서만 접는다(파일 시스템을 보지 않는다).
fn resolve(base: &Path, key: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for c in base.components().chain(Path::new(key).components()) {
        match c {
            Component::Prefix(p) => out = PathBuf::from(p.as_os_str()),
            Component::RootDir => {
                // 절대 키는 그때까지의 경로를 버린다(Node resolve 와 같다).
                let prefix: Option<PathBuf> = out.components().next().and_then(|f| match f {
                    Component::Prefix(p) => Some(PathBuf::from(p.as_os_str())),
                    _ => None,
                });
                out = prefix.unwrap_or_default();
                out.push(Component::RootDir.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => out.push(n),
        }
    }
    out
}

/// TS `pathFor` — 키를 실제 경로로. 루트를 벗어나면 거절한다.
pub fn path_for(root: &Path, key: &str) -> Result<PathBuf, StoreError> {
    let base = resolve(root, "");
    let full = resolve(&base, key);
    // `Path::starts_with` 는 성분 단위라 `base + sep` 접두와 같다(`/a/bc` 는 `/a/b` 로 시작하지 않는다).
    if full != base && !full.starts_with(&base) {
        return Err(StoreError::Escapes(key.to_string()));
    }
    Ok(full)
}

impl LocalStorage {
    /// 루트는 절대경로여야 한다(상대면 cwd 기준으로 푼다).
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root: PathBuf = root.into();
        let root = if root.is_absolute() {
            resolve(&root, "")
        } else {
            resolve(&std::env::current_dir()?, &root.to_string_lossy())
        };
        Ok(Self { root })
    }

    /// TS `defaultAttachmentRoot` 의 `ATTACHMENT_ROOT` 갈래. 없으면 `None`(모듈 머리말 — fail-closed).
    pub fn from_env() -> io::Result<Option<Self>> {
        match std::env::var("ATTACHMENT_ROOT") {
            Ok(v) if !v.is_empty() => {
                let s = Self::new(&v)?;
                if s.root.as_os_str() != v.as_str() {
                    eprintln!(
                        "ATTACHMENT_ROOT \"{v}\" resolved to \"{}\"",
                        s.root.display()
                    );
                }
                Ok(Some(s))
            }
            _ => Ok(None),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// TS `read` — 있으면 열린 파일, 없으면 [`StoreError::Missing`].
    pub async fn read(&self, key: &str) -> Result<std::fs::File, StoreError> {
        let src = path_for(&self.root, key)?;
        let key = key.to_string();
        blocking(move || {
            // TS 는 stat 으로 있는지 먼저 본 뒤 연다 — 여기서는 연 결과의 ENOENT 를 같은 갈래로 본다.
            match std::fs::metadata(&src) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    return Err(StoreError::Missing { key, path: src });
                }
                Err(e) => return Err(StoreError::Io(e)),
                Ok(_) => {}
            }
            std::fs::File::open(&src).map_err(StoreError::Io)
        })
        .await
    }

    /// TS `remove` — `rm(path, { force: true })`: 없으면 성공.
    pub async fn remove(&self, key: &str) -> Result<(), StoreError> {
        let p = path_for(&self.root, key)?;
        blocking(move || match std::fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError::Io(e)),
        })
        .await
    }
}

/// 쓰는 중인 업로드. [`PendingWrite::append`] 로 조각을 넣고 [`PendingWrite::commit`] 으로 키를 얻는다.
/// 버리면(`abort` 또는 drop) 임시 파일을 지운다.
pub struct PendingWrite {
    key: String,
    tmp: PathBuf,
    dest: PathBuf,
    file: Option<std::fs::File>,
    bytes: u64,
    max_bytes: u64,
}

/// 쓰기 결과(TS `{ key, bytes }`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stored {
    pub key: String,
    pub bytes: u64,
}

/// 제한을 넘었다(TS `StorageLimitError`).
#[derive(Debug)]
pub enum WriteError {
    TooLarge,
    Store(StoreError),
}

impl From<StoreError> for WriteError {
    fn from(e: StoreError) -> Self {
        WriteError::Store(e)
    }
}

impl PendingWrite {
    pub fn key(&self) -> &str {
        &self.key
    }

    /// 조각 하나. 누적이 `max_bytes` 를 넘으면 [`WriteError::TooLarge`](임시 파일은 지운다).
    pub async fn append(&mut self, chunk: bytes::Bytes) -> Result<(), WriteError> {
        self.bytes += chunk.len() as u64;
        if self.bytes > self.max_bytes {
            self.abort().await;
            return Err(WriteError::TooLarge);
        }
        let Some(mut f) = self.file.take() else {
            return Err(StoreError::Io(io::Error::other("write already finished")).into());
        };
        let r = blocking(move || {
            use std::io::Write;
            f.write_all(&chunk).map_err(StoreError::Io)?;
            Ok(f)
        })
        .await;
        match r {
            Ok(f) => {
                self.file = Some(f);
                Ok(())
            }
            Err(e) => {
                self.abort().await;
                Err(e.into())
            }
        }
    }

    /// 디스크에 내리고 최종 키로 옮긴다.
    pub async fn commit(mut self) -> Result<Stored, StoreError> {
        let Some(f) = self.file.take() else {
            return Err(StoreError::Io(io::Error::other("write already finished")));
        };
        let (tmp, dest) = (self.tmp.clone(), self.dest.clone());
        let r = blocking(move || {
            f.sync_all().map_err(StoreError::Io)?;
            drop(f);
            std::fs::rename(&tmp, &dest).map_err(StoreError::Io)
        })
        .await;
        match r {
            Ok(()) => {
                // 옮겼으니 drop 이 지울 것이 없다.
                self.tmp = PathBuf::new();
                Ok(Stored {
                    key: std::mem::take(&mut self.key),
                    bytes: self.bytes,
                })
            }
            Err(e) => {
                self.abort().await;
                Err(e)
            }
        }
    }

    /// 버린다 — 임시 파일을 지운다(없어도 성공).
    pub async fn abort(&mut self) {
        self.file.take();
        let tmp = std::mem::take(&mut self.tmp);
        if tmp.as_os_str().is_empty() {
            return;
        }
        let _ = blocking(move || {
            let _ = std::fs::remove_file(&tmp);
            Ok(())
        })
        .await;
    }
}

impl Drop for PendingWrite {
    fn drop(&mut self) {
        // 요청이 도중에 끊겨 future 가 버려지면 여기로 온다 — 반쯤 쓴 임시 파일을 남기지 않는다.
        self.file.take();
        if !self.tmp.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

/// TS `randomUUID()` — 소문자 v4.
fn uuid_v4() -> Result<String, StoreError> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| StoreError::Io(io::Error::other(e.to_string())))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

impl LocalStorage {
    /// TS `write` 의 시작 — 새 키를 만들고 디렉터리를 준비하고 임시 파일을 연다.
    pub async fn begin_write(&self, max_bytes: u64) -> Result<PendingWrite, StoreError> {
        let id = uuid_v4()?;
        let key = format!("{}/{}", &id[..2], id);
        let dest = path_for(&self.root, &key)?;
        let dir = dest
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.root.clone());
        let tmp = dir.join(format!(".{id}.part"));
        let tmp2 = tmp.clone();
        let file = blocking(move || {
            std::fs::create_dir_all(&dir).map_err(StoreError::Io)?;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp2)
                .map_err(StoreError::Io)
        })
        .await?;
        Ok(PendingWrite {
            key,
            tmp,
            dest,
            file: Some(file),
            bytes: 0,
            max_bytes,
        })
    }
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
) -> Result<T, StoreError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| StoreError::Io(io::Error::other(e)))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_made_keys_stay_inside() {
        let root = Path::new("/srv/att");
        assert_eq!(
            path_for(root, "ab/abcd-1234").unwrap(),
            PathBuf::from("/srv/att/ab/abcd-1234")
        );
        assert_eq!(
            path_for(root, "./ab/../ab/x").unwrap(),
            PathBuf::from("/srv/att/ab/x")
        );
        // 루트 자신은 TS 도 받는다(`full === base`).
        assert_eq!(path_for(root, "").unwrap(), PathBuf::from("/srv/att"));
    }

    #[test]
    fn escaping_keys_are_refused() {
        let root = Path::new("/srv/att");
        for k in [
            "..",
            "../x",
            "ab/../../x",
            "/etc/passwd",
            "../att2/x",
            "../att-other",
        ] {
            assert!(
                matches!(path_for(root, k), Err(StoreError::Escapes(_))),
                "{k}"
            );
        }
    }

    #[test]
    fn prefix_sibling_is_not_inside() {
        // `/srv/att2` 는 글자로는 `/srv/att` 로 시작하지만 루트 밖이다.
        assert!(path_for(Path::new("/srv/att"), "../att2").is_err());
    }

    #[test]
    fn trailing_slash_root_is_normalized() {
        assert_eq!(
            path_for(Path::new("/srv/att/"), "a/b").unwrap(),
            PathBuf::from("/srv/att/a/b")
        );
    }

    #[tokio::test]
    async fn write_is_atomic_and_limited() {
        let dir = std::env::temp_dir().join(format!("hr-attw-{}", std::process::id()));
        let s = LocalStorage::new(&dir).unwrap();
        // 정상: 키 모양, 내용, 임시 파일 없음.
        let mut w = s.begin_write(10).await.unwrap();
        let key = w.key().to_string();
        assert!(!dir.join(&key).exists(), "not visible before commit");
        w.append(bytes::Bytes::from_static(b"hello "))
            .await
            .unwrap();
        w.append(bytes::Bytes::from_static(b"wor")).await.unwrap();
        let st = w.commit().await.unwrap();
        assert_eq!(st.bytes, 9);
        let (pre, id) = st.key.split_once('/').unwrap();
        assert_eq!(pre, &id[..2]);
        assert!(crate::lists::is_zod_uuid(id), "{id}");
        assert_eq!(std::fs::read(dir.join(&st.key)).unwrap(), b"hello wor");
        // 딱 제한까지는 받는다.
        let mut w = s.begin_write(3).await.unwrap();
        w.append(bytes::Bytes::from_static(b"abc")).await.unwrap();
        let ok = w.commit().await.unwrap();
        assert_eq!(ok.bytes, 3);
        // 넘으면 거절하고 흔적이 없다.
        let mut w = s.begin_write(3).await.unwrap();
        let k = w.key().to_string();
        w.append(bytes::Bytes::from_static(b"ab")).await.unwrap();
        assert!(matches!(
            w.append(bytes::Bytes::from_static(b"cd")).await,
            Err(WriteError::TooLarge)
        ));
        drop(w);
        // drop 도 임시 파일을 지운다.
        let w = s.begin_write(3).await.unwrap();
        drop(w);
        let parent = dir.join(&k).parent().unwrap().to_path_buf();
        assert!(!dir.join(&k).exists());
        for d in std::fs::read_dir(&dir).unwrap() {
            for f in std::fs::read_dir(d.unwrap().path()).unwrap() {
                let n = f.unwrap().file_name();
                assert!(
                    !n.to_string_lossy().ends_with(".part"),
                    "{n:?} in {parent:?}"
                );
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn read_missing_and_remove_idempotent() {
        let dir = std::env::temp_dir().join(format!("hr-att-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("ab")).unwrap();
        let s = LocalStorage::new(&dir).unwrap();
        assert!(matches!(
            s.read("ab/nope").await,
            Err(StoreError::Missing { .. })
        ));
        std::fs::write(dir.join("ab/k"), b"x").unwrap();
        assert!(s.read("ab/k").await.is_ok());
        s.remove("ab/k").await.unwrap();
        s.remove("ab/k").await.unwrap();
        assert!(!dir.join("ab/k").exists());
        assert!(s.remove("../escape").await.is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
