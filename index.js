#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { homedir } from "os";
import { join, basename } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { request } from "node:http";

// ─── データディレクトリ & 暗号鍵 ───────────────────────────────────
// MEMORY_MCP_DIR: テスト・別DB運用用の上書き（未設定なら ~/.memory-mcp）
const DATA_DIR = process.env.MEMORY_MCP_DIR ?? join(homedir(), ".memory-mcp");
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = join(DATA_DIR, "memory.db");
const KEY_PATH = join(DATA_DIR, ".key");
const CONFIG_PATH = join(DATA_DIR, "config.json");

// ─── ベクトル検索設定 ───────────────────────────────────────────
// 解決順: env > ~/.memory-mcp/config.json > ローカルollama既定。
// ホスト（Claude Desktop等）がenvを渡さず起動しても埋め込みが有効になる。
// ollama不在でも getEmbedding が即null → 保存・検索は劣化なしで続行。
let fileConfig = {};
try { fileConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch {}
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY
  ?? fileConfig.embedding_api_key ?? "ollama";
const EMBEDDING_URL = process.env.EMBEDDING_URL ?? fileConfig.embedding_url
  ?? "http://localhost:11434/v1/embeddings";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? fileConfig.embedding_model
  ?? "nomic-embed-text";
const VECTOR_ENABLED = !!EMBEDDING_API_KEY;
// エンドポイント可用性: unknown | ok | down。down後はクールダウンを置いて再試行。
let embeddingHealth = "unknown";
let embeddingDownSince = 0;
const EMBEDDING_RETRY_MS = 5 * 60 * 1000;

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
  if (text == null) return false; // M2 fix: null は暗号化されていないのでfalse
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

// FTSは平文格納のためDBファイル自体を所有者のみ読書き可に絞る
for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
  try { chmodSync(p, 0o600); } catch {}
}

// ─── metaテーブル（起動時処理のゲーティング・プロセス跨ぎ状態） ───
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
const metaGet = (k) => db.prepare(`SELECT value FROM meta WHERE key=?`).get(k)?.value;
const metaSet = (k, v) => db.prepare(
  `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
).run(k, String(v));

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
// cases に統合先カラム追加（merge_cases のリダイレクト用）
try { db.exec(`ALTER TABLE cases ADD COLUMN merged_into TEXT`); } catch {}

// ─── Zepインスパイア: 時間軸 + エージェント別記憶（マイグレーション） ──
try { db.exec(`ALTER TABLE notes ADD COLUMN valid_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN invalid_at TEXT`); } catch {}
try { db.exec(`ALTER TABLE notes ADD COLUMN agent_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT`); } catch {}

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
// 全行スキャンは初回のみ（以降の書き込みは常に暗号化されるため再走査不要）
if (metaGet("enc_migrated") !== "1") {
  migrateEncryption();
  metaSet("enc_migrated", "1");
}

// ─── FTSリビルド（必要時のみ） ──────────────────────────────────
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
// 毎起動の全リビルドをやめ、行数不整合かスキーマ版更新時のみ実施
// （書き込みは都度syncNoteFts/syncConvFtsで同期されるため通常は一致する）
const FTS_SCHEMA_V = "v31-trigram";
{
  const nCnt = db.prepare(`SELECT COUNT(*) c FROM notes`).get().c;
  const nFts = db.prepare(`SELECT COUNT(*) c FROM notes_fts`).get().c;
  const cCnt = db.prepare(`SELECT COUNT(*) c FROM conversations`).get().c;
  const cFts = db.prepare(`SELECT COUNT(*) c FROM conversations_fts`).get().c;
  if (nCnt !== nFts || cCnt !== cFts || metaGet("fts_schema_v") !== FTS_SCHEMA_V) {
    rebuildFts();
    metaSet("fts_schema_v", FTS_SCHEMA_V);
  }
}

// ─── ヘブ則: 減衰処理（1日1回まで） ─────────────────────────────
// 旧実装はサーバ起動のたびに減衰しており、セッション多起動環境では
// リンクが育つ前に消滅していた（strong>0.5が常に0件の原因）。
{
  const today = new Date().toISOString().slice(0, 10);
  if (metaGet("last_decay") !== today) {
    db.exec(`
      UPDATE memory_links
      SET weight = weight * 0.95
      WHERE last_accessed < datetime('now', 'localtime', '-30 days')
    `);
    db.exec(`DELETE FROM memory_links WHERE weight < 0.01`);
    // 削除済み行を指すベクトル・リンクの孤児掃除も日次でまとめて実施
    db.exec(`DELETE FROM vectors WHERE (type='note' AND id NOT IN (SELECT id FROM notes))
      OR (type='conversation' AND id NOT IN (SELECT id FROM conversations))`);
    db.exec(`DELETE FROM memory_links WHERE
      (source_type='note' AND source_id NOT IN (SELECT id FROM notes))
      OR (source_type='conversation' AND source_id NOT IN (SELECT id FROM conversations))
      OR (target_type='note' AND target_id NOT IN (SELECT id FROM notes))
      OR (target_type='conversation' AND target_id NOT IN (SELECT id FROM conversations))`);
    metaSet("last_decay", today);
  }
}

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

// ─── 案件ID解決（統合済みIDを統合先へ辿る） ─────────────────────
// 統合後に旧IDで保存・検索されても迷子にならないようにする。
function resolveCaseId(caseId) {
  if (!caseId) return caseId;
  let cur = caseId;
  for (let i = 0; i < 5; i++) {
    const row = db.prepare(`SELECT merged_into FROM cases WHERE case_id=?`).get(cur);
    if (!row?.merged_into || row.merged_into === cur) return cur;
    cur = row.merged_into;
  }
  return cur;
}

// ─── ヘブ則: 検索履歴トラッカー ─────────────────────────────────
// 履歴はmetaテーブルに永続化する。旧実装はプロセス内変数のみだったため、
// セッション（=プロセス）を跨ぐと共起学習がゼロになっていた。
function loadLastSearch() {
  try {
    const v = JSON.parse(metaGet("last_search") ?? "null");
    if (v && Array.isArray(v.results)) return v;
  } catch {}
  return null;
}

function recordSearchResults(results) {
  const now = Date.now();
  const prev = loadLastSearch();

  // 同一検索内の共起（上位5件同士）: 同じ問いに一緒に答えた記憶を関連づける
  strengthenLinks(results.slice(0, 5), results.slice(0, 5));

  // 5分以内の連続検索 → 前回結果と今回結果のリンク強化（プロセス跨ぎ対応）
  if (prev && prev.results.length > 0 && (now - prev.ts) < 5 * 60 * 1000) {
    strengthenLinks(prev.results.slice(0, 5), results.slice(0, 5));
  }
  metaSet("last_search", JSON.stringify({ ts: now, results: results.slice(0, 10) }));
}

// 検索→個別取得（get_conversation等）の流れを「有用だった」シグナルとして強化
function recordAccess(type, id) {
  const prev = loadLastSearch();
  if (prev && (Date.now() - prev.ts) < 10 * 60 * 1000) {
    strengthenLinks(prev.results.slice(0, 5), [{ type, id }]);
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

// ─── グラフ探索（BFS多段ホップ） ────────────────────────────────
function traverseGraph(startType, startId, maxDepth = 2, minWeight = 0.1) {
  const visited = new Set([`${startType}:${startId}`]);
  const results = [];
  let frontier = [{ type: startType, id: startId, depth: 0, pathScore: 1.0, path: [] }];

  const stmt = db.prepare(`
    SELECT target_type, target_id, weight FROM memory_links
    WHERE source_type=? AND source_id=? AND weight >= ?
    ORDER BY weight DESC LIMIT 10
  `);

  for (let d = 0; d < maxDepth; d++) {
    const nextFrontier = [];
    for (const node of frontier) {
      const links = stmt.all(node.type, node.id, minWeight);
      for (const l of links) {
        const k = `${l.target_type}:${l.target_id}`;
        if (visited.has(k)) continue;
        visited.add(k);
        const pathScore = node.pathScore * l.weight;
        const path = [...node.path, { type: node.type, id: node.id }];
        const entry = { type: l.target_type, id: l.target_id, depth: d + 1, pathScore, path };
        results.push(entry);
        nextFrontier.push(entry);
      }
    }
    frontier = nextFrontier;
  }

  results.sort((a, b) => b.pathScore - a.pathScore);
  return results;
}

// 関連メモ取得（グラフ探索版、2ホップ、上位5件）
function getRelatedMemories(results) {
  if (results.length === 0) return "";
  const seen = new Set(results.map(r => `${r.type}:${r.id}`));
  const allRelated = [];

  for (const r of results) {
    const traversed = traverseGraph(r.type, r.id, 2, 0.05);
    for (const t of traversed) {
      const k = `${t.type}:${t.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      allRelated.push(t);
    }
  }

  allRelated.sort((a, b) => b.pathScore - a.pathScore);
  const top = allRelated.slice(0, 5);
  if (top.length === 0) return "";

  const lines = top.map(r => {
    let label = "";
    const depthTag = r.depth > 1 ? ` depth:${r.depth}` : "";
    if (r.type === "note") {
      const n = db.prepare(`SELECT key, invalid_at FROM notes WHERE id=?`).get(r.id);
      if (!n || n.invalid_at) return null; // 無効化済みメモは関連候補から除外
      label = `[メモ] id:${r.id} "${n.key ?? "(無題)"}" (score:${r.pathScore.toFixed(3)}${depthTag})`;
    } else {
      const c = db.prepare(`SELECT title FROM conversations WHERE id=?`).get(r.id);
      if (!c) return null;
      label = `[会話] id:${r.id} "${decrypt(c.title)}" (score:${r.pathScore.toFixed(3)}${depthTag})`;
    }
    return label;
  }).filter(Boolean);

  if (lines.length === 0) return "";
  return `\n\n🔗 関連メモ（ヘブ則グラフ探索）:\n${lines.join("\n")}`;
}

// ─── ベクトル検索ヘルパー ───────────────────────────────────────
async function getEmbedding(text, timeoutMs = 10000) {
  if (!VECTOR_ENABLED) return null;
  // エンドポイント停止中はクールダウンを置いて再試行（毎回の接続待ちを防ぐ）
  if (embeddingHealth === "down" && Date.now() - embeddingDownSince < EMBEDDING_RETRY_MS) {
    return null;
  }
  try {
    const res = await fetch(EMBEDDING_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${EMBEDDING_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // 4xx(入力長超過等)はエンドポイント自体は生きているのでdown扱いにしない
      if (res.status >= 500) { embeddingHealth = "down"; embeddingDownSince = Date.now(); }
      return null;
    }
    const json = await res.json();
    const vec = json.data?.[0]?.embedding ?? null;
    if (vec) embeddingHealth = "ok";
    return vec;
  } catch {
    embeddingHealth = "down"; embeddingDownSince = Date.now();
    return null;
  }
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
  let vec = await getEmbedding(text);
  // CJK長文は埋め込みモデルのコンテキスト超過(400)になり得るため短縮して再試行
  if (!vec && text.length > 2000) vec = await getEmbedding(text.slice(0, 2000));
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

// M7 fix: HTTP平文通信だが127.0.0.1(localhost)限定のため許容。外部通信には使用しない。
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
  // M3 fix: FTS DELETE失敗時にエラーログを出力
  try { db.prepare(`DELETE FROM conversations_fts WHERE rowid=?`).run(id); } catch (e) { console.error(`[memory-mcp] FTS conv DELETE failed id:${id}`, e); }
  db.prepare(`INSERT INTO conversations_fts(rowid, title, summary, content, tags) VALUES(?,?,?,?,?)`)
    .run(id, title, summary ?? "", content, tags);
}
function syncNoteFts(id, key, content, tags) {
  // M3 fix: FTS DELETE失敗時にエラーログを出力
  try { db.prepare(`DELETE FROM notes_fts WHERE rowid=?`).run(id); } catch (e) { console.error(`[memory-mcp] FTS note DELETE failed id:${id}`, e); }
  db.prepare(`INSERT INTO notes_fts(rowid, key, content, tags) VALUES(?,?,?,?)`)
    .run(id, key ?? "", content, tags);
}

// ═══════════════════════════════════════════════════════════════
// MCPサーバー
// ═══════════════════════════════════════════════════════════════
const server = new McpServer({ name: "memory-mcp", version: "3.1.0" });

// ─── save_conversation ──────────────────────────────────────────
server.tool("save_conversation",
  "Save a chat conversation to SQLite. / 現在のチャット会話をSQLiteに保存。",
  {
    title:   z.string().describe("Title / タイトル"),
    content: z.string().describe("Full conversation text / 会話の全文"),
    summary: z.string().optional().describe("1-3 line summary / 1〜3行の要約"),
    tags:    z.array(z.string()).optional().describe("Tags / タグ配列"),
    source:  z.string().optional().describe("Source (default: claude) / 出典"),
    case_id: z.string().optional().describe("Case ID / 案件ID"),
  },
  async ({ title, content, summary, tags, source, case_id }) => {
    case_id = resolveCaseId(case_id);
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
  "Save a short note or decision. Upsert by key. / 短いメモ・決定事項を保存。keyで上書き更新。",
  {
    content: z.string().describe("Text content / テキスト"),
    key:     z.string().optional().describe("Key for upsert / キー名(上書き用)"),
    tags:    z.array(z.string()).optional(),
    case_id: z.string().optional().describe("Case ID / 案件ID"),
    valid_at: z.string().optional().describe("When this fact became valid (ISO date) / この事実が有効になった日時"),
  },
  async ({ content, key, tags, case_id, valid_at }) => {
    case_id = resolveCaseId(case_id);
    const t = autoProjectTag(tags ?? []);
    const tagsJson = JSON.stringify(t);
    const vat = valid_at ?? new Date().toISOString().slice(0, 10);
    let id;
    if (key) {
      db.prepare(`INSERT INTO notes(key,content,tags,case_id,valid_at) VALUES(?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET content=excluded.content,tags=excluded.tags,
        case_id=COALESCE(excluded.case_id,case_id),
        valid_at=COALESCE(excluded.valid_at,valid_at),
        updated_at=datetime('now','localtime')`).run(key, encrypt(content), tagsJson, case_id ?? null, vat);
      id = db.prepare("SELECT id FROM notes WHERE key=?").get(key)?.id;
    } else {
      id = Number(db.prepare(`INSERT INTO notes(content,tags,case_id,valid_at) VALUES(?,?,?,?)`)
        .run(encrypt(content), tagsJson, case_id ?? null, vat).lastInsertRowid);
    }
    syncNoteFts(id, key, content, tagsJson);
    if (case_id) initCaseLinks("note", id, case_id);
    await upsertVector("note", id, `${key ?? ""} ${content}`.slice(0, 8000));
    return { content: [{ type: "text", text: `✅ メモ保存 id:${id}${key ? ` key:${key}` : ""}${case_id ? ` case:${case_id}` : ""}` }] };
  }
);

// ─── broadcast_note（feature 2） ────────────────────────────────
server.tool("broadcast_note",
  "Save note and broadcast to other Claude Code sessions. / メモを保存し他セッションにブロードキャスト。",
  {
    content: z.string().describe("Content to broadcast / ブロードキャストする内容"),
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

// ─── FTSクエリ構築（ユーザー入力エスケープ） ─────────────────────
// FTS5 は bareword 中の - : * 等を列フィルタ/演算子として解釈するため、
// 各語をフレーズクォートしてリテラル化する（"project-layout" 等で必須）。
// tokenize='trigram' ではクォートしてもヒット集合は不変。
function buildFtsQuery(words, op = " AND ") {
  return words.map(w => w.replace(/\*+$/, "")).filter(Boolean)
              .map(w => `"${w.replaceAll('"', '""')}"`).join(op);
}
// LIKE分岐用: % _ \ のワイルドカード解釈を防ぐ（LIKE ? ESCAPE '\' とペアで使う）
function escapeLike(w) {
  return w.replace(/[\\%_]/g, c => "\\" + c);
}

// ─── search_memory（ヘブ則対応） ────────────────────────────────
server.tool("search_memory",
  "Full-text search across saved notes and conversations (Japanese/CJK supported). Shows Hebbian linked memories. / 保存済みメモ・会話を全文検索(日本語対応)。ヘブ則リンクも表示。",
  {
    query:   z.string().describe("Keywords (space-separated AND) / キーワード(スペース区切りでAND)"),
    case_id: z.string().optional().describe("Filter by case ID / 案件IDで絞り込み"),
    include_invalid: z.boolean().optional().default(false).describe("Include invalidated notes / 無効化されたメモも含める"),
    agent_id: z.string().optional().describe("Filter by agent ID / エージェントIDで絞り込み"),
  },
  ({ query, case_id, include_invalid, agent_id }) => {
    case_id = resolveCaseId(case_id);
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return { content: [{ type: "text", text: "検索語を指定してください。" }] };
    const hasShortWord = words.some(w => [...w].length < 3);

    // 動的フィルタ構築
    const noteFilters = [];
    const noteParams = [];
    const convFilters = [];
    const convParams = [];
    if (case_id) { noteFilters.push("n.case_id=?"); noteParams.push(case_id); convFilters.push("c.case_id=?"); convParams.push(case_id); }
    if (agent_id) { noteFilters.push("n.agent_id=?"); noteParams.push(agent_id); convFilters.push("c.agent_id=?"); convParams.push(agent_id); }
    if (!include_invalid) { noteFilters.push("n.invalid_at IS NULL"); }
    const noteWhere = noteFilters.length ? " AND " + noteFilters.join(" AND ") : "";
    const convWhere = convFilters.length ? " AND " + convFilters.join(" AND ") : "";

    // 短語(3文字未満)はtrigram FTSで引けないためLIKEで全列(タイトル/キー/タグ含む)を見る。
    // 旧実装はcontent列しか見ておらず「保釈」「認証」等の2文字クエリがタイトル一致を取り零していた。
    const runLike = (joiner) => {
      const convCols = ["title", "summary", "content", "tags"];
      const noteCols = ["key", "content", "tags"];
      const clause = (table, cols) => words.map(() =>
        "(" + cols.map(col => `${table}.${col} LIKE ? ESCAPE '\\'`).join(" OR ") + ")"
      ).join(joiner);
      const paramsFor = (cols) => words.flatMap(w => cols.map(() => `%${escapeLike(w)}%`));
      return db.prepare(`
        SELECT 'conversation' as type, c.id, c.title as key_enc, c.summary as body_enc,
          '' as snip, c.created_at, c.case_id, NULL as valid_at, NULL as invalid_at
        FROM conversations_fts
        JOIN conversations c ON conversations_fts.rowid=c.id
        WHERE (${clause("conversations_fts", convCols)})${convWhere}
        UNION ALL
        SELECT 'note', n.id, n.key as key_enc, n.content as body_enc,
          '' as snip, n.created_at, n.case_id, n.valid_at, n.invalid_at
        FROM notes_fts
        JOIN notes n ON notes_fts.rowid=n.id
        WHERE (${clause("notes_fts", noteCols)})${noteWhere}
        ORDER BY created_at DESC LIMIT 20
      `).all(...paramsFor(convCols), ...convParams, ...paramsFor(noteCols), ...noteParams);
    };
    // FTS経路: bm25(rank)の関連度順で返す（旧実装は作成日時順で関連度無視だった）
    const runFts = (op) => {
      const q = buildFtsQuery(words, op);
      if (!q) return [];
      return db.prepare(`
        SELECT 'conversation' as type, c.id, c.title as key_enc, NULL as body_enc,
          snippet(conversations_fts,2,'【','】','…',60) as snip, c.created_at, c.case_id,
          NULL as valid_at, NULL as invalid_at, rank as rnk
        FROM conversations_fts
        JOIN conversations c ON conversations_fts.rowid=c.id
        WHERE conversations_fts MATCH ?${convWhere}
        UNION ALL
        SELECT 'note', n.id, n.key as key_enc, NULL as body_enc,
          snippet(notes_fts,1,'【','】','…',60), n.created_at, n.case_id, n.valid_at, n.invalid_at, rank as rnk
        FROM notes_fts
        JOIN notes n ON notes_fts.rowid=n.id
        WHERE notes_fts MATCH ?${noteWhere}
        ORDER BY rnk LIMIT 20
      `).all(q, ...convParams, q, ...noteParams);
    };

    // 全語AND → 0件なら OR に段階緩和（複数語の共起問題対策）
    let relaxed = false;
    let rows = hasShortWord ? runLike(" AND ") : runFts(" AND ");
    if (!rows.length && words.length > 1) {
      rows = hasShortWord ? runLike(" OR ") : runFts(" OR ");
      relaxed = true;
    }
    if (!rows.length) return { content: [{ type: "text", text: `「${query}」に一致するデータはありません。` }] };

    const searchResults = rows.map(r => ({ type: r.type, id: r.id }));
    recordSearchResults(searchResults);

    const text = rows.map(r => {
      const label = r.type === "conversation"
        ? decrypt(r.key_enc) ?? "(不明)"
        : r.key_enc ?? "(無題)";
      const caseTag = r.case_id ? ` [案件:${r.case_id}]` : "";
      const temporal = r.valid_at
        ? (r.invalid_at ? ` [無効: ${r.valid_at}〜${r.invalid_at}]` : ` [有効: ${r.valid_at}〜]`)
        : "";
      // LIKE経路はsnippetが無いので本文冒頭をプレビューとして復号表示
      const snip = r.snip || (r.body_enc
        ? (decrypt(r.body_enc) ?? "").replace(/\s+/g, " ").slice(0, 80) + "…"
        : "");
      return `[${r.type === "conversation" ? "会話" : "メモ"}] id:${r.id} "${label}"${caseTag}${temporal}\n  ${snip}\n  ${r.created_at}`;
    }).join("\n\n");

    const related = getRelatedMemories(searchResults);
    const header = `🔍 ${rows.length}件${relaxed ? "（全語AND一致なし→ORに緩和）" : ""}`;
    return { content: [{ type: "text", text: `${header}\n\n${text}${related}` }] };
  }
);

// ─── list_conversations ─────────────────────────────────────────
server.tool("list_conversations",
  "List saved conversations (newest first). / 保存済み会話の一覧(新しい順)",
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
  "Get full conversation by ID. / 指定IDの会話全文を取得",
  { id: z.number().int() },
  ({ id }) => {
    const row = db.prepare(`SELECT * FROM conversations WHERE id=?`).get(id);
    if (!row) return { content: [{ type: "text", text: `id:${id} は存在しません。` }] };
    recordAccess("conversation", id); // 検索→取得の流れをヘブ則強化シグナルにする
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
  "Delete a conversation by ID. / 指定IDの会話を削除",
  { id: z.number().int() },
  ({ id }) => {
    // M3 fix: FTS DELETE失敗時にエラーログを出力
    try { db.prepare(`DELETE FROM conversations_fts WHERE rowid=?`).run(id); } catch (e) { console.error(`[memory-mcp] FTS conv DELETE failed id:${id}`, e); }
    db.prepare(`DELETE FROM memory_links WHERE (source_type='conversation' AND source_id=?) OR (target_type='conversation' AND target_id=?)`).run(id, id);
    db.prepare(`DELETE FROM vectors WHERE type='conversation' AND id=?`).run(id);
    const info = db.prepare(`DELETE FROM conversations WHERE id=?`).run(id);
    return { content: [{ type: "text", text: info.changes > 0 ? `🗑 id:${id} 削除しました。` : `id:${id} は存在しません。` }] };
  }
);

// ─── 案件管理ツール（feature 4） ────────────────────────────────
server.tool("save_case_note",
  "Save a note linked to a case. Auto-creates case if not exists. / 案件に紐づけてメモを保存。案件が未登録なら自動作成。",
  {
    case_id: z.string().describe("Case ID (e.g. project-2026) / 案件ID"),
    case_name: z.string().optional().describe("Case name (for new cases) / 案件名(新規登録時)"),
    content: z.string().describe("Note content / メモ内容"),
    key:     z.string().optional().describe("Key for upsert / キー名(上書き用)"),
    tags:    z.array(z.string()).optional(),
  },
  async ({ case_id, case_name, content, key, tags }) => {
    // 統合済み案件への保存は統合先へ自動転送（旧IDの黙殺防止）
    const requestedId = case_id;
    case_id = resolveCaseId(case_id);
    const redirectNote = case_id !== requestedId
      ? `\n↪ "${requestedId}" は統合済みのため "${case_id}" に保存しました` : "";
    // 案件自動登録（case-a / case_a / case-a-2026 のような類似IDの分裂を防止）
    const existing = db.prepare(`SELECT case_id FROM cases WHERE case_id=?`).get(case_id);
    let similarWarn = "";
    if (!existing) {
      const norm = (s) => (s ?? "").toLowerCase().replace(/[-_\s]/g, "");
      const nid = norm(case_id);
      const similar = db.prepare(`SELECT case_id, name FROM cases`).all()
        .filter(c => {
          const m = norm(c.case_id), nm = norm(c.name);
          return (m && (m.includes(nid) || nid.includes(m)))
              || (nm && (nm.includes(nid) || nid.includes(nm)));
        })
        .map(c => c.case_id);
      db.prepare(`INSERT INTO cases(case_id, name) VALUES(?,?)`)
        .run(case_id, case_name ?? case_id);
      if (similar.length) {
        similarWarn = `\n⚠️ 類似案件が既に存在: ${similar.join(", ")} — 同一案件なら merge_cases で統合を検討してください`;
      }
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
    return { content: [{ type: "text", text: `✅ 案件メモ保存 id:${id} case:${case_id}${key ? ` key:${key}` : ""}${similarWarn}${redirectNote}` }] };
  }
);

// ─── merge_cases（分裂した案件の統合） ──────────────────────────
server.tool("merge_cases",
  "Merge one case into another (moves notes/conversations, archives source). / 分裂した案件を統合（メモ・会話を移動し、統合元をアーカイブ）。",
  {
    from_case_id: z.string().describe("Source case ID (will be archived) / 統合元の案件ID"),
    to_case_id:   z.string().describe("Destination case ID / 統合先の案件ID"),
  },
  ({ from_case_id, to_case_id }) => {
    if (from_case_id === to_case_id) {
      return { content: [{ type: "text", text: "統合元と統合先が同一です。" }] };
    }
    const from = db.prepare(`SELECT * FROM cases WHERE case_id=?`).get(from_case_id);
    const to = db.prepare(`SELECT * FROM cases WHERE case_id=?`).get(to_case_id);
    if (!from) return { content: [{ type: "text", text: `統合元 "${from_case_id}" は存在しません。` }] };
    if (!to) return { content: [{ type: "text", text: `統合先 "${to_case_id}" は存在しません。` }] };
    // 循環防止: 統合先が(連鎖の果てに)統合元を指す場合は拒否
    if (resolveCaseId(to_case_id) === from_case_id) {
      return { content: [{ type: "text", text: "循環統合になるため拒否しました。" }] };
    }
    const movedNoteIds = db.prepare(`SELECT id FROM notes WHERE case_id=?`).all(from_case_id).map(r => r.id);
    const nMoved = db.prepare(`UPDATE notes SET case_id=? WHERE case_id=?`).run(to_case_id, from_case_id).changes;
    const cMoved = db.prepare(`UPDATE conversations SET case_id=? WHERE case_id=?`).run(to_case_id, from_case_id).changes;
    // merged_intoを刻む: 以後、旧IDへの保存・検索は統合先に自動解決される
    db.prepare(`UPDATE cases SET status='archived', merged_into=?,
      updated_at=datetime('now','localtime') WHERE case_id=?`).run(to_case_id, from_case_id);
    db.prepare(`UPDATE cases SET updated_at=datetime('now','localtime') WHERE case_id=?`).run(to_case_id);
    // 移動したメモを統合先の案件メンバーとしてヘブ則リンクに再接続
    for (const nid of movedNoteIds) initCaseLinks("note", nid, to_case_id);
    return { content: [{ type: "text", text: `🔀 "${from_case_id}" → "${to_case_id}" に統合: メモ${nMoved}件・会話${cMoved}件を移動。旧IDへの保存・検索は以後 "${to_case_id}" に自動転送されます。` }] };
  }
);

// ─── invalidate_note（時間軸管理） ──────────────────────────────
server.tool("invalidate_note",
  "Mark a note as no longer valid (temporal invalidation). / メモを無効化（時間軸管理）。",
  {
    id:     z.number().int().optional().describe("Note ID / メモID"),
    key:    z.string().optional().describe("Note key / メモのキー"),
    reason: z.string().optional().describe("Reason for invalidation / 無効化の理由"),
  },
  async ({ id, key, reason }) => {
    let noteId = id;
    if (!noteId && key) {
      const row = db.prepare(`SELECT id FROM notes WHERE key=?`).get(key);
      if (!row) return { content: [{ type: "text", text: `key="${key}" は存在しません。` }] };
      noteId = row.id;
    }
    if (!noteId) return { content: [{ type: "text", text: `id または key を指定してください。` }] };
    const info = db.prepare(`UPDATE notes SET invalid_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?`).run(noteId);
    if (info.changes === 0) return { content: [{ type: "text", text: `id:${noteId} は存在しません。` }] };
    // M4 fix: invalidation後にFTSとベクトルを同期
    const updatedNote = db.prepare(`SELECT key, content, tags FROM notes WHERE id=?`).get(noteId);
    if (updatedNote) {
      syncNoteFts(noteId, updatedNote.key, decrypt(updatedNote.content) ?? "", updatedNote.tags);
      await upsertVector("note", noteId, `${updatedNote.key ?? ""} ${decrypt(updatedNote.content) ?? ""}`.slice(0, 8000));
    }
    if (reason) {
      // 同一メモの再無効化でもUNIQUE衝突しないようupsert
      const reasonKey = `invalidation-reason-${noteId}`;
      const reasonText = `id:${noteId}の無効化理由: ${reason}`;
      db.prepare(`INSERT INTO notes(key,content,tags,valid_at) VALUES(?,?,?,datetime('now','localtime'))
        ON CONFLICT(key) DO UPDATE SET content=excluded.content,
        valid_at=excluded.valid_at, updated_at=datetime('now','localtime')`)
        .run(reasonKey, encrypt(reasonText), "[]");
      const rid = db.prepare(`SELECT id FROM notes WHERE key=?`).get(reasonKey)?.id;
      if (rid) syncNoteFts(rid, reasonKey, reasonText, "[]");
    }
    return { content: [{ type: "text", text: `⏰ id:${noteId} を無効化しました。${reason ? ` 理由: ${reason}` : ""}` }] };
  }
);

server.tool("list_cases",
  "List registered cases. / 登録済み案件の一覧。",
  { include_archived: z.boolean().optional().default(false).describe("Include archived / アーカイブ済みも含める") },
  ({ include_archived }) => {
    // M5 fix: N+1クエリをJOIN+サブクエリで一括取得
    const statusFilter = include_archived ? "" : "WHERE c.status='active'";
    const q = `
      SELECT c.*,
        COALESCE(n.cnt, 0) as noteCount,
        COALESCE(cv.cnt, 0) as convCount
      FROM cases c
      LEFT JOIN (SELECT case_id, COUNT(*) as cnt FROM notes GROUP BY case_id) n ON n.case_id = c.case_id
      LEFT JOIN (SELECT case_id, COUNT(*) as cnt FROM conversations GROUP BY case_id) cv ON cv.case_id = c.case_id
      ${statusFilter}
      ORDER BY c.updated_at DESC`;
    const rows = db.prepare(q).all();
    if (!rows.length) return { content: [{ type: "text", text: "登録済みの案件はありません。" }] };
    const text = rows.map(r => {
      const st = r.merged_into ? `${r.status}→${r.merged_into}` : r.status;
      return `[${st}] ${r.case_id}: ${r.name} (メモ:${r.noteCount} 会話:${r.convCount}) ${r.updated_at}`;
    }).join("\n");
    return { content: [{ type: "text", text: `📁 案件一覧 (${rows.length}件)\n\n${text}` }] };
  }
);

server.tool("get_case",
  "Get case details with notes and conversations. / 指定案件の詳細とメモ・会話一覧を取得",
  { case_id: z.string().describe("Case ID / 案件ID") },
  ({ case_id }) => {
    const requestedId = case_id;
    case_id = resolveCaseId(case_id);
    const c = db.prepare(`SELECT * FROM cases WHERE case_id=?`).get(case_id);
    if (!c) return { content: [{ type: "text", text: `案件 "${case_id}" は存在しません。` }] };
    const redirectNote = case_id !== requestedId ? `（"${requestedId}" は統合済み → "${case_id}" を表示）\n` : "";
    const notes = db.prepare(`SELECT id, key, content, tags, created_at FROM notes WHERE case_id=? ORDER BY created_at DESC`).all(case_id);
    const convs = db.prepare(`SELECT id, title, summary, created_at FROM conversations WHERE case_id=? ORDER BY created_at DESC`).all(case_id);
    let text = `${redirectNote}📁 案件: ${c.name} (${c.case_id})\nステータス: ${c.status}\n作成: ${c.created_at}\n\n`;
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
  "Archive a case (does not delete). / 案件をアーカイブ(削除はしない)。",
  { case_id: z.string().describe("Case ID / 案件ID") },
  ({ case_id }) => {
    const info = db.prepare(`UPDATE cases SET status='archived', updated_at=datetime('now','localtime') WHERE case_id=?`).run(case_id);
    if (info.changes === 0) return { content: [{ type: "text", text: `案件 "${case_id}" は存在しません。` }] };
    return { content: [{ type: "text", text: `📦 案件 "${case_id}" をアーカイブしました。` }] };
  }
);

// ─── エージェント別記憶（swarm-protocol接続） ──────────────────
server.tool("save_agent_memory",
  "Save a memory for a specific agent (swarm worker/conductor). / エージェント別の記憶を保存（swarm worker/conductor用）。",
  {
    agent_id: z.string().describe("Agent ID (e.g. swarm-worker-1) / エージェントID"),
    content:  z.string().describe("Memory content / 記憶内容"),
    key:      z.string().optional().describe("Key for upsert / キー名"),
    tags:     z.array(z.string()).optional(),
    case_id:  z.string().optional().describe("Case ID / 案件ID"),
  },
  async ({ agent_id, content, key, tags, case_id }) => {
    case_id = resolveCaseId(case_id);
    const t = autoProjectTag(tags ?? []);
    t.push(`agent:${agent_id}`);
    const tagsJson = JSON.stringify(t);
    const vat = new Date().toISOString().slice(0, 10);
    let id;
    const effectiveKey = key ? `${agent_id}:${key}` : null;
    if (effectiveKey) {
      db.prepare(`INSERT INTO notes(key,content,tags,case_id,valid_at,agent_id) VALUES(?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET content=excluded.content,tags=excluded.tags,
        case_id=COALESCE(excluded.case_id,case_id),agent_id=excluded.agent_id,
        valid_at=COALESCE(excluded.valid_at,valid_at),
        updated_at=datetime('now','localtime')`).run(effectiveKey, encrypt(content), tagsJson, case_id ?? null, vat, agent_id);
      id = db.prepare("SELECT id FROM notes WHERE key=?").get(effectiveKey)?.id;
    } else {
      id = Number(db.prepare(`INSERT INTO notes(content,tags,case_id,valid_at,agent_id) VALUES(?,?,?,?,?)`)
        .run(encrypt(content), tagsJson, case_id ?? null, vat, agent_id).lastInsertRowid);
    }
    syncNoteFts(id, effectiveKey, content, tagsJson);
    if (case_id) initCaseLinks("note", id, case_id);
    await upsertVector("note", id, `${effectiveKey ?? ""} ${content}`.slice(0, 8000));
    return { content: [{ type: "text", text: `🤖 エージェント記憶保存 id:${id} agent:${agent_id}${effectiveKey ? ` key:${effectiveKey}` : ""}` }] };
  }
);

server.tool("get_agent_context",
  "Get all memories for a specific agent. / 特定エージェントの全記憶を取得。",
  {
    agent_id: z.string().describe("Agent ID / エージェントID"),
    limit:    z.number().int().min(1).max(50).optional().default(10).describe("Max results / 最大件数"),
  },
  ({ agent_id, limit }) => {
    const rows = db.prepare(`SELECT id, key, content, tags, valid_at, invalid_at, case_id, created_at
      FROM notes WHERE agent_id=? ORDER BY created_at DESC LIMIT ?`).all(agent_id, limit);
    if (!rows.length) return { content: [{ type: "text", text: `エージェント "${agent_id}" の記憶はありません。` }] };
    const text = rows.map(r => {
      const temporal = r.invalid_at ? `[無効: ${r.valid_at}〜${r.invalid_at}]` : `[有効: ${r.valid_at ?? "?"}〜]`;
      return `id:${r.id} ${r.key ?? "(無題)"} ${temporal}\n  ${decrypt(r.content)?.slice(0, 100)}…`;
    }).join("\n\n");
    return { content: [{ type: "text", text: `🤖 エージェント "${agent_id}" の記憶 (${rows.length}件)\n\n${text}` }] };
  }
);

// ─── rag_query（RAG: 検索→全文取得→文脈返却を一発で） ─────────
server.tool("rag_query",
  "RAG search: hybrid keyword + vector search returning full context. Use when Claude needs past memories to answer. / RAG検索: キーワード+ベクトルで全文を文脈として返す。",
  {
    query: z.string().describe("Question or search query (natural language OK) / 質問や検索クエリ(自然文OK)"),
    limit: z.number().int().min(1).max(10).optional().default(5).describe("Max results / 取得件数"),
    case_id: z.string().optional().describe("Filter by case ID / 案件IDで絞り込み"),
  },
  async ({ query, limit, case_id }) => {
    case_id = resolveCaseId(case_id);
    const results = new Map(); // key: "type:id" → { type, id, score, source }

    // 1. FTS5 キーワード検索（全語AND→0件ならORに段階緩和・無効化済みメモ除外・関連度順）
    const words = query.trim().split(/\s+/).filter(Boolean);
    const hasShortWord = words.some(w => [...w].length < 3);
    const noteCaseFilter = case_id ? " AND t.case_id=?" : "";
    const caseParams = case_id ? [case_id] : [];

    const runLike = (joiner) => {
      const noteCols = ["key", "content", "tags"];
      const convCols = ["title", "summary", "content", "tags"];
      const clause = (table, cols) => words.map(() =>
        "(" + cols.map(col => table + "." + col + " LIKE ? ESCAPE '\\'").join(" OR ") + ")"
      ).join(joiner);
      const paramsFor = (cols) => words.flatMap(w => cols.map(() => "%" + escapeLike(w) + "%"));
      return db.prepare(
        "SELECT 'note' as type, t.id FROM notes_fts JOIN notes t ON notes_fts.rowid=t.id WHERE (" +
        clause("notes_fts", noteCols) + ") AND t.invalid_at IS NULL" + noteCaseFilter +
        " UNION ALL SELECT 'conversation', t.id FROM conversations_fts JOIN conversations t ON conversations_fts.rowid=t.id WHERE (" +
        clause("conversations_fts", convCols) + ")" + noteCaseFilter + " LIMIT 20"
      ).all(...paramsFor(noteCols), ...caseParams, ...paramsFor(convCols), ...caseParams);
    };
    const runFts = (op) => {
      const q = buildFtsQuery(words, op);
      if (!q) return []; // 全語が * のみ等 → FTSヒットなし扱い（ベクトル検索は継続）
      return db.prepare(
        "SELECT 'note' as type, t.id, rank as rnk FROM notes_fts JOIN notes t ON notes_fts.rowid=t.id WHERE notes_fts MATCH ? AND t.invalid_at IS NULL" + noteCaseFilter +
        " UNION ALL SELECT 'conversation', t.id, rank as rnk FROM conversations_fts JOIN conversations t ON conversations_fts.rowid=t.id WHERE conversations_fts MATCH ?" + noteCaseFilter +
        " ORDER BY rnk LIMIT 20"
      ).all(q, ...caseParams, q, ...caseParams);
    };

    let ftsRows = [];
    if (words.length) {
      ftsRows = hasShortWord ? runLike(" AND ") : runFts(" AND ");
      if (!ftsRows.length && words.length > 1) {
        ftsRows = hasShortWord ? runLike(" OR ") : runFts(" OR ");
      }
    }
    for (let i = 0; i < ftsRows.length; i++) {
      const r = ftsRows[i];
      const k = r.type + ":" + r.id;
      const score = 1.0 - (i * 0.03); // FTSは順位ベースのスコア
      results.set(k, { type: r.type, id: r.id, score, sources: ["fts"] });
    }

    // 2. ベクトル検索（有効時のみ）
    // M1 fix: case_id指定時はWHERE句で絞り込み、未指定時はLIMIT 1000で全件フルスキャンを防止
    if (VECTOR_ENABLED) {
      const queryVec = await getEmbedding(query);
      if (queryVec) {
        let vecRows;
        if (case_id) {
          vecRows = db.prepare(
            `SELECT v.type, v.id, v.embedding FROM vectors v
             WHERE (v.type='note' AND v.id IN (SELECT id FROM notes WHERE case_id=?))
                OR (v.type='conversation' AND v.id IN (SELECT id FROM conversations WHERE case_id=?))`
          ).all(case_id, case_id);
        } else {
          vecRows = db.prepare("SELECT type, id, embedding FROM vectors LIMIT 1000").all();
        }
        const scored = vecRows.map(row => {
          const vec = blobToVec(row.embedding);
          return { type: row.type, id: row.id, sim: cosineSimilarity(queryVec, vec) };
        });
        scored.sort((a, b) => b.sim - a.sim);

        for (const s of scored.slice(0, 20)) {
          const k = s.type + ":" + s.id;
          const existing = results.get(k);
          if (existing) {
            // 両方でヒット → スコアブースト
            existing.score = Math.min(existing.score + s.sim * 0.5, 2.0);
            existing.sources.push("vec");
          } else {
            results.set(k, { type: s.type, id: s.id, score: s.sim, sources: ["vec"] });
          }
        }
      }
    }

    if (results.size === 0) {
      return { content: [{ type: "text", text: "関連する記憶は見つかりませんでした。" }] };
    }

    // 3. スコア順にソートして上位を全文取得
    const sorted = [...results.values()].sort((a, b) => b.score - a.score).slice(0, limit);

    // ヘブ則: 検索結果を記録
    recordSearchResults(sorted.map(r => ({ type: r.type, id: r.id })));

    const chunks = [];
    for (const r of sorted) {
      const src = r.sources.join("+");
      if (r.type === "note") {
        const n = db.prepare("SELECT key, content, tags, case_id, created_at FROM notes WHERE id=?").get(r.id);
        if (!n) continue;
        const keyName = n.key ?? "(無題)";
        const caseTag = n.case_id ? " [案件:" + n.case_id + "]" : "";
        chunks.push(
          "--- メモ id:" + r.id + ' "' + keyName + '" (' + src + " score:" + r.score.toFixed(2) + ")" + caseTag + " " + n.created_at + " ---\n" +
          decrypt(n.content)
        );
      } else {
        const c = db.prepare("SELECT title, summary, content, tags, case_id, created_at FROM conversations WHERE id=?").get(r.id);
        if (!c) continue;
        const titleStr = decrypt(c.title) ?? "(不明)";
        const caseTag = c.case_id ? " [案件:" + c.case_id + "]" : "";
        const summaryStr = decrypt(c.summary);
        const contentStr = decrypt(c.content);
        // 会話は長いのでsummaryがあればsummary優先、なければ先頭2000文字
        const body = summaryStr ? "要約: " + summaryStr + "\n\n" + (contentStr?.slice(0, 2000) ?? "") : (contentStr?.slice(0, 3000) ?? "");
        chunks.push(
          "--- 会話 id:" + r.id + ' "' + titleStr + '" (' + src + " score:" + r.score.toFixed(2) + ")" + caseTag + " " + c.created_at + " ---\n" +
          body
        );
      }
    }

    const related = getRelatedMemories(sorted.map(r => ({ type: r.type, id: r.id })));
    return {
      content: [{
        type: "text",
        text: "📚 RAG検索: " + sorted.length + "件の関連記憶\n\n" + chunks.join("\n\n") + related,
      }],
    };
  }
);

// ─── semantic_search（ベクトル検索） ────────────────────────────
server.tool("semantic_search",
  "Semantic similarity search. Use when keywords are unclear. Requires EMBEDDING_API_KEY. / 意味的類似検索。キーワードが思い出せない時に使う。",
  {
    query: z.string().describe("Search query (natural language OK) / 検索クエリ(自然文OK)"),
    limit: z.number().int().min(1).max(20).optional().default(5).describe("Max results / 最大件数"),
    case_id: z.string().optional().describe("Filter by case ID / 案件IDで絞り込み"),
  },
  async ({ query, limit, case_id }) => {
    case_id = resolveCaseId(case_id);
    if (!VECTOR_ENABLED) {
      return { content: [{ type: "text", text: "⚠️ ベクトル検索は無効です。EMBEDDING_API_KEY または OPENAI_API_KEY を設定してください。" }] };
    }
    const queryVec = await getEmbedding(query);
    if (!queryVec) {
      return { content: [{ type: "text", text: "⚠️ Embeddingの取得に失敗しました。" }] };
    }

    // M1 fix: case_id指定時はWHERE句でSQLiteレベルで絞り込み、未指定時はLIMIT 1000
    let allVecs;
    if (case_id) {
      allVecs = db.prepare(
        `SELECT v.type, v.id, v.embedding FROM vectors v
         WHERE (v.type='note' AND v.id IN (SELECT id FROM notes WHERE case_id=?))
            OR (v.type='conversation' AND v.id IN (SELECT id FROM conversations WHERE case_id=?))`
      ).all(case_id, case_id);
    } else {
      allVecs = db.prepare(`SELECT type, id, embedding FROM vectors LIMIT 1000`).all();
    }
    if (!allVecs.length) {
      return { content: [{ type: "text", text: "ベクトルデータがありません。メモを保存するとベクトルが自動生成されます。" }] };
    }

    // コサイン類似度でスコアリング
    const scored = allVecs.map(row => {
      const vec = blobToVec(row.embedding);
      const sim = cosineSimilarity(queryVec, vec);
      return { type: row.type, id: row.id, similarity: sim };
    });
    scored.sort((a, b) => b.similarity - a.similarity);

    // 上位取得（case_idフィルタはSQL側で適用済み）
    const results = scored.slice(0, limit);

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
  "Get Hebbian links (associated memories) for a note or conversation. / 指定メモ/会話のヘブ則リンク(関連記憶)を取得",
  {
    type: z.enum(["note", "conversation"]).describe("Type / 種別"),
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

// ─── グラフ探索ツール ──────────────────────────────────────────
server.tool("traverse_memory_graph",
  "Traverse Hebbian memory graph (multi-hop BFS). / ヘブ則メモリグラフを多段探索（BFS）。",
  {
    type: z.enum(["note", "conversation"]).describe("Type / 種別"),
    id:   z.number().int().describe("ID"),
    max_depth:  z.number().int().min(1).max(4).optional().default(2).describe("Max hops / 最大ホップ数"),
    min_weight: z.number().min(0).max(1).optional().default(0.1).describe("Min weight threshold / 最小重みしきい値"),
  },
  ({ type, id, max_depth, min_weight }) => {
    const results = traverseGraph(type, id, max_depth, min_weight);
    if (!results.length) return { content: [{ type: "text", text: `id:${id} (${type}) からのグラフ探索: リンクなし。` }] };

    const lines = results.slice(0, 20).map(r => {
      let label = "";
      if (r.type === "note") {
        const n = db.prepare(`SELECT key FROM notes WHERE id=?`).get(r.id);
        label = n?.key ?? "(無題)";
      } else {
        const c = db.prepare(`SELECT title FROM conversations WHERE id=?`).get(r.id);
        label = c ? decrypt(c.title) : "(不明)";
      }
      const pathStr = r.path.map(p => `${p.type}:${p.id}`).join(" → ");
      return `  ${"  ".repeat(r.depth - 1)}→ [${r.type}] id:${r.id} "${label}" (score:${r.pathScore.toFixed(3)} depth:${r.depth})\n  ${"  ".repeat(r.depth - 1)}  path: ${pathStr} → ${r.type}:${r.id}`;
    });

    return { content: [{ type: "text", text: `🕸️ グラフ探索 (${type} id:${id}, depth:${max_depth})\n\n${lines.join("\n")}` }] };
  }
);

server.tool("memory_stats",
  "Show memory statistics + health (counts, links, cases, vectors, embedding endpoint). / メモリMCPの統計・健全性診断",
  {},
  async () => {
    const noteCount = db.prepare(`SELECT COUNT(*) as c FROM notes`).get().c;
    const convCount = db.prepare(`SELECT COUNT(*) as c FROM conversations`).get().c;
    const linkCount = db.prepare(`SELECT COUNT(*) as c FROM memory_links`).get().c;
    const caseCount = db.prepare(`SELECT COUNT(*) as c FROM cases WHERE status='active'`).get().c;
    const avgWeight = db.prepare(`SELECT AVG(weight) as a FROM memory_links`).get().a ?? 0;
    const strongLinks = db.prepare(`SELECT COUNT(*) as c FROM memory_links WHERE weight > 0.5`).get().c;
    const vecCount = db.prepare(`SELECT COUNT(*) as c FROM vectors`).get().c;
    const invalidCount = db.prepare(`SELECT COUNT(*) as c FROM notes WHERE invalid_at IS NOT NULL`).get().c;
    const temporalCount = db.prepare(`SELECT COUNT(*) as c FROM notes WHERE valid_at IS NOT NULL`).get().c;
    const agentNotes = db.prepare(`SELECT agent_id, COUNT(*) as c FROM notes WHERE agent_id IS NOT NULL GROUP BY agent_id`).all();
    const agentLine = agentNotes.length > 0
      ? `  エージェント記憶: ${agentNotes.map(a => `${a.agent_id}(${a.c}件)`).join(", ")}`
      : `  エージェント記憶: なし`;

    // ベクトル健全性: 実際にエンドポイントを叩いて可用性を確認
    const totalRows = noteCount + convCount;
    let vecLine;
    if (!VECTOR_ENABLED) {
      vecLine = `  ベクトル: ${vecCount}/${totalRows}件 ⚠️ 無効 (EMBEDDING_API_KEY未設定)`;
    } else {
      const probe = await getEmbedding("health check", 3000);
      vecLine = probe
        ? `  ベクトル: ${vecCount}/${totalRows}件 ✅ ${EMBEDDING_MODEL} @ ${EMBEDDING_URL}`
        : `  ベクトル: ${vecCount}/${totalRows}件 ⚠️ エンドポイント応答なし (${EMBEDDING_URL}) — 保存・検索はFTSのみで継続`;
    }
    let dbSize = "";
    try { dbSize = ` (${(statSync(DB_PATH).size / 1024 / 1024).toFixed(1)}MB)`; } catch {}

    return {
      content: [{
        type: "text",
        text: [
          `📊 Memory MCP Stats (v3.1)`,
          `  メモ: ${noteCount}件 (時間軸付き:${temporalCount} 無効:${invalidCount})`,
          `  会話: ${convCount}件`,
          `  案件: ${caseCount}件 (active)`,
          `  ヘブ則リンク: ${linkCount}件 (avg_w: ${avgWeight.toFixed(3)}, strong>0.5: ${strongLinks}件, 最終減衰: ${metaGet("last_decay") ?? "未実施"})`,
          agentLine,
          vecLine,
          `  DB: ${DB_PATH}${dbSize}`,
          `  暗号化: AES-256-GCM ✅ (注: FTSインデックスは検索のため平文保存)`,
        ].join("\n"),
      }],
    };
  }
);

// ─── export_memory（mdエクスポート） ────────────────────────────
server.tool("export_memory",
  "Export memories as a Markdown file. Useful for backup, sharing, or loading into other tools. / 記憶をMarkdownファイルとしてエクスポート。バックアップや他ツールへの読み込みに。",
  {
    case_id: z.string().optional().describe("Export only this case / この案件のみエクスポート"),
    output_path: z.string().optional().describe("Output file path (default: ~/memory-export.md) / 出力先パス"),
    include_conversations: z.boolean().optional().default(true).describe("Include conversations / 会話を含める"),
    include_notes: z.boolean().optional().default(true).describe("Include notes / メモを含める"),
  },
  ({ case_id, output_path, include_conversations, include_notes }) => {
    const outPath = output_path ?? join(homedir(), "memory-export.md");
    const lines = [];
    const caseLabel = case_id ? " (case: " + case_id + ")" : "";
    lines.push("# Memory Export" + caseLabel);
    lines.push("Exported: " + new Date().toISOString());
    lines.push("");

    if (include_notes) {
      const noteQuery = case_id
        ? "SELECT id, key, content, tags, case_id, created_at FROM notes WHERE case_id=? ORDER BY created_at DESC"
        : "SELECT id, key, content, tags, case_id, created_at FROM notes ORDER BY created_at DESC";
      const notes = case_id ? db.prepare(noteQuery).all(case_id) : db.prepare(noteQuery).all();

      if (notes.length) {
        lines.push("## Notes (" + notes.length + ")");
        lines.push("");
        for (const n of notes) {
          const keyName = n.key ?? "(untitled)";
          const caseTag = n.case_id ? " [case:" + n.case_id + "]" : "";
          lines.push("### " + keyName + caseTag);
          lines.push("- ID: " + n.id);
          lines.push("- Created: " + n.created_at);
          lines.push("- Tags: " + (n.tags ?? "[]"));
          lines.push("");
          // M6 fix: decrypt()がnull返却時に"[decryption failed]"に置換
          lines.push(decrypt(n.content) ?? "[decryption failed]");
          lines.push("");
          lines.push("---");
          lines.push("");
        }
      }
    }

    if (include_conversations) {
      const convQuery = case_id
        ? "SELECT id, title, summary, content, tags, case_id, created_at FROM conversations WHERE case_id=? ORDER BY created_at DESC"
        : "SELECT id, title, summary, content, tags, case_id, created_at FROM conversations ORDER BY created_at DESC";
      const convs = case_id ? db.prepare(convQuery).all(case_id) : db.prepare(convQuery).all();

      if (convs.length) {
        lines.push("## Conversations (" + convs.length + ")");
        lines.push("");
        for (const c of convs) {
          const titleStr = decrypt(c.title) ?? "(unknown)";
          const caseTag = c.case_id ? " [case:" + c.case_id + "]" : "";
          lines.push("### " + titleStr + caseTag);
          lines.push("- ID: " + c.id);
          lines.push("- Created: " + c.created_at);
          lines.push("- Tags: " + (c.tags ?? "[]"));
          const summaryStr = decrypt(c.summary);
          if (summaryStr) {
            lines.push("- Summary: " + summaryStr);
          }
          lines.push("");
          // M6 fix: decrypt()がnull返却時に"[decryption failed]"に置換
          lines.push(decrypt(c.content) ?? "[decryption failed]");
          lines.push("");
          lines.push("---");
          lines.push("");
        }
      }
    }

    const md = lines.join("\n");
    writeFileSync(outPath, md, "utf-8");
    const noteCount = include_notes ? db.prepare("SELECT COUNT(*) as c FROM notes" + (case_id ? " WHERE case_id=?" : "")).get(...(case_id ? [case_id] : [])).c : 0;
    const convCount = include_conversations ? db.prepare("SELECT COUNT(*) as c FROM conversations" + (case_id ? " WHERE case_id=?" : "")).get(...(case_id ? [case_id] : [])).c : 0;
    return {
      content: [{
        type: "text",
        text: "📄 Exported to " + outPath + " (" + noteCount + " notes, " + convCount + " conversations, " + (md.length / 1024).toFixed(1) + "KB)",
      }],
    };
  }
);

// ─── context_gauge（セッション残量推定） ────────────────────────
server.tool("context_gauge",
  "Estimate remaining context window from hook-logged tool usage. / フックで記録したツール使用量からコンテキスト残量を推定。",
  {
    session_id: z.string().optional().describe("Session ID to check. If omitted, uses most recent session."),
    context_limit: z.number().optional().default(1_000_000).describe("Context window size in tokens (default: 1M)"),
  },
  ({ session_id, context_limit }) => {
    const gaugePath = join(homedir(), ".claude", "context-gauge.jsonl");
    if (!existsSync(gaugePath)) {
      return { content: [{ type: "text", text: "No context-gauge data yet. Hook may not have fired." }] };
    }

    const lines = readFileSync(gaugePath, "utf-8").trim().split("\n").filter(Boolean);
    const entries = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line)); } catch {}
    }

    if (entries.length === 0) {
      return { content: [{ type: "text", text: "context-gauge.jsonl is empty." }] };
    }

    // Find target session
    let sid = session_id;
    if (!sid) {
      // Use most recent session
      const latest = entries[entries.length - 1];
      sid = latest.sid;
    }

    const sessionEntries = entries.filter(e => e.sid === sid);
    if (sessionEntries.length === 0) {
      return { content: [{ type: "text", text: `No data for session ${sid}` }] };
    }

    // Accumulate
    let totalTokens = 0;
    let totalInputChars = 0;
    let totalOutputChars = 0;
    const toolCounts = {};
    for (const e of sessionEntries) {
      totalTokens += e.est_tk || 0;
      totalInputChars += e.in_c || 0;
      totalOutputChars += e.out_c || 0;
      toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
    }

    // Add overhead estimate: user prompts + assistant text not captured by tool hooks
    // Heuristic: tool I/O is ~60% of total context, multiply by 1.67
    const estimatedTotal = Math.ceil(totalTokens * 1.67);
    const remaining = Math.max(0, context_limit - estimatedTotal);
    const usedPct = ((estimatedTotal / context_limit) * 100).toFixed(1);
    const remainPct = ((remaining / context_limit) * 100).toFixed(1);

    // Top tools by count
    const topTools = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t, c]) => `${t}: ${c}`)
      .join(", ");

    const fmt = (n) => n.toLocaleString();
    const elapsed = sessionEntries.length > 0
      ? Math.round((sessionEntries[sessionEntries.length - 1].ts - sessionEntries[0].ts) / 60000)
      : 0;

    const text = [
      `📊 Context Gauge — ${fmt(estimatedTotal)} / ${fmt(context_limit)} tk (${usedPct}%)`,
      `   残り約 ${fmt(remaining)} tk (${remainPct}%)`,
      ``,
      `   Tool calls:   ${sessionEntries.length}`,
      `   Input chars:  ${fmt(totalInputChars)}`,
      `   Output chars: ${fmt(totalOutputChars)}`,
      `   Raw tool tk:  ${fmt(totalTokens)} (×1.67 overhead = ${fmt(estimatedTotal)})`,
      `   Elapsed:      ${elapsed} min`,
      `   Top tools:    ${topTools}`,
    ];

    if (estimatedTotal > context_limit * 0.75) {
      text.push(``, `⚠ 75%超過 — 大きな作業は避けること`);
    } else if (estimatedTotal > context_limit * 0.50) {
      text.push(``, `⚡ 50%超過 — 残量に注意`);
    }

    return { content: [{ type: "text", text: text.join("\n") }] };
  }
);

// ─── ベクトル自動補完（起動後に非同期・未ベクトル行のみ） ────────
// エンドポイント復旧後や過去データに対して人手のbackfill実行を不要にする。
// 多重起動対策: metaのタイムスタンプで10分間は他プロセスの実行を尊重する。
async function backfillMissingVectors(maxItems = 300) {
  if (!VECTOR_ENABLED) return;
  const last = Number(metaGet("backfill_ts") ?? 0);
  if (Date.now() - last < 10 * 60 * 1000) return;
  metaSet("backfill_ts", Date.now());

  // 疎通確認（落ちていれば即撤退）
  if (!(await getEmbedding("backfill probe", 3000))) return;

  const notes = db.prepare(`SELECT id, key, content FROM notes
    WHERE id NOT IN (SELECT id FROM vectors WHERE type='note') LIMIT ?`).all(maxItems);
  let done = 0;
  for (const n of notes) {
    await upsertVector("note", n.id, `${n.key ?? ""} ${decrypt(n.content)}`.slice(0, 8000));
    done++;
  }
  const convs = db.prepare(`SELECT id, title, summary, content FROM conversations
    WHERE id NOT IN (SELECT id FROM vectors WHERE type='conversation') LIMIT ?`).all(Math.max(0, maxItems - done));
  for (const c of convs) {
    await upsertVector("conversation", c.id,
      `${decrypt(c.title)} ${decrypt(c.summary) ?? ""} ${decrypt(c.content)}`.slice(0, 8000));
    done++;
  }
  if (done > 0) console.error(`[memory-mcp] vector backfill: ${done}件補完`);
}

// ─── 起動 ───────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
setTimeout(() => backfillMissingVectors().catch(() => {}), 3000);
