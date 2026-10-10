import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/i18n/system_text.dart';
import 'package:harkroom/mention/render.dart';

/// 서버 시스템 줄의 번역 표지를 앱 언어로(i18n P5 ③, security C2·C3·C4).
void main() {
  const id = '0f3c1b2a-1111-4222-8333-944455556666';
  final accounts = {
    id: const AccountView(id: id, handle: 'mira', displayName: 'Mira', isAgent: false, isDisabled: false, avatarAttachmentId: null),
  };
  final en = stringsFor('en');
  final ko = stringsFor('ko');

  MessageRow row(Object? i18n, {MessageKind kind = MessageKind.system}) => MessageRow(
        id: 'm1', seq: 1, channelId: 'c1', threadRootId: null, authorId: id,
        body: '{account}님이 채널에 추가되었습니다.', kind: kind, meta: {'accountId': id, 'i18n': i18n},
        createdAt: DateTime.utc(2026, 10, 10), editedAt: null, reactions: const [], attachments: const [], replyCount: null,
      );

  test('키 표가 shared 의 SYSTEM_I18N_ARGS 와 같다 — 사본이 낡지 않는다', () {
    final src = File('../../packages/shared/src/systemI18n.ts').readAsStringSync();
    final table = <String, List<String>>{};
    for (final m in RegExp(r"'(system\.[\w.]+)': \[([^\]]*)\]").allMatches(src)) {
      table[m.group(1)!] = RegExp(r"'(\w+)'").allMatches(m.group(2)!).map((x) => x.group(1)!).toList();
    }
    expect(table.length, greaterThan(0));
    expect(systemI18nArgs, table);
  });

  test('en·ko 틀이 모든 키에 있고 자리표시자가 그 키의 인자와 정확히 같다', () {
    for (final entry in systemI18nArgs.entries) {
      for (final t in [en, ko]) {
        final tpl = t.systemTemplates[entry.key];
        expect(tpl, isNotNull, reason: entry.key);
        final names = RegExp(r'\{(\w+)\}').allMatches(tpl!).map((m) => m.group(1)!).toSet();
        expect(names, entry.value.toSet(), reason: '${entry.key} $tpl');
      }
    }
  });

  test('id 는 지금 이름, 고른 언어의 문장', () {
    final m = row({'key': 'system.member.added', 'args': {'accountId': id}});
    expect(systemText(m, accounts, en), 'mira was added to the channel.');
    expect(systemText(m, accounts, ko), 'mira님이 채널에 추가됐다.');
    expect(displayBody(m, accounts, unknownMention: '@?', unknownAccount: '?', t: ko), 'mira님이 채널에 추가됐다.');
  });

  test('모르는 id 는 「알 수 없음」(designer 규칙 1)', () {
    final m = row({'key': 'system.member.left', 'args': {'accountId': 'zzz'}});
    expect(systemText(m, accounts, ko), contains('알 수 없음'));
  });

  test('시스템 줄이 아니면 그리지 않는다(C2)', () {
    expect(systemText(row({'key': 'system.member.added', 'args': {'accountId': id}}, kind: MessageKind.user), accounts, en), isNull);
  });

  test('목록 밖 키·틀린 인자·긴 값·원시값 아닌 값은 그리지 않는다 — 본문으로(C3)', () {
    for (final bad in <Object?>[
      {'key': '__proto__', 'args': {}},
      {'key': 'system.member.added', 'args': {}},
      {'key': 'system.member.added', 'args': {'accountId': id, 'x': 1}},
      {'key': 'system.skill.proposed', 'args': {'slug': 'x' * 201}},
      {'key': 'system.skill.proposed', 'args': {'slug': <String>[]}},
      'x', null,
    ]) {
      expect(systemText(row(bad), accounts, en), isNull, reason: '$bad');
    }
    expect(displayBody(row(null), accounts, unknownMention: '@?', unknownAccount: '?', t: en), 'mira님이 채널에 추가되었습니다.');
  });

  test('제어·방향 바꿈 문자를 지운다(C4)', () {
    final out = systemText(row({'key': 'system.skill.proposed', 'args': {'slug': 'a‮b c\u0085d﻿e'}}), accounts, en)!;
    expect(out, isNot(matches(RegExp('[‮ \u0085﻿]'))));
  });
}
