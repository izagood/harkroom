import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../session/session_store.dart';
import '../state/app_scope.dart';
import '../ui/parts.dart';
import '../ui/tokens.dart';
import 'community_screens.dart';

/// 나 · 이 기기의 커뮤니티(designer ⑧).
///
/// **데스크탑 설정의 대부분이 여기 없다**(계획서 §6): 에이전트 등록, Claude 계정,
/// 오퍼레이터, MCP, 스킬. 폰에서 **할 수 없는 일**이지 잠긴 일이 아니므로 회색으로도
/// 그리지 않는다 — 회색 항목은 "언젠가 열린다"는 거짓 약속이다.
///
/// 로그아웃은 **커뮤니티 하나 단위**다(D7). 전부 빼는 것은 맨 아래 따로 두고 확인을 거친다 —
/// 한 번 잘못 누르면 모든 서버에 다시 로그인해야 한다.
class MeScreen extends StatelessWidget {
  const MeScreen({super.key});

  Future<void> _confirmSignOutAll(BuildContext context) async {
    final t = context.t;
    final k = context.tokens;
    final app = AppScope.read(context);
    final ok = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
          child: Column(
            key: const Key('me-sign-out-all-sheet'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(t.communitySignOutAll,
                  style: const TextStyle(fontSize: HarkroomType.screenTitle, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(t.communitySignOutAllConfirm.replaceAll('{count}', '${app.communities.length}'),
                  style: TextStyle(color: k.mute)),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('me-sign-out-all-confirm'),
                style: FilledButton.styleFrom(backgroundColor: k.err, foregroundColor: Colors.white),
                onPressed: () => Navigator.of(ctx).pop(true),
                child: Text(t.communitySignOutAll),
              ),
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: Text(t.communityCancel),
              ),
            ],
          ),
        ),
      ),
    );
    if (ok == true) await app.signOutAll();
  }

  void _open(BuildContext context, StoredCommunity c) {
    if (c.isExpired) {
      openAddCommunity(context, initialUrl: c.baseUrl);
      return;
    }
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CommunityDetailScreen(accountId: c.accountId),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final me = app.me;

    return Scaffold(
      appBar: AppBar(title: Text(t.tabMe)),
      body: SafeArea(
        child: ListView(
          children: [
            if (me != null)
              ListTile(
                key: const Key('me-handle'),
                leading: const Icon(Icons.person_outline),
                title: Text(t.meSignedInAs.replaceFirst('{handle}', me.handle)),
                subtitle: Text(me.displayName),
              ),
            SectionHeader(label: t.meCommunitiesSection),
            for (final c in app.communities)
              ListTile(
                key: Key('me-community-${c.accountId}'),
                leading: CommunityTile(community: c),
                title: Text(c.displayLabel, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(
                  '@${c.handle} · ${Uri.tryParse(c.baseUrl)?.host ?? c.baseUrl}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: c.isExpired
                    ? Text(t.communityExpired,
                        key: Key('me-community-expired-${c.accountId}'),
                        style: TextStyle(color: k.accent, fontWeight: FontWeight.w600))
                    : c.accountId == app.activeAccountId
                        ? Icon(Icons.check, color: k.accent, semanticLabel: t.communityCurrent)
                        : const Icon(Icons.chevron_right),
                onTap: () => _open(context, c),
              ),
            ListTile(
              key: const Key('me-community-add'),
              leading: const SizedBox(width: 36, child: Icon(Icons.add)),
              title: Text(t.communityAdd),
              onTap: () => openAddCommunity(context),
            ),
            const Divider(),
            ListTile(
              key: const Key('me-sign-out-all'),
              leading: Icon(Icons.logout, color: k.err),
              title: Text(t.communitySignOutAll, style: TextStyle(color: k.err)),
              onTap: () => _confirmSignOutAll(context),
            ),
          ],
        ),
      ),
    );
  }
}
