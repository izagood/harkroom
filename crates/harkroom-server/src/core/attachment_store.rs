//! S5.4 결정 3 — 첨부 저장소의 **읽기·지우기**. TS `storage/local.ts`(`createLocalStorage` 의 `read`·`remove`, `pathFor`)와
//! `buildServer.ts`(`defaultAttachmentRoot`)를 옮긴다. 쓰기(`write`, 업로드)는 아직 TS 에 남는다.
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
