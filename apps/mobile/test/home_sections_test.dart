import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/screens/channel_list_screen.dart';

/// S5b: 홈 묶음 규칙(데스크탑 사이드바와 같다).
ChannelRow _c(String id, String name) => ChannelRow.fromJson({'id': id, 'name': name, 'kind': 'standard'});
ChannelPref _p(String id, {bool starred = false, String? section, int? order, bool hidden = false}) =>
    ChannelPref.fromJson({
      'channelId': id,
      'starredAt': starred ? '2026-10-01T00:00:00Z' : null,
      'section': section,
      'sortOrder': order,
      'hiddenAt': hidden ? '2026-10-01T00:00:00Z' : null,
    });

void main() {
  final chans = [_c('a', 'zeta'), _c('b', 'alpha'), _c('c', 'task'), _c('d', 'ops'), _c('e', 'infra'), _c('f', 'misc')];

  test('즐겨찾기 → 사용자 섹션(이름순) → 채널, 별표 채널은 즐겨찾기에만', () {
    final prefs = {
      'c': _p('c', starred: true, section: 'Work'),
      'd': _p('d', section: 'Work'),
      'e': _p('e', section: 'Admin'),
    };
    final secs = homeSections(chans, prefs);
    expect(secs.map((s) => s.key), ['starred', 'section:Admin', 'section:Work', 'channels']);
    expect(secs[0].channels.map((c) => c.id), ['c']);
    expect(secs[2].channels.map((c) => c.id), ['d'], reason: '별표 c 는 Work 에 다시 서지 않는다');
    expect(secs[3].channels.map((c) => c.name), ['alpha', 'misc', 'zeta'], reason: '이름순');
  });

  test('묶음 안은 sortOrder 먼저, 없으면 뒤에 이름순', () {
    final prefs = {
      'a': _p('a', section: 'S', order: 2),
      'b': _p('b', section: 'S'),
      'f': _p('f', section: 'S', order: 1),
    };
    final s = homeSections(chans, prefs).firstWhere((x) => x.key == 'section:S');
    expect(s.channels.map((c) => c.id), ['f', 'a', 'b']);
  });

  test('선호가 없으면(옛 서버) 「채널」 한 묶음, 채널이 없어도 머리는 선다', () {
    expect(homeSections(chans, const {}).map((s) => s.key), ['channels']);
    expect(homeSections(const [], const {}).map((s) => s.key), ['channels']);
  });

  test('prefs 파싱: 빈 섹션 이름은 섹션 없음, hiddenAt 은 hidden', () {
    final p = ChannelPref.fromJson({'channelId': 'x', 'section': '  ', 'hiddenAt': '2026-10-01T00:00:00Z'});
    expect(p.section, isNull);
    expect(p.hidden, isTrue);
    expect(p.starred, isFalse);
  });
}
