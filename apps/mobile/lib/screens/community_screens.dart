import 'package:flutter/material.dart';

import '../api/api_error.dart';
import '../connect/server_url.dart';
import '../i18n/i18n.dart';
import '../session/session_store.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';

/// 여러 커뮤니티(designer 설계 harkroom://message/30621120-f955-4f07-8f23-9f1837ab99cd, M1 = ③⑧⑨).
///
/// 용어는 데스크탑 레일과 같은 "커뮤니티"다. 이 기기에 로그인해 둔 서버 하나가 커뮤니티 하나다 —
/// 열쇠는 계정 id 다(`session_store.dart`).

/// 커뮤니티 타일 — 이니셜 + 커뮤니티마다 다른 색. 색은 **계정 id 로** 고른다(이름은 바뀐다).
class CommunityTile extends StatelessWidget {
  const CommunityTile({super.key, required this.community, this.size = 36});

  final StoredCommunity community;
  final double size;

  @override
  Widget build(BuildContext context) =>
      HarkroomAvatar(id: community.accountId, name: community.displayLabel, size: size);
}

/// 그 커뮤니티로 옮기고, 옮겼으면 2초 토스트(designer 판정 5 — 이름과 내 핸들을 함께).
///
/// 먼저 맨 아래 화면까지 걷는다: 옮기는 동안 앞 커뮤니티의 화면(커뮤니티 상세·스레드)이 위에
/// 남아 있으면 새 커뮤니티의 상태로 옛 화면을 그린다.
Future<void> enterCommunity(BuildContext context, String accountId) async {
  final app = AppScope.read(context);
  final messenger = ScaffoldMessenger.of(context);
  final t = context.t;
  final margin = toastMargin(context);
  Navigator.of(context).popUntil((r) => r.isFirst);
  if (!await app.switchTo(accountId)) return;
  showSwitchedToast(messenger, t, app.activeCommunity!, app.me?.handle, margin);
}

void showSwitchedToast(
  ScaffoldMessengerState messenger,
  Strings t,
  StoredCommunity community,
  String? handle,
  EdgeInsets margin,
) {
  messenger
    ..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(
      key: const Key('community-switched-toast'),
      content: Text(t.communitySwitched
          .replaceAll('{name}', community.displayLabel)
          .replaceAll('{handle}', handle ?? community.handle)),
      behavior: SnackBarBehavior.floating,
      margin: margin,
      duration: const Duration(seconds: 2),
    ));
}

/// 추가 화면을 띄우고, 로그인했으면 그 커뮤니티로 옮긴다. ✕ 로 닫으면 아무것도 바뀌지 않는다
/// (designer 판정 3 — 원래 커뮤니티 화면 그대로).
///
/// [initialUrl] 은 만료된 커뮤니티의 「다시 로그인」이 주소를 채워 둘 때 쓴다.
Future<void> openAddCommunity(BuildContext context, {String? initialUrl}) async {
  final added = await Navigator.of(context).push<StoredCommunity>(MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => AddCommunityScreen(initialUrl: initialUrl),
  ));
  if (added == null || !context.mounted) return;
  await enterCommunity(context, added.accountId);
}

/// 서버 주소와 로그인을 **한 장에** 받는다(③). 지금 커뮤니티는 로그인된 채 남는다.
class AddCommunityScreen extends StatefulWidget {
  const AddCommunityScreen({super.key, this.initialUrl});

  final String? initialUrl;

  @override
  State<AddCommunityScreen> createState() => _AddCommunityScreenState();
}

class _AddCommunityScreenState extends State<AddCommunityScreen> {
  late final _url = TextEditingController(text: widget.initialUrl ?? '');
  final _loginId = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  ServerUrlProblem? _urlProblem;

  /// 로그인 실패 사유 — 키로 든다(화면이 문장을 짓지 않는다).
  String? _errorKey;

  @override
  void dispose() {
    _url.dispose();
    _loginId.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final url = validateServerUrl(_url.text);
    setState(() {
      _urlProblem = url.problem;
      _errorKey = null;
    });
    if (!url.isOk) return;
    setState(() => _busy = true);
    try {
      final added =
          await context.app.addCommunity(url.normalized!, _loginId.text.trim(), _password.text);
      if (mounted) Navigator.of(context).pop(added);
    } on ApiError catch (e) {
      // 로그인 화면과 같은 판단: 왜 틀렸는지는 말하지 않는다.
      setState(() => _errorKey =
          e.isCredentialFailure ? 'loginErrorRejected' : 'loginErrorUnreachable');
    } on Object {
      setState(() => _errorKey = 'loginErrorUnreachable');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _urlMessage(Strings t, ServerUrlProblem p) => switch (p) {
        ServerUrlProblem.empty => t.connectErrorEmpty,
        ServerUrlProblem.malformed => t.connectErrorMalformed,
        ServerUrlProblem.insecure => t.connectErrorInsecure,
      };

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final problem = _urlProblem;
    final errorKey = _errorKey;
    return Scaffold(
      key: const Key('community-add'),
      appBar: AppBar(
        automaticallyImplyLeading: false,
        leading: IconButton(
          key: const Key('community-add-close'),
          tooltip: t.communityAddClose,
          icon: const Icon(Icons.close),
          onPressed: () => Navigator.of(context).pop(),
        ),
        title: Text(t.communityAdd),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            TextField(
              key: const Key('community-add-url'),
              controller: _url,
              autocorrect: false,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(
                labelText: t.connectServerUrlLabel,
                hintText: t.connectServerUrlHint,
                errorText: problem == null ? null : _urlMessage(t, problem),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('community-add-login-id'),
              controller: _loginId,
              autocorrect: false,
              enableSuggestions: false,
              textInputAction: TextInputAction.next,
              decoration: InputDecoration(labelText: t.loginIdLabel),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const Key('community-add-password'),
              controller: _password,
              obscureText: true,
              textInputAction: TextInputAction.go,
              onSubmitted: (_) => _submit(),
              decoration: InputDecoration(labelText: t.loginPasswordLabel),
            ),
            if (errorKey != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  errorKey == 'loginErrorRejected' ? t.loginErrorRejected : t.loginErrorUnreachable,
                  key: const Key('community-add-error'),
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            const SizedBox(height: 20),
            FilledButton(
              key: const Key('community-add-submit'),
              onPressed: _busy ? null : _submit,
              child: Text(_busy ? t.commonLoading : t.communityAddSubmit),
            ),
          ],
        ),
      ),
    );
  }
}

/// 커뮤니티 하나(⑨): 표시 이름·계정·서버·버전, 옮기기·로그아웃.
class CommunityDetailScreen extends StatefulWidget {
  const CommunityDetailScreen({super.key, required this.accountId});

  final String accountId;

  @override
  State<CommunityDetailScreen> createState() => _CommunityDetailScreenState();
}

class _CommunityDetailScreenState extends State<CommunityDetailScreen> {
  Future<String?>? _version;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_version != null) return;
    final c = _find(AppScope.read(context));
    if (c != null) _version = AppScope.read(context).serverVersionOf(c);
  }

  StoredCommunity? _find(AppState app) {
    for (final c in app.communities) {
      if (c.accountId == widget.accountId) return c;
    }
    return null;
  }

  Future<void> _rename(StoredCommunity c) async {
    final t = context.t;
    final app = AppScope.read(context);
    final controller = TextEditingController(text: c.label ?? '');
    final next = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(t.communityLabel),
        content: TextField(
          key: const Key('community-label-field'),
          controller: controller,
          autofocus: true,
          decoration: InputDecoration(hintText: c.displayLabel, helperText: t.communityLabelHint),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(), child: Text(t.communityCancel)),
          TextButton(
            key: const Key('community-label-save'),
            onPressed: () => Navigator.of(ctx).pop(controller.text),
            child: Text(t.communitySave),
          ),
        ],
      ),
    );
    controller.dispose();
    if (next != null) await app.renameCommunity(c.accountId, next);
  }

  Future<void> _signOut(StoredCommunity c) async {
    final app = AppScope.read(context);
    final nav = Navigator.of(context);
    if (c.accountId != app.activeAccountId) {
      await app.signOutCommunity(c.accountId);
      if (nav.mounted) nav.pop();
      return;
    }
    // 지금 커뮤니티를 빼면 다음 커뮤니티로 옮긴다 — 옮겼다는 것을 토스트로 말한다.
    final messenger = ScaffoldMessenger.of(context);
    final t = context.t;
    final margin = toastMargin(context);
    nav.popUntil((r) => r.isFirst);
    await app.signOutCommunity(c.accountId);
    final now = app.activeCommunity;
    if (now != null && app.me != null) showSwitchedToast(messenger, t, now, app.me!.handle, margin);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final c = _find(app);
    if (c == null) return const Scaffold();
    final isCurrent = c.accountId == app.activeAccountId;

    return Scaffold(
      key: const Key('community-detail'),
      appBar: AppBar(title: ScreenTitle(title: c.displayLabel)),
      body: SafeArea(
        child: ListView(
          children: [
            ListTile(
              key: const Key('community-label'),
              title: Text(t.communityLabel),
              subtitle: Text(c.displayLabel),
              trailing: const Icon(Icons.edit_outlined, size: 18),
              onTap: () => _rename(c),
            ),
            ListTile(title: Text(t.communityAccount), subtitle: Text('@${c.handle}')),
            ListTile(title: Text(t.communityServer), subtitle: Text(c.baseUrl)),
            ListTile(
              title: Text(t.communityVersion),
              subtitle: FutureBuilder<String?>(
                future: _version,
                builder: (_, snap) => Text(snap.connectionState != ConnectionState.done
                    ? t.commonLoading
                    : (snap.data ?? t.communityVersionUnknown)),
              ),
            ),
            const Divider(),
            if (c.isExpired)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: FilledButton(
                  key: const Key('community-relogin'),
                  onPressed: () => openAddCommunity(context, initialUrl: c.baseUrl),
                  child: Text(t.communityExpired),
                ),
              )
            else if (!isCurrent)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: FilledButton(
                  key: const Key('community-switch'),
                  onPressed: () => enterCommunity(context, c.accountId),
                  child: Text(t.communitySwitchTo),
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: TextButton(
                key: const Key('community-sign-out'),
                style: TextButton.styleFrom(foregroundColor: k.err),
                onPressed: () => _signOut(c),
                child: Text(t.communitySignOutOne.replaceAll('{name}', c.displayLabel)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
