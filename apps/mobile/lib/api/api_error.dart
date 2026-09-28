/// 서버가 **오류와 함께 보낸 것**. 데스크탑 `packages/desktop/src/lib/api.ts` 의
/// `ApiError` 와 같은 모양이고, 같은 이유로 `payload` 를 버리지 않는다.
///
/// 서버의 오류 봉투는 `{ "error": { "code", "message" } }` 이고, 어떤 오류는 **거절만
/// 하지 않고 현재 상태를 함께 준다**(예: 409 `doc_stale` 이 현재 본문을 싣는다).
/// 그것을 여기서 버리면 화면은 "누가 먼저 고쳤다"고만 말하고 무엇이 달라졌는지는 못
/// 보여 준다 — 사람은 자기 편집을 버릴지 말지 판단할 근거를 잃는다.
class ApiError implements Exception {
  ApiError(this.status, this.code, this.message, [this.payload]);

  final int status;

  /// 서버가 준 기계용 코드. 없으면 `'unknown'`.
  final String code;
  final String message;

  /// 파싱된 응답 본문 전체. 없을 수 있다.
  final Object? payload;

  /// **자격증명이 죽었다**는 뜻인가. 이 둘은 **기다려도 낫지 않는다** —
  /// 재시도 백오프에 넣으면 영원히 돈다(`ws.dart` 의 같은 판정).
  bool get isCredentialFailure => status == 401 || status == 403;

  @override
  String toString() => 'ApiError($status $code): $message';
}

/// 서버에 **닿지도 못했다**. 껐다 켜면 낫는 부류다 — [ApiError] 와 갈라 두는 이유가
/// 그것이다. 상태 코드가 없으면 판정할 근거도 없다.
class NetworkError implements Exception {
  NetworkError(this.cause);
  final Object cause;

  @override
  String toString() => 'NetworkError: $cause';
}
