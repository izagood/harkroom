/// 서버 주소를 **저장하기 전에** 판정한다. 계획서 §4(ATS)의 결정이 서는 자리다.
///
/// ## 왜 화면이 검사하나 — iOS 는 사유를 돌려주지 않는다
///
/// 앱에는 ATS 예외가 없다(`Info.plist` 에 `NSAllowsArbitraryLoads` 도
/// `NSAllowsLocalNetworking` 도 넣지 않는다). 그래서 평문 `http://` 서버에 붙으려 하면
/// iOS 가 막고, 앱이 받는 것은 **사유 없는 "연결 실패"** 하나다. 그 상태로는 사람이
/// 오타인지, 서버가 죽은 건지, iOS 가 막은 건지 구별할 방법이 없다.
///
/// 그래서 **ATS 를 믿고 검증을 빼지 않는다.** 둘은 다른 층이다 — ATS 는 연결을 막고,
/// 이 함수는 이유를 말한다.
library;

/// 판정 결과. 오류는 **문구가 아니라 사유**다 — 문구는 i18n 이 고른다(§7-2).
enum ServerUrlProblem {
  /// 아무것도 안 적었다.
  empty,

  /// 주소의 모양이 아니다(스킴이 없거나, 호스트가 없거나, 파싱되지 않는다).
  malformed,

  /// 평문 `http://` 다. iOS 가 막는다.
  insecure,
}

/// 성공하면 [normalized] 에 **끝 슬래시를 뗀** 주소가, 실패하면 [problem] 이 담긴다.
class ServerUrlResult {
  const ServerUrlResult.ok(this.normalized) : problem = null;
  const ServerUrlResult.fail(this.problem) : normalized = null;

  final String? normalized;
  final ServerUrlProblem? problem;

  bool get isOk => problem == null;
}

/// 사람이 친 주소를 판정한다.
///
/// 규칙:
/// - 앞뒤 공백은 **오류가 아니라 흔한 일**이다(복사·붙여넣기). 떼고 본다.
/// - 스킴이 없으면 `https://` 를 **붙여 준다.** `example.com` 을 오류로 돌려보내면
///   사람은 무엇이 틀렸는지 모른 채 다시 친다 — 여기서 고를 수 있는 값이 하나뿐이므로
///   (평문은 어차피 막힌다) 추측이 아니라 결정이다.
/// - `http://` 는 **거절한다.** 고쳐 주지 않는다 — 사람이 평문 서버를 의도했다면
///   `https://` 로 조용히 바꾼 주소는 붙지 않고, 그때 실패는 다시 사유를 잃는다.
/// - 끝 슬래시는 뗀다. 데스크탑 `ApiClient` 도 같은 일을 한다(`baseUrl.replace(/\/$/, '')`)
///   — 안 떼면 모든 경로가 `//messages` 가 된다.
ServerUrlResult validateServerUrl(String raw) {
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return const ServerUrlResult.fail(ServerUrlProblem.empty);

  final withScheme =
      trimmed.contains('://') ? trimmed : 'https://$trimmed';

  final uri = Uri.tryParse(withScheme);
  if (uri == null || uri.host.isEmpty) {
    return const ServerUrlResult.fail(ServerUrlProblem.malformed);
  }

  if (uri.scheme == 'http') {
    return const ServerUrlResult.fail(ServerUrlProblem.insecure);
  }
  if (uri.scheme != 'https') {
    return const ServerUrlResult.fail(ServerUrlProblem.malformed);
  }

  // 경로·질의·조각은 서버 주소의 일부가 아니다. 남겨 두면 `https://h/x` + `/channels`
  // 가 되어 조용히 404 가 난다.
  final normalized = Uri(
    scheme: uri.scheme,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
  ).toString();

  return ServerUrlResult.ok(normalized);
}
