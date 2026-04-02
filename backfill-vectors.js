#!/usr/bin/env node
// 既存メモ・会話にベクトルを一括付与するスクリプト
import { DatabaseSync } from "node:sqlite";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { createDecipheriv } from "node:crypto";

const DATA_DIR = join(homedir(), ".memory-mcp");
const DB_PATH = join(DATA_DIR, "memory.db");
const KEY_PATH = join(DATA_DIR, ".key");

const EMBEDDING_URL = process.env.EMBEDDING_URL ?? "http://localhost:11434/v1/embeddings";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? "nomic-embed-text";
const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY ?? "ollama";

const ENC_KEY = readFileSync(KEY_PATH);

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
    return b64;
  }
}

function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

async function getEmbedding(text) {
  const res = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
  });
  if (!res.ok) {
    console.error(`  ✗ API error: ${res.status}`);
    return null;
  }
  const json = await res.json();
  return json.data?.[0]?.embedding ?? null;
}

const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA busy_timeout = 30000`);

// vectorsテーブル確認
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

const upsert = db.prepare(`
  INSERT INTO vectors(type, id, embedding, model) VALUES(?,?,?,?)
  ON CONFLICT(type, id) DO UPDATE SET embedding=excluded.embedding, model=excluded.model,
  created_at=datetime('now','localtime')
`);

// 既存ベクトル確認
const existingVecs = new Set(
  db.prepare(`SELECT type || ':' || id as k FROM vectors`).all().map(r => r.k)
);

const notes = db.prepare(`SELECT id, key, content FROM notes`).all();
const convs = db.prepare(`SELECT id, title, summary, content FROM conversations`).all();

const total = notes.length + convs.length;
const skip = [...notes.map(n => `note:${n.id}`), ...convs.map(c => `conversation:${c.id}`)]
  .filter(k => existingVecs.has(k)).length;

console.log(`\n📊 Backfill: ${total}件 (既存ベクトル: ${skip}件)\n`);

let done = 0;
let errors = 0;

for (const n of notes) {
  const key = `note:${n.id}`;
  if (existingVecs.has(key)) { done++; continue; }
  const text = `${n.key ?? ""} ${decrypt(n.content)}`;
  const keyName = n.key ?? "(無題)";
  process.stdout.write("  [" + (++done) + "/" + total + "] メモ id:" + n.id + ' "' + keyName + '"...');
  const vec = await getEmbedding(text);
  if (vec) {
    upsert.run("note", n.id, vecToBlob(vec), EMBEDDING_MODEL);
    console.log(" ✓");
  } else {
    errors++;
    console.log(" ✗");
  }
}

for (const c of convs) {
  const key = `conversation:${c.id}`;
  if (existingVecs.has(key)) { done++; continue; }
  const text = (decrypt(c.title) + " " + (decrypt(c.summary) ?? "") + " " + decrypt(c.content)).slice(0, 8000);
  const titleStr = decrypt(c.title) ?? "(不明)";
  process.stdout.write("  [" + (++done) + "/" + total + "] 会話 id:" + c.id + ' "' + titleStr + '"...');
  const vec = await getEmbedding(text);
  if (vec) {
    upsert.run("conversation", c.id, vecToBlob(vec), EMBEDDING_MODEL);
    console.log(" ✓");
  } else {
    errors++;
    console.log(" ✗");
  }
}

const finalCount = db.prepare(`SELECT COUNT(*) as c FROM vectors`).get().c;
console.log(`\n✅ 完了: ${finalCount}件のベクトル保存済み (エラー: ${errors}件)\n`);
