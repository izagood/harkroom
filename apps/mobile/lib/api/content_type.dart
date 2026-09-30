/// 파일 이름으로 MIME 형식을 짐작한다.
///
/// ## 왜 필요한가
///
/// 파일 고르기(`file_picker`)는 형식을 주지 않고, 형식 없이 올린 multipart 부분을 서버는
/// **`application/octet-stream` 으로 저장한다.** 그러면 폰에서 고른 사진이 모바일에서도
/// 데스크탑에서도 **미리보기 없이 파일 줄**로만 그려진다. 실서버에 붙여 처음 올려 보고서야
/// 드러났다 — 가짜 서버는 늘 `image/png` 를 돌려줬다.
///
/// 모르는 확장자는 `null` 이다(서버의 기본값에 맡긴다). **SVG 는 일부러 넣지 않는다** —
/// 스크립트를 품을 수 있어 미리보기 대상이 아니므로, 이미지로 짐작할 이유가 없다.
String? contentTypeFor(String filename) {
  final dot = filename.lastIndexOf('.');
  if (dot < 0 || dot == filename.length - 1) return null;
  return _byExt[filename.substring(dot + 1).toLowerCase()];
}

const _byExt = <String, String>{
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'heic': 'image/heic',
  'heif': 'image/heif',
  'pdf': 'application/pdf',
  'txt': 'text/plain',
  'md': 'text/markdown',
  'json': 'application/json',
  'csv': 'text/csv',
  'zip': 'application/zip',
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
};
