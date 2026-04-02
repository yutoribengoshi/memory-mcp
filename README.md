# memory-mcp

> "Why does my Claude Code feel smarter than everyone else's?"

Long-term memory MCP server for Claude Code. Your AI remembers context across sessions.

**[日本語](#日本語) | English**

## Features

- **SQLite Persistence** — Notes and conversations survive across sessions
- **Japanese Full-Text Search** — FTS5 with trigram tokenizer for CJK support
- **Semantic Search** — Optional vector search via OpenAI-compatible embedding APIs
- **AES-256-GCM Encryption** — All stored data is encrypted at rest
- **Case Management** — Organize memories by project or case
- **Hebbian Links** — Memories accessed together automatically strengthen their connections
- **Broadcast** — Notify all Claude Code sessions via [claude-peers](https://github.com/AshGw/claude-peers)

## Quick Start

```bash
git clone https://github.com/yutoribengoshi/memory-mcp.git
cd memory-mcp
npm install
```

Add to `~/.claude/settings.json`:

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

### Optional: Enable Semantic Search

Set an OpenAI-compatible API key to enable vector search:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Also supports custom endpoints (Ollama, LMStudio, etc.):

```json
{
  "env": {
    "EMBEDDING_API_KEY": "your-key",
    "EMBEDDING_URL": "http://localhost:11434/v1/embeddings",
    "EMBEDDING_MODEL": "nomic-embed-text"
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `save_note` | Save a note (upsert by key) |
| `save_conversation` | Save full conversation |
| `search_memory` | Full-text search (Japanese + Hebbian links) |
| `semantic_search` | Vector similarity search (requires API key) |
| `list_conversations` | List saved conversations |
| `get_conversation` | Get full conversation by ID |
| `delete_conversation` | Delete a conversation |
| `save_case_note` | Save note linked to a case |
| `list_cases` | List all cases |
| `get_case` | Get case details with notes and conversations |
| `archive_case` | Archive a case |
| `broadcast_note` | Save and broadcast to all sessions |
| `get_memory_links` | View Hebbian links for a memory |
| `memory_stats` | Show statistics |

## How It Works

### Hebbian Links

Inspired by Hebb's rule in neuroscience — "neurons that fire together wire together."

- Memories searched within 5 minutes of each other get automatically linked
- Memories in the same case get linked
- Links strengthen with repeated co-access
- Unused links decay after 30 days (weight x 0.95)
- Links below 0.01 are pruned

### Data Storage

```
~/.memory-mcp/
├── memory.db    # SQLite database (encrypted)
└── .key         # AES-256-GCM encryption key (chmod 600)
```

## Requirements

- Node.js 22+ (uses built-in `node:sqlite`)
- Claude Code
- Optional: OpenAI API key for semantic search

## License

MIT

## Author

Tomoyuki Seki ([@yutoribengoshi](https://github.com/yutoribengoshi))

---

# 日本語

> 「なんか俺のClaude Codeだけ賢くね？」の正体

Claude Code 用の長期記憶 MCP サーバー。セッションを跨いでもメモ・会話の文脈を忘れません。

## 特徴

- **SQLite 永続化** — メモ・会話を SQLite に保存。セッション終了後も記憶が残る
- **日本語全文検索** — FTS5 trigram トークナイザーで日本語の部分一致検索に対応
- **セマンティック検索** — OpenAI互換のEmbedding APIでベクトル類似検索（オプション）
- **AES-256-GCM 暗号化** — 保存データは自動で暗号化。鍵は `~/.memory-mcp/.key` に保持
- **案件別管理** — 案件（case）単位でメモ・会話を整理。弁護士の実務から生まれた設計
- **ヘブ則リンク** — 連続検索されたメモを自動リンク。使うほど関連記憶が強化される
- **ブロードキャスト** — [claude-peers](https://github.com/AshGw/claude-peers) 連携で複数セッションに一斉通知

## インストール

```bash
git clone https://github.com/yutoribengoshi/memory-mcp.git
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

### オプション: セマンティック検索を有効化

OpenAI互換のAPIキーを設定するとベクトル検索が使えます:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/memory-mcp/index.js"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Ollama や LMStudio などのローカルモデルも対応:

```json
{
  "env": {
    "EMBEDDING_API_KEY": "your-key",
    "EMBEDDING_URL": "http://localhost:11434/v1/embeddings",
    "EMBEDDING_MODEL": "nomic-embed-text"
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

「認証に関連する記憶を広く探して」
→ semantic_search でベクトル類似検索
```

## ツール一覧

| ツール | 説明 |
|--------|------|
| `save_note` | メモを保存（key 指定で上書き可） |
| `save_conversation` | 会話全文を保存 |
| `search_memory` | 全文検索（日本語対応 + ヘブ則リンク表示） |
| `semantic_search` | ベクトル類似検索（APIキー設定時のみ） |
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
- オプション: OpenAI APIキー（セマンティック検索用）

## ライセンス

MIT

## 作者

Tomoyuki Seki（[@yutoribengoshi](https://github.com/yutoribengoshi)）
