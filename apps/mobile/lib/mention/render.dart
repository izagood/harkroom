import '../api/models.dart';
import '../i18n/strings.dart';
import '../i18n/system_text.dart';

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

/// **복사·붙여넣기용** 본문 — 아는 계정 토큰만 `@handle` 로 되돌린다(데스크톱 `bodyAsHandles`).
///
/// [renderMentions] 와 다른 점: **모르는 토큰은 그대로 둔다.** 화면은 `<@uuid>` 보다 [unknown]
/// 이 낫지만, 복사한 글은 다시 붙여넣을 글이다 — 토큰은 붙여넣으면 서버가 다시 그 대상을
/// 찾아 주고, [unknown] 은 대상을 영영 잃는다. 집합·팀은 모바일이 이름표를 안 받아 오므로
/// 토큰으로 남는다.
String bodyAsHandles(String body, Map<String, AccountView> accounts) =>
    body.replaceAllMapped(_token, (m) {
      if (m.group(1) != null) return m.group(0)!;
      final handle = accounts[m.group(2)]?.handle;
      return handle == null ? m.group(0)! : '@$handle';
    });

/// 접두가 붙은 쪽을 **먼저** 적는다 — 원본 `ANY_MENTION_TOKEN_PATTERN` 과 같은 순서다.
final RegExp _token = RegExp(
  r'<@((?:group|team):[0-9a-f-]{36})>|<@([0-9a-f-]{36})>',
);

/// 시스템 메시지 본문에서 "이 계정"이 들어갈 자리. 원본은 `packages/shared` 의
/// `SYSTEM_ACCOUNT_PLACEHOLDER` 다.
const systemAccountPlaceholder = '{account}';

/// 사람에게 보여 줄 메시지 본문 — 원본은 데스크톱 `lib/mention.ts` 의 `displayBody` 다.
///
/// 서버는 시스템 메시지(채널 입·퇴장, 스레드 모델 지정)의 본문에 이름을 박지 않고
/// [systemAccountPlaceholder] 만 남긴 채 대상을 `meta.accountId` 로 싣는다 — 이름을 바꾸면
/// 지난 줄도 새 이름으로 그려지게. 그래서 **화면이 채워야 한다**. 이 함수를 안 지나면 사람은
/// `{account}님이 …` 라는 글자를 읽는다(TestFlight 실측).
///
/// 채운 이름에 `@` 를 붙이지 않는다 — 시스템 줄은 사실을 남기는 것이지 부르는 것이 아니다.
/// `meta.accountId` 가 없는 옛 메시지는 본문에 이름이 박혀 있어 그대로 돌아온다.
String displayBody(
  MessageRow message,
  Map<String, AccountView> accounts, {
  required String unknownMention,
  required String unknownAccount,
  Strings? t,
}) {
  // 서버가 번역 표지(meta.i18n)를 실은 시스템 줄은 앱 언어의 문장으로(i18n P5 ③). 못 하면 본문.
  if (t != null) {
    final translated = systemText(message, accounts, t);
    if (translated != null) return translated;
  }
  final accountId = message.meta['accountId'];
  final filled = message.kind == MessageKind.system && accountId is String
      ? message.body.split(systemAccountPlaceholder).join(accounts[accountId]?.handle ?? unknownAccount)
      : message.body;
  return renderMentions(filled, accounts, unknownMention);
}
