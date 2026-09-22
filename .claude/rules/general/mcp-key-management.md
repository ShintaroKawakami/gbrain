<!-- agents-md-card:start -->
### CARD: mcp-key-management — APIキーはHUB SSOT
- **いつ**: MCPキー・`.env`・認証ヘッダを触るとき
- **何を**: 実値は `~/.config/agent-hub/.env` のみ。PJ `.env` 直書き禁止。gitへ平文キー禁止
- **できた状態**: SSOT以外にキー実値が無く、ヘッダ方式で同期できる
- **詳細**: `.claude/rules/general/mcp-key-management.md`
<!-- agents-md-card:end -->

# MCP API キー管理規範（AGENT-HUB SSOT）

制定経緯（CaD）: `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md`「決定履歴（CaD 移設）— mcp-key-management.md 由来」節（#12 圧縮経緯・#13/#14 条件付きロード降格の試行と撤回経緯）を参照。本ルールはセキュリティ規範（API キー管理）のため常時ロードを維持する（constructive-dissent.md「個人開発スケールと例外」例外(a)）。

JTT 関連の MCP（asana-mcp / jtt-smaregi-mcp / smaregi-docs / google-chat-mcp / google-docs-mcp / jtt-spreadsheet-mcp 等）の API キーは **AGENT-HUB を SSOT として一元管理**する。

詳細手順（復旧・ローテーション・実装経緯・実例）の全文は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` を参照。本ルールは義務・禁止事項だけを持つ。

## SSOT

| 役割 | 場所 | 状態 |
|------|------|------|
| 実値（秘匿） | `~/.config/agent-hub/.env` | コミット対象外、各マシンで作成 |
| 名前テンプレート（公開） | `~/business/AGENT-HUB/dotfiles/.env.example` | git 管理、新マシン bootstrap で参照 |
| 環境変数 export | `~/.zshrc.local` の `set -a; source ~/.config/agent-hub/.env; set +a` | bootstrap.sh が初期セットアップ |

## スコープ振り分け規範

| MCP 種別 | 配布先 | 同期スクリプト |
|---------|--------|---------------|
| 全 PJ 共通で必要な MCP | `asset_contract.global.include.mcp` から各clientの宣言surfaceへ | manifestが所有者として指す単一writer |
| harness type共通の MCP（例: Laravel Boost） | `asset_contract.harness_types.<type>.include.mcp` からProject scopeへ | `sync-agents.py` generation batch内の単一writer |
| PJ 固有の業務 MCP | `asset_contract.projects.<pj>.include.mcp` からProject scopeへ | `sync-agents.py` generation batch内の単一writer |
| PJ 個別環境の例外（例: Supabase stg/prod） | project layerと明示local-exception契約へ宣言 | writerが保護・描画。生成surfaceの手編集は禁止 |

理由: User scope に PJ 固有 MCP を入れると「使わない PJ でも表示・接続試行・認証エラー表示」が起きる。PJ別の使用意図はmanifestのproject layerが表現し、client別catalogは選択根拠にしない。

**Gmail の扱い（2026-05-25 更新 / 2026-07-20選択経路更新）**: 自前 gmail-mcp は 2026-05-21 に一度凍結したが、公式 Gmail のツール不足（ラベル CRUD / Triage / 添付取得欠如）が判明し **2026-05-25 に Project scope (jtt-cafe-pj) で復活**。接続definitionはStreamable HTTP `/mcp` + X-API-Keyを維持する。採否はjtt-cafe-pjのmanifest project layer、client対応可否は同じeffective MCPに対するsurface契約で判定する。

**Supabase の stg / prod 2 環境並列 (jtt-cms)**: `supabase-prod` / `supabase-stg` の2 assetを命名規約として必須にする（`supabase` 単独名・env-agnostic な `mcp__supabase__*` 表記は禁止）。実例・OAuth手順の詳細は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` を参照。

## Claude Code の `${VAR}` 補間仕様

**Claude Code は `mcpServers[*].headers["X-API-Key"]` 等の値を `${VAR}` 補間しない**（User scope / Project scope どちらも同じ）。

→ sync スクリプトは `~/.config/agent-hub/.env` から実値を読み出し、`<pj>/.mcp.json` / `~/.claude.json` には実値を書き込む。

→ よって `.mcp.json` は **gitignore 必須**（実値がコミットされないように）。AGENT-HUB の SSOT は環境変数名のみ保持し、各マシンで sync 実行時に実値展開する。同じ理由で `~/.claude.json` / `.gemini/settings.json` / `.cursor/mcp.json` / `.kimi-code/mcp.json` も全て gitignore 必須（対象ファイルと生成元の gitignore 必須リストは `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` を参照）。

## 禁止事項

1. **`~/mcp-servers/<svc>/.env` へ直書き禁止**。`asana-mcp/.env` `jtt-smaregi-mcp/.env` 等に API キーを置かない。発見次第 `~/.config/agent-hub/.env` へ移行し、ローカル `.env` は `# moved to ~/.config/agent-hub/.env (AGENT-HUB SSOT)` のコメントだけ残す
2. **`~/.zshrc.local` に `_mcp_load_key_from_env` のような分散ロード関数を新設禁止**。AGENT-HUB SSOT の bootstrap フロー（`set -a; source ~/.config/agent-hub/.env; set +a`）を使う
3. **git 管理対象ファイルに API キー実値を平文で書かない**。ドキュメント（README / SKILL.md / 設計書）では `<API_KEY_PLACEHOLDER>` または env 変数名 `${ASANA_MCP_API_KEY}` で表記する
4. **ローカル生成物へ手作業で API キー実値を書かない**。`.mcp.json` / `~/.claude.json` は gitignore 済みであることを前提に、sync スクリプトだけが `~/.config/agent-hub/.env` から実値展開して書き込む
5. **管理対象ファイルでの URL クエリパラメータ方式（`?api_key=...`）禁止**。サーバー・プロキシのアクセスログに URL ごとキーが残るため、`.mcp.json` / `~/.claude.json` / `.codex/config.toml` など AGENT-HUB が生成する設定は `headers: {"X-API-Key": "${...}"}` のヘッダー方式に統一する

**Claude.ai 例外**: Claude.ai コネクタで `X-API-Key` ヘッダーを設定できない場合のみ、asana-mcp は `https://asana-mcp.jtt.cafe/mcp?api_key=<ASANA_MCP_API_KEY>` 形式を使ってよい。この例外は Claude.ai 手動登録専用で、AGENT-HUB の生成物には書かない。

## PJ 横断の第三者個人情報（PII）の退避規範（2026-08-14〜）

PJ 横断で扱う第三者の個人情報（PII）は、API キーと同じ扱いで **git 管理対象へ入れない**。実値は
`~/.config/agent-hub/<用途>-private/`（実例: `~/.config/agent-hub/prompts-private/cloud-common-system-prompt.json`）へ
退避し、git 側は**トークン名（プレースホルダ）だけ**を持つ。gitignore 必須・sync スクリプトだけが実値展開する点は
上記 API キー規範と同一とする。

## 再発防止: sync スクリプトのハードエラー化

`scripts/sync-claude-global-mcp.py`、`scripts/sync-claude-project-mcp.py`、`scripts/sync-codex-mcp-configs.py`、`scripts/sync-cursor-mcp-configs.py`、`skills/{gemini,kimi,opencode,augment}-sync/scripts/sync-*-from-cc.py` は、env_key が未解決（`~/.config/agent-hub/.env` に無い／空文字）の場合に **literal `${VAR}` を書き込まず exit 1** すること。

理由・過去の実害（jtt-cms で `smaregi-docs` MCP の認証エラーが反復した根本原因）は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` を参照。

## 再発防止: MANAGED block の重複キー除去 + TOML 検証（Codex / 2026-06-02〜）

`scripts/lib/user_mcp_sync_lib.py` の `replace_managed_block` は、①同名野良エントリの自動除去 ②書き込み前 TOML パース検証、を担保する（MANAGED 対象でない手書き MCP は保護する）。実装経緯・障害の症状は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` の「Codex config TOML 重複キー」節を参照。

## 復旧手順（MCP Auth エラー時）

詳細は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md`。要旨: ①env が読めているか確認 ②`~/.claude.json` の literal `${VAR}` 残存検査 ③対象projectを公開入口から再同期 ④Claude Code を再起動。

## ローテーション手順

API キーローテーション時の 7 ステップ（新キー発行 → SSOT 更新 → dry-run 確認 → full apply → 個別sync禁止 → 各PJ再起動 → 旧キー失効）の全文は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` を参照。旧キーを `dotfiles/.env.example` のコメントに「廃止済み」として残してはいけない。

## User scope MCP 同期フレームワーク (2026-05-21〜)

User scope MCP (`~/.<tool>/...`) の SSOT 一元管理は **user-mcp スキル**が管轄する（User scope / Project scope の設計と担当 sync スクリプトの対応表は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` を参照）。新エージェント追加 5 ステップ (手順本文: `~/business/AGENT-HUB/docs/architecture/claude-md-cad-archive.md` §D 参照): `skills/user-mcp/SKILL.md`。

## 関連

- `dotfiles/.env.example` — 名前テンプレート
- `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` — 復旧手順・ローテーション手順・実装経緯・User scope同期フレームワーク対応表の詳細正本
- `skills/user-mcp/SKILL.md` — User scope MCP 5 ツール統一管理スキル（sync スクリプト一覧はここに集約）
- `scripts/lib/user_mcp_sync_lib.py` — 5 sync 共通 lib (env / registry / MANAGED block / 検証)
- `scripts/sync-claude-project-mcp.py` — Project scope 同期
- `scripts/codex-mcp-remote-with-env.sh` — Codex 用 SSE → stdio bridge
- `~/business/AGENT-HUB/docs/codex-mcp-registry.yaml` `~/business/AGENT-HUB/docs/codex-mcp-definitions.yaml` — 台帳（definitions=接続定義のみ現役。registry の enabled_mcp は選択に不使用）
- `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` — 障害復旧ランブック
- `docs/reference/project-roots.md` — プロジェクトルート規約

---

**追記ルール: 実測事例・復旧手順・長文詳細は `~/business/AGENT-HUB/docs/runbooks/mcp-auth-recovery.md` へ書き、本ルールには義務・トリガー・禁止事項だけ足す（再肥大化防止）。**
