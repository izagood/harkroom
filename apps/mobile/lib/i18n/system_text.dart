import '../api/models.dart';
import 'strings.dart';

/// 서버 시스템 줄의 번역 표지(`meta.i18n = { key, args }`)를 앱 언어로 적는다(i18n P5 ③).
/// 원본은 데스크톱 `lib/systemText.ts` 이고, 키 표는 `packages/shared/src/systemI18n.ts` 의
/// `SYSTEM_I18N_ARGS` 다 — **아래 표는 그 사본**이다(Dart 가 TS 를 못 읽는다). 서버에 키가 더해지면
/// 여기와 en·ko 의 [Strings.systemTemplates] 에 함께 더한다. 모르는 키는 `null` 이라 본문으로 물러난다.
///
/// 지키는 것(security C2·C3·C4):
/// - C2 `kind == system` 일 때만.
/// - C3 키가 이 표에 있고, 인자 이름이 정확히 같고, 값은 문자열(200자 이하) 또는 유한한 수.
/// - C4 `...Id` 인자는 지금 handle(모르면 [Strings.systemAccountUnknown]). 문자열 인자의 제어·방향 바꿈
///   문자를 지운다. 화면은 이 결과를 **마크다운 없이 글로만** 그린다(`message_tile.dart`).
const Map<String, List<String>> systemI18nArgs = {
  'system.member.added': ['accountId'],
  'system.member.left': ['accountId'],
  'system.member.removed': ['accountId'],
  'system.threadModel.set': ['accountId', 'agentId', 'value'],
  'system.threadModel.setByAgent': ['accountId', 'agentId', 'value'],
  'system.threadModel.cleared': ['accountId', 'agentId'],
  'system.threadModel.clearedByAgent': ['accountId', 'agentId'],
  'system.merge.approvalUsed': ['repo', 'number', 'head', 'ghUser'],
  'system.merge.approvalUsedRelaxed': ['repo', 'number', 'head', 'ghUser'],
  'system.merge.merged': ['repo', 'number', 'sha'],
  'system.merge.mergedGranted': ['repo', 'number', 'sha', 'granterId'],
  'system.merge.failed': ['repo', 'number', 'head'],
  'system.apiCall.done': ['connector', 'method', 'path', 'status'],
  'system.apiCall.doneGranted': ['connector', 'method', 'path', 'status', 'granterId'],
  'system.apiCall.unreachable': ['connector', 'method', 'path'],
  'system.apiCall.unreachableGranted': ['connector', 'method', 'path', 'granterId'],
  'system.apiBlocked': ['agentId', 'connector', 'request', 'code'],
  'system.apiBlocked.noConnector': ['agentId', 'request', 'code'],
  'system.delegation.pending': ['fromId', 'toId', 'scope', 'rootId'],
  'system.delegation.done': ['fromId', 'toId', 'scope', 'rootId'],
  'system.secret.createdGenerated': ['agentId', 'name', 'type', 'ownerId'],
  'system.secret.createdImported': ['agentId', 'name', 'ownerId'],
  'system.secret.rotatedGenerated': ['agentId', 'name', 'version', 'type', 'ownerId'],
  'system.secret.rotatedImported': ['agentId', 'name', 'version', 'ownerId'],
  'system.skill.proposed': ['slug'],
  'system.skill.proposedFlagged': ['slug', 'reason'],
};

const int _maxArgLength = 200;
final RegExp _placeholder = RegExp(r'\{(\w+)\}');
final RegExp _unsafe = RegExp('[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]');

String? systemText(MessageRow message, Map<String, AccountView> accounts, Strings t) {
  if (message.kind != MessageKind.system) return null;
  final tag = message.meta['i18n'];
  if (tag is! Map) return null;
  final key = tag['key'];
  final args = tag['args'];
  if (key is! String || args is! Map) return null;
  final names = systemI18nArgs[key];
  final template = t.systemTemplates[key];
  if (names == null || template == null) return null;
  if (args.length != names.length) return null;
  final out = <String, String>{};
  for (final name in names) {
    if (!args.containsKey(name)) return null;
    final v = args[name];
    if (v is String) {
      if (v.length > _maxArgLength) return null;
      // 막힘 사유는 사전에 있는 것만 옮기고, 모르는 code 는 글자 그대로(designer n5, security n2).
      if (name == 'code' && t.blockedWhy.containsKey(v)) {
        out[name] = t.blockedWhy[v]!;
        continue;
      }
      out[name] = name.endsWith('Id')
          ? (accounts[v]?.handle ?? t.systemAccountUnknown).replaceAll(_unsafe, ' ')
          : v.replaceAll(_unsafe, ' ');
    } else if (v is num && v.isFinite) {
      out[name] = v is int || v == v.roundToDouble() ? v.toInt().toString() : v.toString();
    } else {
      return null;
    }
  }
  // **한 번에** 바꾼다(security F1). 인자를 하나씩 차례로 바꾸면 앞에서 끼운 값 안의 `{뒤 인자}` 가
  // 뒤 차례에서 또 풀린다 — 에이전트가 보고한 path 에 `{granterId}` 를 넣어 남의 이름을 줄 중간에 지어낼 수 있다.
  return template.replaceAllMapped(_placeholder, (m) => out[m[1]] ?? m[0]!);
}
