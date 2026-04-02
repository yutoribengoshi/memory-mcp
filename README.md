# memory-mcp

> 「なんか俺のClaude Codeだけ賢くね？」の正体

Claude Code 用の長期記憶 MCP サーバー。セッションを跨いでもメモ・会話の文脈を忘れません。

## 特徴

- **SQLite 永続化** — メモ・会話を SQLite に保存。セッション終了後も記憶が残る
- **日本語全文検索** — FTS5 trigram トークナイザーで日本語の部分一致検索に対応
- **AES-256-GCM 暗号化** — 保存データは自動で暗号化。鍵は `~/.memory-mcp/.key` に保持
- **案件別管理** — 案件（case）単位でメモ・会話を整理。弁護士の実務から生まれた設計
- **ヘブ則リンク** — 連続検索されたメモを自動リンク。使うほど関連記憶が強化される
- **ブロードキャスト** — [claude-peers](https://github.com/AshGw/claude-peers) 連携で複数セッションに一斉通知

## インストール

```bash
# リポジトリをクローン
git clone https://github.com/sekitomoyuki/memory-mcp.git
cd memory-mcp
npm install
```

### Claude Code に設定

`~/.claude/settings.json` の `mcpServers` に追加:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp/index.js"]
    }
  }
}
```

## 使い方

Claude Code のチャットでそのまま使えます。

```
「このメモを保存して: 来週のリリースでは認証フローを変更する」
→ save_note が呼ばれ、暗号化して保存

「認証フローについて前に何か決めたっけ？」
→ search_memory で全文検索、ヘブ則で関連メモも表示

「この会話を保存して」
→ save_conversation で会話全体を保存
```

## ツール一覧

| ツール | 説明 |
|--------|------|
| `save_note` | メモを保存（key 指定で上書き可） |
| `save_conversation` | 会話全文を保存 |
| `search_memory` | 全文検索（日本語対応 + ヘブ則リンク表示） |
| `list_conversations` | 保存済み会話の一覧 |
| `get_conversation` | 会話全文を取得 |
| `delete_conversation` | 会話を削除 |
| `save_case_note` | 案件に紐づけてメモを保存 |
| `list_cases` | 案件一覧 |
| `get_case` | 案件の詳細とメモ・会話一覧 |
| `archive_case` | 案件をアーカイブ |
| `broadcast_note` | メモを保存し全セッションに通知 |
| `get_memory_links` | ヘブ則リンク（関連記憶）を取得 |
| `memory_stats` | 統計情報 |

## データ保存先

```
~/.memory-mcp/
├── memory.db    # SQLite データベース（暗号化済み）
└── .key         # AES-256-GCM 暗号鍵（chmod 600）
```

## ヘブ則リンクとは

神経科学のヘブの法則（"一緒に発火するニューロンは結びつく"）を応用した関連記憶システム。

- 5分以内に連続検索されたメモ同士が自動リンク
- 同じ案件のメモも自動リンク
- 検索するたびに関連記憶が表示される
- 30日以上アクセスされないリンクは自動減衰（weight × 0.95）
- weight < 0.01 のリンクは自動削除

## 動作要件

- Node.js 22+（`node:sqlite` を使用）
- Claude Code

## ライセンス

MIT

## 作者

Tomoyuki Seki（[@sekitomoyuki](https://github.com/sekitomoyuki)）
