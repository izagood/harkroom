import '../api/models.dart';
import '../i18n/system_text.dart';

/// 시스템 줄의 두 겹(시스템 줄 C안, designer 시안 2026-10-24 · jaebin 선택). 데스크톱 `lib/systemLine.ts` 와 같은 판정.
///
/// 시스템 줄(`kind: system`)의 `authorId` 는 그 줄을 **일으킨** 계정일 뿐 말한 사람이 아니다 — 화면은 누구의
/// 발화로도 그리지 않는다. [SystemLineShape.record] 는 아이콘 + 작은 한 줄(이름줄 없음), [SystemLineShape.response]
/// 는 「Harkroom · 시스템」 + 「↳ 누구의 무엇에 대해」 칩. 저장 모양은 그대로라 옛 데이터도 같이 고쳐진다.
enum SystemLineShape { record, response }

final RegExp _recordKey = RegExp(r'^system\.(member|threadModel)\.');

String? _i18nKey(MessageRow m) {
  final tag = m.meta['i18n'];
  if (tag is! Map) return null;
  final key = tag['key'];
  return key is String && systemI18nArgs.containsKey(key) ? key : null;
}

SystemLineShape? systemLineShape(MessageRow m) {
  if (m.kind != MessageKind.system) return null;
  if (m.meta.containsKey('chatApproval') || m.meta.containsKey('blocked') || m.meta.containsKey('secretNotice') ||
      m.meta['skillSlug'] is String) {
    return SystemLineShape.response;
  }
  final key = _i18nKey(m);
  if (key == null) return SystemLineShape.record;
  return _recordKey.hasMatch(key) ? SystemLineShape.record : SystemLineShape.response;
}

/// 기록 줄 아이콘 — 들어옴 ＋ · 나감/내보냄 − · 모델 ⚙ · 그 밖 •.
String systemRecordIcon(MessageRow m) {
  final key = _i18nKey(m) ?? '';
  if (key.startsWith('system.member.added')) return '＋';
  if (key.startsWith('system.member.')) return '−';
  if (key.startsWith('system.threadModel.')) return '⚙';
  return '•';
}

/// 응답 줄 칩의 대상 — 채팅 승인 결과는 그 글([messageId])에 대한 것, 그 밖은 author(카드를 일으킨 에이전트)의 요청.
({String accountId, bool post, String? messageId}) systemLineTarget(MessageRow m) {
  final chat = m.meta['chatApproval'];
  if (chat is Map) {
    final id = chat['messageId'];
    final ok = id is String && RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$').hasMatch(id);
    return (accountId: m.authorId, post: true, messageId: ok ? id : null);
  }
  return (accountId: m.authorId, post: false, messageId: null);
}
