import '../api/models.dart';

/// 저장된 멘션 토큰을 **화면에 그릴** `@handle` 로 바꾼다.
///
/// 서버는 본문의 `@handle` 을 저장할 때 `<@계정id>`(집합·팀은 `<@group:id>`·`<@team:id>`)로
/// 바꿔 둔다(#271·#845) — 이름이 바뀌어도 지난 대화가 사람을 잃지 않게. REST·WS 가 주는 본문도
/// 그 정본이다. 그대로 그리면 사람 눈에는 `<@0f3c…>` 가 보인다.
///
/// 원본은 `packages/shared/src/index.ts` 의 `renderMentions` 다. 규칙도 같다:
/// **모르는 id 는 [unknown] 으로 그린다** — `<@uuid>` 를 그대로 두는 것이 더 나쁘다. 사람에게
/// 그 문자열은 아무 뜻이 없고, 무엇이 잘못됐는지도 말해 주지 않는다.
///
/// 집합·팀은 모바일이 이름표를 안 받아 온다 — 그래서 지금은 [unknown] 이다.
String renderMentions(
  String body,
  Map<String, AccountView> accounts,
  String unknown,
) => body.replaceAllMapped(_token, (m) {
  final target = m.group(1);
  if (target != null) return unknown;
  final handle = accounts[m.group(2)]?.handle;
  return handle == null ? unknown : '@$handle';
});

/// 접두가 붙은 쪽을 **먼저** 적는다 — 원본 `ANY_MENTION_TOKEN_PATTERN` 과 같은 순서다.
final RegExp _token = RegExp(
  r'<@((?:group|team):[0-9a-f-]{36})>|<@([0-9a-f-]{36})>',
);
