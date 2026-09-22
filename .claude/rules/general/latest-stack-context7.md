---
description: 最新スタック確認ルール — Next.js/React/serwist等の急速更新ライブラリは実装前にcontext7で最新docsを取得
paths:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.js'
  - '**/*.jsx'
  - '**/*.mjs'
  - '**/*.vue'
  - '**/*.svelte'
  - 'package.json'
  - 'next.config.*'
  - 'tailwind.config.*'
  - 'drizzle.config.*'
  - 'vite.config.*'
  - '**/sw.ts'
---

# 最新スタック確認ルール（context7 必須）

## 対象ライブラリ（AI カットオフ後・急速更新）

以下を**実装・デバッグ・設定変更する前に必ず** context7 で最新 docs を取得する。
記憶だけで書かない（古い API を使うと動かない・型エラー・ビルド失敗を引き起こす）。

| ライブラリ / フレームワーク | 主な罠 |
|----------------------------|--------|
| **Next.js 16+** | `middleware` → `proxy.ts` に改名（Next15→16）、`cookies()`/`headers()` は非同期＝`await` 必須（Next15で async 化・16で同期アクセス廃止）、App Router キャッシュ挙動変更 |
| **React 19+** | Next15 以降は React19 前提。`use()`, Server Actions の型・挙動変更 |
| **@serwist/next** / **serwist** | SW ビルド設定・`defaultCache` API が頻繁変更。Turbopack 非対応（`--webpack` 必須） |
| **motion 12+** (`motion/react`) | `motion-plus` API、`AnimatePresence`・`useSpring` 型変更 |
| **Tailwind CSS v4+** | `@config` 廃止・CSS ファースト設定に移行（`tailwind.config.js` 非推奨） |
| **drizzle-orm** | マイグレーション API・スキーマ定義が毎 minor で変わりやすい |
| **vaul** | ドロワー API・`snapPoints` 型が変わっている可能性 |
| **sonner** | `toast()` オプション・`Toaster` props の更新 |

## 必須手順

1. `mcp__context7__resolve-library-id` でライブラリの context7 ID を取得
2. `mcp__context7__query-docs` で最新 docs を取得してから実装
3. context7 が使えない環境は `WebFetch` で公式 docs を取得（記憶補完のみでの実装禁止）

```
例: Next.js 16 の proxy.ts (旧 middleware) を実装する前に
  → resolve-library-id "next.js" → query-docs "proxy middleware"
例: serwist defaultCache を設定する前に
  → resolve-library-id "@serwist/next" → query-docs "defaultCache"
```

## 古い API の使用禁止

- **Next15 以前の同期 `cookies()`**: Next16 では非推奨。`await cookies()` を前提に書く（context7 で確認）
- **`middleware.ts`（Next16 では `proxy.ts`）**: 名前が変わった。context7 で確認してから書く
- **Pages Router 前提のコード**: App Router が前提。`getServerSideProps` 等を新規に書かない
- **React18 前提の型**: React19 の型変化（`children: ReactNode` の必須化等）を確認してから書く
- **旧 `motion/react` 型**: `motion-plus` の型は memory だけで書かない

## 関連

- `skills/dev-guardrails` — フェーズ別ワークフロー・品質ゲート
- `skills/pwa-guardrails` — serwist 配線・PWA 品質チェックリスト（context7 が必要になる代表例を列挙）
