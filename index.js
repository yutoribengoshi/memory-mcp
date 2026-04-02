#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { homedir } from "os";
import { join, basename } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { request } from "node:http";

// ─── データディレクトリ & 暗号鍵 ───────────────────────────────────
const DATA_DIR = join(homedir(), ".memory-mcp");
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, "memory.db");
const KEY_PATH = join(DATA_DIR, ".key");

// ─── ベクトル検索設定（オプション） ─────────────────────────────────
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? null;
const EMBEDDING_URL = process.env.EMBEDDING_URL ?? "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "text-embedding-3-small";
const VECTOR_ENABLED = !!EMBEDDING_API_KEY;

function loadOrCreateKey() {
  if (existsSync(KEY_PATH)) {
    return readFileSync(KEY_PATH);
  }
  const key = randomBytes(32);
  writeFileSync(KEY_PATH, key, { mode: 0o600 });
  chmodSync(KEY_PATH, 0o600);
  return key;
}
const ENC_KEY = loadOrCreateKey();

// ─── AES-256-GCM 暗号化/復号 ───────────────────────────────────
function encrypt(text) {
  if (text == null) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv(12) + tag(16) + ciphertext → base64
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(b64) {
  if (b64 == null) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc, undefined, "utf8") + decipher.final("utf8");
  } catch {
    // 未暗号化データ（マイグレーション前）はそのまま返す
    return b64;
  }
}

function isEncrypted(text) {
  if (text == null) return true; // nullはスキップ
  try {
    const buf = Buffer.from(text, "base64");
    // iv(12) + tag(16) + 最低1byte = 29以上、かつbase64としてデコード→再エンコードが一致
    return buf.length >= 29 && buf.toString("base64") === text;
  } catch {
    return false;
  }
}

// ─── DB初期化 ───────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA busy_timeout = 30000`);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, summary TEXT, content TEXT NOT NULL,
    tags TEXT DEFAULT '[]', source TEXT DEFAULT 'claude',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE,
    content TEXT NOT NULL, tags TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ─── FTSテーブル（平文でインデックス、trigram対応） ──────────────
// FTSはexternal content不使用（暗号化との互換のため独立管理）
// trigram: 日本語カタカナ・ひらがな等の部分一致検索に対応
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts
    USING fts5(title, summary, content, tags, tokenize='trigram');
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
    USING fts5(key, content, tags, tokenize='trigram');
`);

// ─── 案件テーブル（feature 4） ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS cases (
    case_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// conversations, notes に case_id カラム追加（マイグレーション）
try { db.exec(`ALTER TABLE conversations ADD COLUMN case_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN case_id TEXT`); } catch {}

// ─── ベクトルテーブル（オプション） ─────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS vectors (
    type TEXT NOT NULL,
    id INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (type, id)
  );
`);

// ─── ヘブ則テーブル（feature 5） ────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS memory_links (
    source_type TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    weight REAL DEFAULT 0.1,
    co_access_count INTEGER DEFAULT 1,
    last_accessed TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (source_type, source_id, target_type, target_id)
  );
`);

// ─── FTSトリガー再作成（暗号化対応のためexternal content廃止） ──
// 既存のexternal content FTSトリガーを削除（エラー無視）
for (const t of ["conv_ai","conv_au","conv_ad","note_ai","note_au","note_ad"]) {
  try { db.exec(`DROP TRIGGER IF EXISTS ${t}`); } catch {}
}

// ─── 既存データ暗号化マイグレーション ────────────────────────────
function migrateEncryption() {
  const convRows = db.prepare(`SELECT id, title, summary, content FROM conversations`).all();
  for (const row of convRows) {
    if (!isEncrypted(row.title)) {
      db.prepare(`UPDATE conversations SET title=?, summary=?, content=? WHERE id=?`)
        .run(encrypt(row.title), encrypt(row.summary), encrypt(row.content), row.id);
    }
  }
  const noteRows = db.prepare(`SELECT id, content FROM notes`).all();
  for (const row of noteRows) {
    if (!isEncrypted(row.content)) {
      db.prepare(`UPDATE notes SET content=? WHERE id=?`)
        .run(encrypt(row.content), row.id);
    }
  }
}
migrateEncryption();

// ─── FTSリビルド（起動時） ──────────────────────────────────────
function rebuildFts() {
  db.exec(`DELETE FROM conversations_fts`);
  const convs = db.prepare(`SELECT id, title, summary, content, tags FROM conversations`).all();
  const insertConvFts = db.prepare(`INSERT INTO conversations_fts(rowid, title, summary, content, tags) VALUES(?,?,?,?,?)`);
  for (const r of convs) {
    insertConvFts.run(r.id, decrypt(r.title), decrypt(r.summary) ?? "", decrypt(r.content), r.tags ?? "[]");
  }
  db.exec(`DELETE FROM notes_fts`);
  const notes = db.prepare(`SELECT id, key, content, tags FROM notes`).all();
  const insertNoteFts = db.prepare(`INSERT INTO notes_fts(rowid, key, content, tags) VALUES(?,?,?,?)`);
  for (const n of notes) {
    insertNoteFts.run(n.id, n.key ?? "", decrypt(n.content), n.tags ?? "[]");
  }
}
rebuildFts();

// ─── ヘブ則: 起動時減衰処理 ─────────────────────────────────────
db.exec(`
  UPDATE memory_links
  SET weight = weight * 0.95
  WHERE last_accessed < datetime('now', 'localtime', '-30 days')
`);
// 極小weightを削除
db.exec(`DELETE FROM memory_links WHERE weight < 0.01`);

// ─── プロジェクト自動タグ（feature 3） ──────────────────────────
function autoProjectTag(tags) {
  const cwd = process.cwd();
  const devBase = join(homedir(), "dev");
  if (cwd.startsWith(devBase + "/")) {
    const rel = cwd.slice(devBase.length + 1);
    const project = rel.split("/")[0];
    if (project && !tags.includes(project)) {
      tags.push(project);
    }
  }
  return tags;
}

// ─── ヘブ則: 検索履歴トラッカー ─────────────────────────────────
let lastSearchResults = [];
let lastSearchTime = 0;

function recordSearchResults(results) {
  const now = Date.now();
  const prev = lastSearchResults;
  const prevTime = lastSearchTime;
  lastSearchResults = results;
  lastSearchTime = now;

  // 5分以内の連続検索 → リンク強化
  if (prev.length > 0 && (now - prevTime) < 5 * 60 * 1000) {
    strengthenLinks(prev, results);
  }
}

function strengthenLinks(prevResults, currResults) {
  const upsert = db.prepare(`
    INSERT INTO memory_links (source_type, source_id, target_type, target_id, weight, co_access_count, last_accessed)
    VALUES (?, ?, ?, ?, 0.1, 1, datetime('now','localtime'))
    ON CONFLICT(source_type, source_id, target_type, target_id) DO UPDATE SET
      weight = weight + 0.05 * (1.0 - weight),
      co_access_count = co_access_count + 1,
      last_accessed = datetime('now','localtime')
  `);
  for (const s of prevResults) {
    for (const t of currResults) {
      if (s.type === t.type && s.id === t.id) continue;
      upsert.run(s.type, s.id, t.type, t.id);
      upsert.run(t.type, t.id, s.type, s.id); // 双方向
    }
  }
}

// 同一case_idメモのリンク初期化
function initCaseLinks(type, id, caseId) {
  if (!caseId) return;
  const noteRows = db.prepare(`SELECT id FROM notes WHERE case_id=? AND id!=?`).all(caseId, type === "note" ? id : -1);
  const convRows = db.prepare(`SELECT id FROM conversations WHERE case_id=? AND id!=?`).all(caseId, type === "conversation" ? id : -1);
  const upsert = db.prepare(`
    INSERT INTO memory_links (source_type, source_id, target_type, target_id, weight, co_access_count, last_accessed)
    VALUES (?, ?, ?, ?, 0.3, 0, datetime('now','localtime'))
    ON CONFLICT(source_type, source_id, target_type, target_id) DO UPDATE SET
      weight = MAX(weight, 0.3)
  `);
  for (const n of noteRows) {
    upsert.run(type, id, "note", n.id);
    upsert.run("note", n.id, type, id);
  }
  for (const c of convRows) {
    upsert.run(type, id, "conversation", c.id);
    upsert.run("conversation", c.id, type, id);
  }
}

// 関連メモ取得（weight上位3件）
function getRelatedMemories(results) {
  if (results.length === 0) return "";
  const seen = new Set(results.map(r => `${r.type}:${r.id}`));
  const related = [];
  const stmt = db.prepare(`
    SELECT target_type, target_id, weight FROM memory_links
    WHERE source_type=? AND source_id=?
    ORDER BY weight DESC LIMIT 5
  `);
  for (const r of results) {
    const links = stmt.all(r.type, r.id);
    for (const l of links) {
      const k = `${l.target_type}:${l.target_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      related.push({ type: l.target_type, id: l.target_id, weight: l.weight });
    }
  }
  related.sort((a, b) => b.weight - a.weight);
  const top = related.slice(0, 3);
  if (top.length === 0) return "";

  const lines = top.map(r => {
    let label = "";
    if (r.type === "note") {
      const n = db.prepare(`SELECT key, content FROM notes WHERE id=?`).get(r.id);
      if (!n) return null;
      label = `[メモ] id:${r.id} "${n.key ?? "(無題)"}" (w:${r.weight.toFixed(2)})`;
    } else {
      const c = db.prepare(`SELECT title FROM conversations WHERE id=?`).get(r.id);
      if (!c) return null;
      label = `[会話] id:${r.id} "${decrypt(c.title)}" (w:${r.weight.toFixed(2)})`;
    }
    return label;
  }).filter(Boolean);

  if (lines.length === 0) return "";
  return `\n\n🔗 関連メモ（ヘブ則）:\n${lines.join("\n")}`;
}

// ─── ベクトル検索ヘルパー ───────────────────────────────────────
async function getEmbedding(text) {
  if (!VECTOR_ENABLED) return null;
  try {
    const res = await fetch(EMBEDDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.[0]?.embedding ?? null;
  } catch { return null; }
}

function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function blobToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function upsertVector(type, id, text) {
  if (!VECTOR_ENABLED) return;
  const vec = await getEmbedding(text);
  if (!vec) return;
  db.prepare(`INSERT INTO vectors(type, id, embedding, model) VALUES(?,?,?,?)
    ON CONFLICT(type, id) DO UPDATE SET embedding=excluded.embedding, model=excluded.model,
    created_at=datetime('now','localtime')`)
    .run(type, id, vecToBlob(vec), EMBEDDING_MODEL);
}

// ─── ブロードキャスト（feature 2） ──────────────────────────────
// claude-peers broker (localhost:7899) の /list-peers → /send-message で全peerに配信
const PEERS_TOKEN_PATH = join(homedir(), ".claude-peers.token");
function loadPeersToken() {
  try { return readFileSync(PEERS_TOKEN_PATH, "utf-8").trim(); } catch { return null; }
}

function brokerPost(path, body) {
  return new Promise(resolve => {
    const token = loadPeersToken();
    const data = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const req = request({
      hostname: "127.0.0.1", port: 7899, path,
      method: "POST",
      headers,
      timeout: 3000,
    }, res => {
      let buf = "";
      res.on("data", d => buf += d);
      res.on("end", () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

async function broadcastTopeers(content, tags) {
  // 1. 全peerを取得
  const peers = await brokerPost("/list-peers", { scope: "machine" });
  if (!peers || !Array.isArray(peers) || peers.length === 0) return { sent: false, count: 0 };

  // 2. 各peerにメッセージ送信（from_idは"memory-mcp"固定）
  const text = `[memory-mcp broadcast] ${tags?.length ? `[${tags.join(",")}] ` : ""}${content}`;
  let sent = 0;
  for (const peer of peers) {
    const r = await brokerPost("/send-message", { from_id: "memory-mcp", to_id: peer.id, text });
    if (r?.ok) sent++;
  }
  return { sent: true, count: sent };
}

// ─── FTS同期ヘルパー ────────────────────────────────────────────
function syncConvFts(id, title, summary, content, tags) {
  try { db.prepare(`DELETE FROM conversations_fts WHERE rowid=?`).run(id); } catch {}
  db.prepare(`INSERT INTO conversations_fts(rowid, title, summary, content, tags) VALUES(?,?,?,?,?)`)
    .run(id, title, summary ?? "", content, tags);
}
function syncNoteFts(id, key, content, tags) {
  try { db.prepare(`DELETE FROM notes_fts WHERE rowid=?`).run(id); } catch {}
  db.prepare(`INSERT INTO notes_fts(rowid, key, content, tags) VALUES(?,?,?,?)`)
    .run(id, key ?? "", content, tags);
}

// ═══════════════════════════════════════════════════════════════
// MCPサーバー
// ═══════════════════════════════════════════════════════════════
const server = new McpServer({ name: "memory-mcp", version: "2.0.0" });

// ─── save_conversation ──────────────────────────────────────────
server.tool("save_conversation",
  "現在のチャット会話をSQLiteに保存。「このチャットを保存して」で使う。",
  {
    title:   z.string().describe("タイトル"),
    content: z.string().describe("会話の全文"),
    summary: z.string().optional().describe("1〜3行の要約"),
    tags:    z.array(z.string()).optional().describe("タグ配列"),
    source:  z.string().optional().describe("出典(デフォルト: claude)"),
    case_id: z.string().optional().describe("案件ID"),
  },
  async ({ title, content, summary, tags, source, case_id }) => {
    const t = autoProjectTag(tags ?? []);
    const tagsJson = JSON.stringify(t);
    const r = db.prepare(
      `INSERT INTO conversations (title,summary,content,tags,source,case_id) VALUES(?,?,?,?,?,?)`
    ).run(encrypt(title), encrypt(summary ?? null), encrypt(content), tagsJson, source ?? "claude", case_id ?? null);
    const id = Number(r.lastInsertRowid);
    syncConvFts(id, title, summary, content, tagsJson);
    if (case_id) initCaseLinks("conversation", id, case_id);
    await upsertVector("conversation", id, `${title} ${summary ?? ""} ${content}`.slice(0, 8000));
    return { content: [{ type: "text", text: `✅ 保存完了 id:${id} "${title}"${case_id ? ` case:${case_id}` : ""}` }] };
  }
);

// ─── save_note ──────────────────────────────────────────────────
server.tool("save_note",
  "短いメモ・決定事項を保存。keyを指定すると上書き更新。",
  {
    content: z.string().describe("テキスト"),
    key:     z.string().optional().describe("キー名(上書き用)"),
    tags:    z.array(z.string()).optional(),
    case_id: z.string().optional().describe("案件ID"),
  },
  async ({ content, key, tags, case_id }) => {
    const t = autoProjectTag(tags ?? []);
    const tagsJson = JSON.stringify(t);
    let id;
    if (key) {
      db.prepare(`INSERT INTO notes(key,content,tags,case_id) VALUES(?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET content=excluded.content,tags=excluded.tags,
        case_id=COALESCE(excluded.case_id,case_id),
        updated_at=datetime('now','localtime')`).run(key, encrypt(content), tagsJson, case_id ?? null);
      id = db.prepare("SELECT id FROM notes WHERE key=?").get(key)?.id;
    } else {
      id = Number(db.prepare(`INSERT INTO notes(content,tags,case_id) VALUES(?,?,?)`)
        .run(encrypt(content), tagsJson, case_id ?? null).lastInsertRowid);
    }
    syncNoteFts(id, key, content, tagsJson);
    if (case_id) initCaseLinks("note", id, case_id);
    await upsertVector("note", id, `${key ?? ""} ${content}`.slice(0, 8000));
    return { content: [{ type: "text", text: `✅ メモ保存 id:${id}${key ? ` key:${key}` : ""}${case_id ? ` case:${case_id}` : ""}` }] };
  }
);

// ─── broadcast_note（feature 2） ────────────────────────────────
server.tool("broadcast_note",
  "メモを保存し、他のClaude Codeセッション(localhost:7899)にブロードキャスト。peersが未起動でもメモ保存は成功する。",
  {
    content: z.string().describe("ブロードキャストする内容"),
    tags:    z.array(z.string()).optional(),
  },
  async ({ content, tags }) => {
    const t = autoProjectTag(tags ?? []);
    const tagsJson = JSON.stringify(t);
    const id = Number(db.prepare(`INSERT INTO notes(content,tags) VALUES(?,?)`)
      .run(encrypt(content), tagsJson).lastInsertRowid);
    syncNoteFts(id, null, content, tagsJson);

    const result = await broadcastTopeers(content, t);
    const status = result.sent ? `📡 ${result.count}件のpeerに通知済み` : "⚠️ peers未起動（メモのみ保存）";
    return { content: [{ type: "text", text: `✅ メモ保存 id:${id} ${status}` }] };
  }
);

// ─── search_memory（ヘブ則対応） ────────────────────────────────
server.tool("search_memory",
  "保存済みチャット・メモを全文検索(日本語対応)。ヘブ則で関連メモも表示。",
  {
    query:   z.string().describe("キーワード(スペース区切りでAND)"),
    case_id: z.string().optional().describe("案件IDで絞り込み"),
  },
  ({ query, case_id }) => {
    const words = query.trim().split(/\s+/);
    const hasShortWord = words.some(w => [...w].length < 3);
    let rows;

    if (hasShortWord) {
      // trigram FTS5は3文字未満を検索できないためLIKEフォールバック
      const likeClauses = words.map(() => "content LIKE ?").join(" AND ");
      const likeParams = words.map(w => `%${w}%`);
      const caseFilter = case_id ? " AND c.case_id=?" : "";
      const caseParams = case_id ? [case_id] : [];
      rows = db.prepare(`
        SELECT 'conversation' as type, c.id, c.title as key_enc,
          '' as snip, c.created_at, c.case_id
        FROM conversations_fts f
        JOIN conversations c ON f.rowid=c.id
        WHERE ${likeClauses.replace(/content/g, "f.content")}${caseFilter}
        UNION ALL
        SELECT 'note', n.id, n.key as key_enc,
          '' as snip, n.created_at, n.case_id
        FROM notes_fts f
        JOIN notes n ON f.rowid=n.id
        WHERE ${likeClauses.replace(/content/g, "f.content")}${caseFilter}
        ORDER BY created_at DESC LIMIT 20
      `).all(...likeParams, ...caseParams, ...likeParams, ...caseParams);
    } else {
      const q = words.join(" AND ");
      if (case_id) {
        rows = db.prepare(`
          SELECT 'conversation' as type, c.id, c.title as key_enc,
            snippet(conversations_fts,2,'【','】','…',20) as snip, c.created_at, c.case_id
          FROM conversations_fts f
          JOIN conversations c ON f.rowid=c.id
          WHERE f MATCH ? AND c.case_id=?
          UNION ALL
          SELECT 'note', n.id, n.key,
            snippet(notes_fts,1,'【','】','…',20), n.created_at, n.case_id
          FROM notes_fts f
          JOIN notes n ON f.rowid=n.id
          WHERE f MATCH ? AND n.case_id=?
          ORDER BY created_at DESC LIMIT 20
        `).all(q, case_id, q, case_id);
      } else {
        rows = db.prepare(`
          SELECT 'conversation' as type, c.id, c.title as key_enc,
            snippet(conversations_fts,2,'【','】','…',20) as snip, c.created_at, c.case_id
          FROM conversations_fts f
          JOIN conversations c ON f.rowid=c.id
          WHERE f MATCH ?
          UNION ALL
          SELECT 'note', n.id, n.key as key_enc,
            snippet(notes_fts,1,'【','】','…',20), n.created_at, n.case_id
          FROM notes_fts f
          JOIN notes n ON f.rowid=n.id
          WHERE f MATCH ?
          ORDER BY created_at DESC LIMIT 20
        `).all(q, q);
      }
    }
    if (!rows.length) return { content: [{ type: "text", text: `「${query}」に一致するデータはありません。` }] };

    // ヘブ則: 検索結果を記録
    const searchResults = rows.map(r => ({ type: r.type, id: r.id }));
    recordSearchResults(searchResults);

    const text = rows.map(r => {
      const label = r.type === "conversation"
        ? decrypt(r.key_enc) ?? "(不明)"
        : r.key_enc ?? "(無題)";
      const caseTag = r.case_id ? ` [案件:${r.case_id}]` : "";
      return `[${r.type === "conversation" ? "会話" : "メモ"}] id:${r.id} "${label}"${caseTag}\n  ${r.snip}\n  ${r.created_at}`;
    }).join("\n\n");

    const related = getRelatedMemories(searchResults);
    return { content: [{ type: "text", text: `🔍 ${rows.length}件\n\n${text}${related}` }] };
  }
);

// ─── list_conversations ─────────────────────────────────────────
server.tool("list_conversations",
  "保存済み会話の一覧(新しい順)",
  { limit: z.number().int().min(1).max(50).optional().default(20) },
  ({ limit }) => {
    const rows = db.prepare(`SELECT id,title,summary,tags,created_at,case_id FROM conversations ORDER BY created_at DESC LIMIT ?`).all(limit);
    if (!rows.length) return { content: [{ type: "text", text: "保存済みの会話はありません。" }] };
    return {
      content: [{
        type: "text",
        text: rows.map(r => {
          const caseTag = r.case_id ? ` [案件:${r.case_id}]` : "";
          return `id:${r.id} [${r.created_at}] ${decrypt(r.title)}${caseTag}\n  ${decrypt(r.summary) ?? "(要約なし)"}`;
        }).join("\n"),
      }],
    };
  }
);

// ─── get_conversation ───────────────────────────────────────────
server.tool("get_conversation",
  "指定IDの会話全文を取得",
  { id: z.number().int() },
  ({ id }) => {
    const row = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(id);
    if (!row) return { content: [{ type: "text", text: `id:${id} は存在しません。` }] };
    const caseTag = row.case_id ? `\n案件: ${row.case_id}` : "";
    return {
      content: [{
        type: "text",
        text: `# ${decrypt(row.title)}\n[${row.created_at}] tags:${row.tags}${caseTag}\n\n## 要約\n${decrypt(row.summary) ?? "(なし)"}\n\n## 全文\n${decrypt(row.content)}`,
      }],
    };
  }
);

// ─── delete_conversation ────────────────────────────────────────
server.tool("delete_conversation",
  "指定IDの会話を削除",
  { id: z.number().int() },
  ({ id }) => {
    try { db.prepare(`DELETE FROM conversations_fts WHERE rowid=?`).run(id); } catch {}
    db.prepare(`DELETE FROM memory_links WHERE (source_type='conversation' AND source_id=?) OR (target_type='conversation' AND target_id=?)`).run(id, id);
    const info = db.prepare(`DELETE FROM conversations WHERE id=?`).run(id);
    return { content: [{ type: "text", text: info.changes > 0 ? `🗑 id:${id} 削除しました。` : `id:${id} は存在しません。` }] };
  }
);

// ─── 案件管理ツール（feature 4） ────────────────────────────────
server.tool("save_case_note",
  "案件に紐づけてメモを保存。案件が未登録なら自動作成。",
  {
    case_id: z.string().describe("案件ID(例: shiraishi-2026)"),
    case_name: z.string().optional().describe("案件名(新規登録時)"),
    content: z.string().describe("メモ内容"),
    key:     z.string().optional().describe("キー名(上書き用)"),
    tags:    z.array(z.string()).optional(),
  },
  async ({ case_id, case_name, content, key, tags }) => {
    // 案件自動登録
    const existing = db.prepare(`SELECT case_id FROM cases WHERE case_id=?`).get(case_id);
    if (!existing) {
      db.prepare(`INSERT INTO cases(case_id, name) VALUES(?,?)`)
        .run(case_id, case_name ?? case_id);
    }
    const t = autoProjectTag(tags ?? []);
    const tagsJson = JSON.stringify(t);
    let id;
    if (key) {
      db.prepare(`INSERT INTO notes(key,content,tags,case_id) VALUES(?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET content=excluded.content,tags=excluded.tags,
        case_id=excluded.case_id,updated_at=datetime('now','localtime')`)
        .run(key, encrypt(content), tagsJson, case_id);
      id = db.prepare("SELECT id FROM notes WHERE key=?").get(key)?.id;
    } else {
      id = Number(db.prepare(`INSERT INTO notes(content,tags,case_id) VALUES(?,?,?)`)
        .run(encrypt(content), tagsJson, case_id).lastInsertRowid);
    }
    syncNoteFts(id, key, content, tagsJson);
    initCaseLinks("note", id, case_id);
    await upsertVector("note", id, `${key ?? ""} ${content}`.slice(0, 8000));
    return { content: [{ type: "text", text: `✅ 案件メモ保存 id:${id} case:${case_id}${key ? ` key:${key}` : ""}` }] };
  }
);

server.tool("list_cases",
  "登録済み案件の一覧。status='active'のみ or 全件。",
  { include_archived: z.boolean().optional().default(false).describe("アーカイブ済みも含める") },
  ({ include_archived }) => {
    const q = include_archived
      ? `SELECT * FROM cases ORDER BY updated_at DESC`
      : `SELECT * FROM cases WHERE status='active' ORDER BY updated_at DESC`;
    const rows = db.prepare(q).all();
    if (!rows.length) return { content: [{ type: "text", text: "登録済みの案件はありません。" }] };
    const text = rows.map(r => {
      const noteCount = db.prepare(`SELECT COUNT(*) as c FROM notes WHERE case_id=?`).get(r.case_id).c;
      const convCount = db.prepare(`SELECT COUNT(*) as c FROM conversations WHERE case_id=?`).get(r.case_id).c;
      return `[${r.status}] ${r.case_id}: ${r.name} (メモ:${noteCount} 会話:${convCount}) ${r.updated_at}`;
    }).join("\n");
    return { content: [{ type: "text", text: `📁 案件一覧 (${rows.length}件)\n\n${text}` }] };
  }
);

server.tool("get_case",
  "指定案件の詳細とメモ・会話一覧を取得",
  { case_id: z.string().describe("案件ID") },
  ({ case_id }) => {
    const c = db.prepare(`SELECT * FROM cases WHERE case_id=?`).get(case_id);
    if (!c) return { content: [{ type: "text", text: `案件 "${case_id}" は存在しません。` }] };
    const notes = db.prepare(`SELECT id, key, content, tags, created_at FROM notes WHERE case_id=? ORDER BY created_at DESC`).all(case_id);
    const convs = db.prepare(`SELECT id, title, summary, created_at FROM conversations WHERE case_id=? ORDER BY created_at DESC`).all(case_id);
    let text = `📁 案件: ${c.name} (${c.case_id})\nステータス: ${c.status}\n作成: ${c.created_at}\n\n`;
    if (convs.length) {
      text += `## 会話 (${convs.length}件)\n`;
      text += convs.map(r => `  id:${r.id} ${decrypt(r.title)} [${r.created_at}]`).join("\n");
      text += "\n\n";
    }
    if (notes.length) {
      text += `## メモ (${notes.length}件)\n`;
      text += notes.map(r => `  id:${r.id} ${r.key ?? "(無題)"}: ${decrypt(r.content)?.slice(0, 80)}… [${r.created_at}]`).join("\n");
    }
    return { content: [{ type: "text", text }] };
  }
);

server.tool("archive_case",
  "案件をアーカイブ(status='archived')。削除はしない(弁護士の記録保持義務)。",
  { case_id: z.string().describe("案件ID") },
  ({ case_id }) => {
    const info = db.prepare(`UPDATE cases SET status='archived', updated_at=datetime('now','localtime') WHERE case_id=?`).run(case_id);
    if (info.changes === 0) return { content: [{ type: "text", text: `案件 "${case_id}" は存在しません。` }] };
    return { content: [{ type: "text", text: `📦 案件 "${case_id}" をアーカイブしました。` }] };
  }
);

// ─── semantic_search（ベクトル検索） ────────────────────────────
server.tool("semantic_search",
  "意味的類似検索。キーワードが思い出せない時や、関連する記憶を広く探したい時に使う。EMBEDDING_API_KEY設定時のみ有効。",
  {
    query: z.string().describe("検索クエリ（自然文OK）"),
    limit: z.number().int().min(1).max(20).optional().default(5).describe("最大件数"),
    case_id: z.string().optional().describe("案件IDで絞り込み"),
  },
  async ({ query, limit, case_id }) => {
    if (!VECTOR_ENABLED) {
      return { content: [{ type: "text", text: "⚠️ ベクトル検索は無効です。EMBEDDING_API_KEY または OPENAI_API_KEY を設定してください。" }] };
    }
    const queryVec = await getEmbedding(query);
    if (!queryVec) {
      return { content: [{ type: "text", text: "⚠️ Embeddingの取得に失敗しました。" }] };
    }

    const allVecs = db.prepare(`SELECT type, id, embedding FROM vectors`).all();
    if (!allVecs.length) {
      return { content: [{ type: "text", text: "ベクトルデータがありません。メモを保存するとベクトルが自動生成されます。" }] };
    }

    // コサイン類似度で全件スコアリング
    const scored = allVecs.map(row => {
      const vec = blobToVec(row.embedding);
      const sim = cosineSimilarity(queryVec, vec);
      return { type: row.type, id: row.id, similarity: sim };
    });
    scored.sort((a, b) => b.similarity - a.similarity);

    // case_idフィルタ適用 & 上位取得
    const results = [];
    for (const s of scored) {
      if (results.length >= limit) break;
      if (case_id) {
        const table = s.type === "note" ? "notes" : "conversations";
        const row = db.prepare(`SELECT case_id FROM ${table} WHERE id=?`).get(s.id);
        if (row?.case_id !== case_id) continue;
      }
      results.push(s);
    }

    if (!results.length) {
      return { content: [{ type: "text", text: `「${query}」に類似するデータはありません。` }] };
    }

    // ヘブ則: 検索結果を記録
    recordSearchResults(results.map(r => ({ type: r.type, id: r.id })));

    const lines = results.map(r => {
      let label = "";
      if (r.type === "note") {
        const n = db.prepare(`SELECT key, content FROM notes WHERE id=?`).get(r.id);
        if (!n) return null;
        const keyName = n.key ?? "(無題)";
        label = "[メモ] id:" + r.id + ' "' + keyName + '"';
        const content = decrypt(n.content);
        const sim = (r.similarity * 100).toFixed(1);
        return label + " (類似度:" + sim + "%)\n  " + (content?.slice(0, 100) ?? "") + "…";
      } else {
        const c = db.prepare(`SELECT title, summary FROM conversations WHERE id=?`).get(r.id);
        if (!c) return null;
        const titleStr = decrypt(c.title) ?? "(不明)";
        label = "[会話] id:" + r.id + ' "' + titleStr + '"';
        const sim = (r.similarity * 100).toFixed(1);
        const summaryStr = decrypt(c.summary) ?? "(要約なし)";
        return label + " (類似度:" + sim + "%)\n  " + summaryStr;
      }
    }).filter(Boolean);

    const related = getRelatedMemories(results.map(r => ({ type: r.type, id: r.id })));
    return { content: [{ type: "text", text: `🔍 セマンティック検索: ${lines.length}件\n\n${lines.join("\n\n")}${related}` }] };
  }
);

// ─── ヘブ則ツール（feature 5） ──────────────────────────────────
server.tool("get_memory_links",
  "指定メモ/会話のヘブ則リンク(関連記憶)を取得",
  {
    type: z.enum(["note", "conversation"]).describe("種別"),
    id:   z.number().int().describe("ID"),
  },
  ({ type, id }) => {
    const links = db.prepare(`
      SELECT target_type, target_id, weight, co_access_count, last_accessed
      FROM memory_links
      WHERE source_type=? AND source_id=?
      ORDER BY weight DESC LIMIT 20
    `).all(type, id);
    if (!links.length) return { content: [{ type: "text", text: `id:${id} (${type}) にリンクはありません。` }] };
    const text = links.map(l => {
      let label = "";
      if (l.target_type === "note") {
        const n = db.prepare(`SELECT key FROM notes WHERE id=?`).get(l.target_id);
        label = n?.key ?? "(無題)";
      } else {
        const c = db.prepare(`SELECT title FROM conversations WHERE id=?`).get(l.target_id);
        label = c ? decrypt(c.title) : "(不明)";
      }
      return `  → [${l.target_type}] id:${l.target_id} "${label}" w:${l.weight.toFixed(3)} (共起:${l.co_access_count}) ${l.last_accessed}`;
    }).join("\n");
    return { content: [{ type: "text", text: `🧠 ヘブ則リンク (${type} id:${id})\n\n${text}` }] };
  }
);

server.tool("memory_stats",
  "メモリMCPの統計情報(総数・リンク数・案件数等)",
  {},
  () => {
    const noteCount = db.prepare(`SELECT COUNT(*) as c FROM notes`).get().c;
    const convCount = db.prepare(`SELECT COUNT(*) as c FROM conversations`).get().c;
    const linkCount = db.prepare(`SELECT COUNT(*) as c FROM memory_links`).get().c;
    const caseCount = db.prepare(`SELECT COUNT(*) as c FROM cases WHERE status='active'`).get().c;
    const avgWeight = db.prepare(`SELECT AVG(weight) as a FROM memory_links`).get().a ?? 0;
    const strongLinks = db.prepare(`SELECT COUNT(*) as c FROM memory_links WHERE weight > 0.5`).get().c;
    const vecCount = db.prepare(`SELECT COUNT(*) as c FROM vectors`).get().c;
    return {
      content: [{
        type: "text",
        text: [
          `📊 Memory MCP Stats`,
          `  メモ: ${noteCount}件`,
          `  会話: ${convCount}件`,
          `  案件: ${caseCount}件 (active)`,
          `  ヘブ則リンク: ${linkCount}件 (avg_w: ${avgWeight.toFixed(3)}, strong>0.5: ${strongLinks}件)`,
          `  ベクトル: ${vecCount}件 ${VECTOR_ENABLED ? `✅ (${EMBEDDING_MODEL})` : "⚠️ 無効 (EMBEDDING_API_KEY未設定)"}`,
          `  DB: ${DB_PATH}`,
          `  暗号化: AES-256-GCM ✅`,
        ].join("\n"),
      }],
    };
  }
);

// ─── 起動 ───────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
