---
description: AI モデル選定指標
paths:
  - "registries/harness-manifest.yaml"
  - "agents.yaml"
  - "skills/agent-dispatch/**"
  - "tools/ai-worker-mcp/**"
  - ".claude/rules/general/ai-model-selection.md"
---

<!-- [2026-07-18][fix]
背景:
  - ユーザー依頼意図: 常駐ルールを短くしても、Codex effort 方針を変えた理由と旧判断を追跡できる状態を保つ。
  - 守るべき業務ルール: `high` は「Codexで実装」の既定に限り、軽微タスクは `medium`、レビューは codex-review、`xhigh` はユーザー明示時だけにする。
  - 他案不採用理由: 旧既定 `medium` へ一律に戻す案は新しい実測を反映できず、長い実測ログを常駐ルールへ戻す案はコンテキストを再肥大化させるため不採用。
対応: 判断理由だけを CaD に残し、詳細な実測ログは agent-dispatch references を正本とする。
-->

# AI モデル選定指標（CodeBar残量バランス / Codex 5.6 / GLM 5.3 / Kimi K2.8 Preview）

全 PJ 共通。コード実装をAIエージェントに任せる際の初期ヒューリスティック。

> ⚠️ これは**法則ではなく初期判断**。母数が小さい（初期 n=4 + 追加観測・人が見ながら実行）。矛盾する観測が出たら現状を優先し、実測ログ（references）を更新すること。

---

## 0-bis. Codex 指名時の固定ルール

- **`codexで実装` / `Codexで実装` / `codex実装` / `Codex実装`** と言われた時だけ、Codex 実装として扱う。
- 実装モデルは固定IDではなく、`agents.yaml#worker_delegation.codex_model_routing` の役割キーから解決する。通常は **routine=Luna（medium、Terraへfallback）**、**standard=Terra（high、Lunaへfallback）** を使う。
- **Sol（xhigh）は難所だけ**に限定する。`high_risk` と `broad_mutation` の組み合わせ、同じ要件の失敗2回以上、または理由付きの `deep_reason` が必要である。
- **Spark（xhigh）は標準枠を守るための overflow**。標準枠が日次ペース上限に達した時だけ自動選択し、通常の第一候補にはしない。
- Codex の Fast は **明示指定時だけ**許可する。自動選択では標準速度を使う。
- 週次枠は10%を予備として残し、自動選択は経過日数に応じた90%上限でペース配分する。95%以上、残量不明、古い計測値は標準ルートを自動停止する。
- モデルを更新するときは `agents.yaml` の catalog entry と役割参照だけを変更する。コードやこのルールへ runtime ID を追加しない。
- **「実装」だけでは Codex 固定にしない**。Cursor / Kimi / GLM / Claude / Codex のどれで進めるかを文脈で判断し、不明なら確認する。
- **「レビュー」または「codexでレビュー」** は既存の `codex-review` 導線を使う。実装の役割選択へ巻き込まない。

---

## 4. 使い分けガイド（第一候補）

<!-- [2026-08-08][feat] ctx-slim 柱3: AI worker 委譲の既定化
背景:
  - ユーザー依頼意図: $200 プラン上限対策として Claude 本体のトークン消費を抑えるため、実装・大量読みを
    AI worker へ寄せる運用を既定化する（ctx-slim プラン承認済み・2026-08-08）。大量読みの第一候補は
    伸太郎殿の指名により Kimi 長大 context 系とする（2026-09-11 時点の現行は K2.8 Preview。
    「Fable の蒸留」説は未確認情報のため根拠にしない）。
  - 守るべき業務ルール: モデル実名・context 上限値をここへハードコードしない（agents.yaml の
    kimi_model_routing を実行時参照）。ガバナンス領域（.claude/ hook 等）は worker が編集できないため
    従来どおり Claude が担う。
  - 他案不採用理由: 専用ルール新設は常時ロード量を増やし ctx-slim の目的に反するため不採用。既存 §4 への
    追記に留める。委譲手順の複製も skills/agent-dispatch との二重管理になるため不採用。
[2026-08-08][feat] 境界行を追記（worker-speed プラン B）。実測（job 8714b5dc）で小タスクの往復コストが
  実装時間を上回る事例が出たため、既定の適用範囲を1行で明示する。閾値・手順の詳細は skills/agent-dispatch
  が正本（ここへ複製しない）。専用ルール新設は ctx-slim に反するため不採用。
-->

**既定（2026-08-08 ctx-slim）**: 実装・大量読み（リポ横断の読み込み・大規模ファイル調査）は AI worker への委譲を既定とし、Claude（PM）は設計・検証・統括に徹する。大量読みの第一候補は **Kimi（現行 K2.8 Preview・1M）**（長大 context 対応。選択条件・上限は `agents.yaml` の `kimi_model_routing` を正本とする）。目的: Claude 本体のクレジット消費を抑える（ガバナンス領域 `.claude/` `hook` 等は worker 編集不可のため従来どおり Claude が担う）。

**境界（2026-08-08）**: 見積り10分未満の小実装とガバナンス領域（`.claude/` `hook` 等の worker 編集不可領域）は Claude サブエージェント内製、大タスク・並列・大量読みは worker（判定手順は `skills/agent-dispatch` が正本）。

**三役の呼称（2026-08-31、2026-09-11更新）**: 監督=Claude / Codex 5.6 / Cursor（PM クライアント）／参謀=Kimi（現行 K2.8 Preview）／職人=CodeBar残量と task fit で配分する Codex 5.6 Luna/Terra・Kimi K2.8 Preview・GLM 5.3 系・Gemini Flash High。Codex Sol は難所限定、Spark はoverflow。OpenCode GoはHermes専用としてAI Worker候補から除外する。Antigravity が自動選定された時は High を基準にする。現行Gemini世代は `agents.yaml#model_catalog.model_families.gemini-flash` を参照する。正本: `agents.yaml` の `role_titles` と `worker_delegation`。

**Fable 使用条件（2026-08-11・ctx-save）**: Fable は難所（設計・承認判断／原因不明バグの診断／ガバナンス領域編集）限定。調査・大量読み・軽作業は使わない。重い調査が主目的のセッションは、セッションモデル自体を Sonnet 既定で開始する（第二弾 2026-08-11）。正本・境界の全文は `agents.yaml` の `task_routing.fable_usage_policy`（`session_model_default` 含む）を参照（複製しない）。

<!-- [2026-09-03][feat]
背景:
  - ユーザー依頼意図: 調査・監査を含むサブエージェントの節約時切替を共通化する。
  - 守るべき業務ルール: `agents.yaml#subagent_routing` を唯一の役割別正本とし、OpenCode GoはAI Workerで使わない。
  - 他案不採用理由: 本ruleへ固定モデルやfallback順を重複記載する案は世代交代時にドリフトするため不採用。
対応: role resolverを必須化し、固定モデル指定の旧規約を置き換える。
-->

**調査・監査系サブエージェントへ委譲する時の規約**: `scripts/resolve-subagent.py <role>` で `agents.yaml#subagent_routing` を解決する。候補順を本ruleへ複製しない。image / stitch はSonnet内製を維持し、AI Workerでは `ocg` / `opencode-go/*` を使わない。

| タスク種別 | 第一候補 | 理由 |
|-----------|---------|------|
| 仕様が明確・クリーンさ重視・UI/結線・お手本コード | **CodeBar残量が多い高品質候補（GLM / Codex Luna・Terra / Kimi K2.8 / Gemini High）** | 固定 provider に寄せず、残量と task fit の同じ品質帯から選ぶ |
| 通常の実装 / DB・認証・本番・横断 | **CodeBar残量が多い高品質候補。難所は Codex Sol または Gemini High / GLM 5.3** | 明示の安全条件・難度条件を残量加点で覆さない |
| 小〜中の明確な実装 | **Codex 5.6 Luna / Terra または残量に余裕のある Kimi K2.8 / GLM / Gemini High** | Codex は役割キーで解決。通常は Luna、標準は Terra。Kimi が選ばれた時は K2.8 Preview |
| 難所・広域変更 | **Codex 5.6 Sol xhigh** | 構造化された難所条件を満たす時だけ |
| 複雑バックエンド・高品質候補の枯渇時 | **役割resolverが返す利用可能候補** | `agents.yaml#subagent_routing` の順序に従う |
| 巨大 context の読み込み・リポ横断調査 | **Kimi K2.8 Preview**（参謀。実装で選ばれた場合も同じ高品質枠） | 1M context 対応。用途に応じて参謀と職人を分ける |

### CodeBar残量バランス（自動選定の共通ルール）

`agents.yaml.worker_delegation.usage_balance` を正本とする。`get_worker_capabilities(include_usage: true)` で CodeBar の使用済み割合を確認し、残量が多い高品質 routeへ配分する。task fit、明示 provider、難所・安全条件、hard limit は残量加点より優先する。stale / future / unknown の計測値は自動バランスへ使わない。OpenCode GoはAI Worker候補から除外する。

### Kimi 内モデル選択（決定論的）

`agents.yaml.worker_delegation.kimi_model_routing` を正本とし、明示 `provider_model` → 直接 `kimi` 指定時の `KIMI_CODE_MODEL` → long-context ガードの `opencode_long_context_model` → 自動選定で Kimi が選ばれた時の `auto_worker_model`（現行 `kimi-for-coding` = K2.8 Preview）→ 明示的な速度優先かつ3倍quota許容時の `kimi-for-coding-highspeed` → 既定の `opencode_default_model`（現行 `kimi-for-coding`）の順で扱う。自動選定では long-context 条件を `auto_worker_model` より優先し、マシン全体の `KIMI_CODE_MODEL` は auto 経路へ渡さない。K3（`kimi-for-coding/k3`・`kimi-for-coding/k3-256k`）は明示指定の互換経路として残る。

- 長大 context 条件: `requires_long_context=true`、推定contextが既定モデルの13/16（1Mなら約852K token）超、または推定不能かつraw UTF-8が既定モデルcontextの2倍超。閾値は catalog `context_window` から計算する（`agents.yaml` が正本）。
- K2.8 Preview: 上限1,048,576 token、effort `low` / `high` / `max` を `kimi_variant` で指定可（既定 `high`）。
- 選定結果: `reason_code` / `selected_model` / `estimated_context` / `fallback_reason` を必ず残す。
- モデル切替: 新sessionを開始し、必要情報の要約だけを渡す。履歴を丸ごと移送しない。

GLM 5.3 の reasoning_effort は low / high / max（thinking 無効化は不可。コーディング既定は max。low / high は明示指定時のみ。他の値はルーティングのバリデーションで拒否される）。母数は n=4 の初期観測であり法則ではない（冒頭⚠️参照）。

---

## 5. 運用上の必須ガード（モデルの弱点を相殺する）

- **完了の定義を検証可能に**（Kimi の過大申告対策）: 「スクショは git にコミット」「テストは緑のログを示す」等、"やったと言うだけ"を許さない。
- **スコープを超えるなを明示**（Kimi の過剰実装対策）: 「指定範囲のみ。追加の堅牢化は別 PR」。
- **長時間タスクは声がけ / 自動継続**（GLM の停滞対策）。
- **リポの前提を渡す**（GLM の取り違え対策）: 言語・パッケージ管理の前提を明記。
- **既存 CaD コメント規約に倣わせる**: 新規関数・ブロック追加時は対象ファイルの既存様式（日付・種別・背景3点）に倣うと明記する。

---

## 6. 候補提案とディスパッチ

実装委譲・並列実装の話題が出たら §4 を根拠に「GLM 5.3 向き / Kimi向き」を 1 行理由つきで先に提案し、Kimi内の K2.8/K3 は上記契約で選ぶ。ディスパッチ実行は `agent-dispatch` スキルへ（未導入環境では §4・§5 のみ使う）。役割分担: 方針選定・委譲・進捗確認・結果回収 = Claude / Codex。実行は `agents.yaml` の有効 provider だけを AI Worker MCP 経由で行う。プロンプトには §5 の必須ガードを必ず織り込む。

詳細手順は `skills/agent-dispatch/` を参照（本ルールは方針、skill は手順＝DRY）。

<!-- [2026-08-13][fix]
背景:
  - ユーザー依頼意図: 2026-08-13 に AI Worker MCP へ provider:"auto" で委譲したところ、codexbar 実測で
    glm/ocg/kimi/antigravity の4ルートが ok（残量あり）だったにも関わらず、auto ルーターが unknown 判定の
    opencode/latest ルートを選び、さらに agents.yaml の model_catalog に存在しない model_id
    （opencode-go/kimi-k3）で起動し、629秒間ハートビートゼロ・0行編集のまま沈黙死した
    （job_id 59003758-c6b7-4cb3-af0a-5470685ed4ef）。同一経路の失敗は課題 #74（empty_diff）に続く再発であり、
    根本原因は委譲前に既存ツール `get_worker_capabilities` を呼ばず auto 任せにした PM 側の運用だった。
  - 守るべき業務ルール: `plan-commitment-tracking.md` §3「AI worker 摩擦は観測＝即発火（正本修正）」。
    委譲前 preflight は既存 MCP ツールを使うだけで防げる摩擦であり、義務化しないと再発する。
  - 他案不採用理由:
    1) auto ルーター側だけを直す案は tools/ai-worker-mcp/ のコード修正が別タスク範囲であり、
       本追記は PM 側の運用義務（rule）を先に固定する目的のため不採用（別タスクで扱う）。
    2) 手順を skill 側だけに書いてルールへ書かない案は、義務が「常時ロードされるルール」に無いと
       auto 任せの再発を防げないため不採用（義務はルール、手順は skill の二段構えを維持）。
対応: 委譲前 preflight（get_worker_capabilities 必須化・unknown ルート不採用・台帳外モデル禁止・
  2分ハートビート早期見切り）を全PJ共通の義務として追記した。
-->

**委譲前 preflight を必須にする（2026-08-13）**: AI Worker MCP へ委譲する前に必ず `get_worker_capabilities`（`include_usage: true`）を呼び、`state: ok` のルートから **provider を明示指名**する。`provider: "auto"` 任せを既定にしない。

- **`unknown` を「使える」と見なさない**: 残量が `unknown` のルートは、`ok` のルートが 1 つでも存在する限り選ばない。
- **台帳に無いモデルを使わない**: `agents.yaml` の `model_catalog` に `availability: verified` として存在しない model_id では委譲しない。
- **早期見切り**: 委譲後 2 分でハートビート（最初の意味のある出力）が無ければ、stale 判定を待たずキャンセルして別ルートへ振る。
- 上記は**全 PJ 共通**の義務であり、対象 PJ を限定しない。

詳細手順（preflight の呼び出し順・2分ハートビート確認手順）は `skills/agent-dispatch/SKILL.md` を参照（本ルールは義務、skill は手順＝DRY）。

---

## 8. 関連

- `skills/agent-dispatch/` — `agents.yaml` と AI Worker MCP を使う worker 委譲手順（本ルールの実行系）
- `skills/kimi-sync/` — Kimi CLI のPJアタッチ（`sync-kimi-from-cc.py`）
- `.claude/rules/general/response-style.md` — 出力簡潔性
- `.claude/rules/general/visual-progress-map.md` — 進捗可視化
- `dotfiles/kimi/config.toml.base` — Kimi Code CLI の loop/permission 既定（`max_steps_per_turn` 等）
- 実測ログ・スコアカード・OpenCode Go 選定指標の全文: `<AGENT-HUB>/skills/agent-dispatch/references/model-selection-evidence.md`

`<AGENT-HUB>` は中央ハブrepoのルートを表す（標準配置は `~/business/AGENT-HUB`、別環境では実際の配置先）。

**追記ルール: 実測ログ・スコアカードは references（上記）へ追記し、本ルールには足さない（再肥大化防止）。**
