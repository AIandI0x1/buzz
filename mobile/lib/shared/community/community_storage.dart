import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'community.dart';

class CommunityStorage {
  static const _keyCommunities = 'buzz_communities_device_bound_v1';
  static const _keyActiveId = 'buzz_active_community_id';

  // These pre-device-bound keys may be present after an app upgrade.
  static const _migratableCommunities = 'buzz_communities';

  static const _iosOptions = IOSOptions(
    accessibility: KeychainAccessibility.unlocked_this_device,
    synchronizable: false,
  );

  // Legacy keys for migration.
  static const _legacyCommunities = 'buzz_workspaces';
  static const _legacyActiveId = 'buzz_active_workspace_id';
  static const _legacyRelayUrl = 'buzz_relay_url';
  static const _legacyToken = 'buzz_token';
  static const _legacyPubkey = 'buzz_pubkey';
  static const _legacyNsec = 'buzz_nsec';

  final FlutterSecureStorage _secure;
  final FlutterSecureStorage _legacySecure;

  CommunityStorage({
    FlutterSecureStorage? secure,
    FlutterSecureStorage? legacySecure,
  }) : _secure = secure ?? const FlutterSecureStorage(iOptions: _iosOptions),
       _legacySecure = legacySecure ?? secure ?? const FlutterSecureStorage();

  /// Effective iOS options used by the default storage client.
  @visibleForTesting
  IOSOptions get iosOptionsForTesting => _secure.iOptions;

  /// Load all communities. On first call, migrates legacy single-community
  /// credentials if present.
  Future<List<Community>> loadAll() async {
    final raw = await _secure.read(key: _keyCommunities);
    if (raw != null) {
      final communities = _decodeList(raw);
      await _deleteLegacyCommunityCopies();
      return communities;
    }

    final migratable = await _legacySecure.read(key: _migratableCommunities);
    if (migratable != null) {
      final communities = _decodeList(migratable);
      await _saveListAndVerify(communities);
      await _deleteLegacyCommunityCopies();
      return communities;
    }

    final legacyCommunities = await _legacySecure.read(key: _legacyCommunities);
    if (legacyCommunities != null) {
      final communities = _decodeList(legacyCommunities);
      await _saveListAndVerify(communities);
      final legacyActiveId = await _legacySecure.read(key: _legacyActiveId);
      if (legacyActiveId != null) await saveActiveId(legacyActiveId);
      await _deleteLegacyCommunityCopies();
      await _legacySecure.delete(key: _legacyActiveId);
      return communities;
    }

    // Migration: check for legacy single-community keys.
    final legacyUrl = await _legacySecure.read(key: _legacyRelayUrl);
    final legacyToken = await _legacySecure.read(key: _legacyToken);
    if (legacyUrl != null && legacyToken != null) {
      final legacyPubkey = await _legacySecure.read(key: _legacyPubkey);
      final legacyNsec = await _legacySecure.read(key: _legacyNsec);

      final name = Community.nameFromUrl(legacyUrl);
      final community = Community.create(
        name: name,
        relayUrl: legacyUrl,
        pubkey: legacyPubkey,
        nsec: legacyNsec,
      );

      await _saveListAndVerify([community]);
      await saveActiveId(community.id);

      await _deleteLegacyCommunityCopies();

      return [community];
    }

    return [];
  }

  Future<void> save(Community community) async {
    final all = await loadAll();
    final index = all.indexWhere((w) => w.id == community.id);
    if (index >= 0) {
      all[index] = community;
    } else {
      all.add(community);
    }
    await _saveList(all);
  }

  Future<void> remove(String id) async {
    final all = await loadAll();
    all.removeWhere((w) => w.id == id);
    await _saveList(all);
  }

  Future<String?> loadActiveId() async {
    return _legacySecure.read(key: _keyActiveId);
  }

  Future<void> saveActiveId(String id) async {
    await _legacySecure.write(key: _keyActiveId, value: id);
  }

  Future<void> clearActiveId() async {
    await _legacySecure.delete(key: _keyActiveId);
  }

  List<Community> _decodeList(String raw) {
    final list = jsonDecode(raw) as List<dynamic>;
    return list
        .map((entry) => Community.fromJson(entry as Map<String, dynamic>))
        .toList();
  }

  Future<void> _saveList(List<Community> communities) async {
    await _secure.write(key: _keyCommunities, value: _encodeList(communities));
  }

  Future<void> _saveListAndVerify(List<Community> communities) async {
    final encoded = _encodeList(communities);
    await _secure.write(key: _keyCommunities, value: encoded);
    final stored = await _secure.read(key: _keyCommunities);
    if (stored != encoded) {
      throw StateError('failed to verify device-bound community storage');
    }
  }

  String _encodeList(List<Community> communities) =>
      jsonEncode(communities.map((item) => item.toJson()).toList());

  Future<void> _deleteLegacyCommunityCopies() async {
    for (final key in [
      _migratableCommunities,
      _legacyCommunities,
      _legacyRelayUrl,
      _legacyToken,
      _legacyPubkey,
      _legacyNsec,
    ]) {
      if (await _legacySecure.containsKey(key: key)) {
        await _legacySecure.delete(key: key);
      }
    }
  }
}
