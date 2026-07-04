#!/usr/bin/env node
// スモークテスト: stdio経由で主要ツールを検証する。
//   TEST_DIR=$(mktemp -d) node test-smoke.mjs
// フィクスチャは全てテスト内で作成する（実データ・実DB非依存。空ディレクトリでよい）。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const TEST_DIR = process.env.TEST_DIR;
if (!TEST_DIR) { console.error("TEST_DIR を指定してください"); process.exit(1); }

const HERE = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(HERE, "index.js")],
  env: { ...process.env, MEMORY_MCP_DIR: TEST_DIR },
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });
await client.connect(transport);

const RUN = Date.now().toString(36); // 再実行しても新規作成になるよう一意化
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return r.content?.[0]?.text ?? "";
}

// 1. ツール一覧
const tools = (await client.listTools()).tools.map(t => t.name);
check("merge_cases がツール一覧に存在", tools.includes("merge_cases"), tools.join(","));
check("ツール数 22", tools.length === 22, `actual: ${tools.length}`);

// 2. stats: ベクトルがenv無しでも有効（ローカルollamaフォールバック）
const stats = await call("memory_stats");
check("stats: EMBEDDING_API_KEY未設定と表示されない", !stats.includes("未設定"), stats);
check("stats: ベクトルcoverage表記 (n/m件)", /ベクトル: \d+\/\d+件/.test(stats), stats);
const statsHealthy = stats.includes("✅") && stats.includes("@");
console.log(statsHealthy ? "[info] embedding endpoint: OK" : "[info] embedding endpoint: DOWN（FTSのみで続行）");

// 3. フィクスチャ投入 → AND完全一致検索
await call("save_note", { key: "smoke-fts-target", content: "リリース手順の整理。デプロイ前チェックリストを更新した。" });
const s1 = await call("search_memory", { query: "リリース手順 チェックリスト" });
check("複数語AND検索でヒット", s1.includes("smoke-fts-target"), s1.slice(0, 300));

// 4. AND→OR段階緩和: 存在しない語を混ぜても取り零さない
const s2 = await call("search_memory", { query: "リリース手順 qqzzのような未知語x" });
check("OR緩和でヒット", s2.includes("smoke-fts-target"), s2.slice(0, 300));
check("OR緩和が明示される", s2.includes("緩和"), s2.slice(0, 120));

// 5. 短語(3文字未満)LIKEがkey列も見る: 本文にキー文字列を含めない
await call("save_note", { key: "z9-smoke", content: "スモークテスト用の一時メモ（本文にキー文字列は含まれない）" });
const s3 = await call("search_memory", { query: "z9" });
check("短語(2文字)検索が key 列にヒット", s3.includes("z9-smoke"), s3.slice(0, 300));

// 6. rag_query が緩和込みで全文を返す
const r1 = await call("rag_query", { query: "リリース手順 qqzzのような未知語x", limit: 3 });
check("rag_query 緩和で本文が返る", r1.includes("チェックリスト") && !r1.includes("見つかりませんでした"), r1.slice(0, 200));

// 7. save_case_note の類似案件警告
await call("save_case_note", { case_id: `smoke-alpha-case-${RUN}`, case_name: "スモークA", content: "類似警告テスト元" });
const c1 = await call("save_case_note", { case_id: `smoke_alpha_case_${RUN}b`, case_name: "スモークA2", content: "類似警告テスト" });
check("類似案件の警告が出る", c1.includes("類似案件"), c1);

// 8. merge_cases + merged_into リダイレクト
await call("save_case_note", { case_id: `smoke-merge-src-${RUN}`, case_name: "統合元", content: "移動対象メモ" });
await call("save_case_note", { case_id: `smoke-merge-dst-${RUN}`, case_name: "統合先", content: "先住メモ" });
const m1 = await call("merge_cases", { from_case_id: `smoke-merge-src-${RUN}`, to_case_id: `smoke-merge-dst-${RUN}` });
check("merge_cases 実行", m1.includes("統合") && m1.includes("メモ1件"), m1);
const m2 = await call("merge_cases", { from_case_id: "no-such-case-xyz", to_case_id: `smoke-merge-dst-${RUN}` });
check("merge_cases 不存在エラー", m2.includes("存在しません"), m2);
const cases = await call("list_cases", {});
check("統合元がactive一覧から消える", !cases.includes(`smoke-merge-src-${RUN}:`), cases.slice(0, 400));
const c2 = await call("save_case_note", { case_id: `smoke-merge-src-${RUN}`, content: "旧IDへの保存テスト" });
check("旧IDへの保存が統合先へ転送される", c2.includes(`smoke-merge-dst-${RUN}`) && c2.includes("統合済み"), c2);
const g1 = await call("get_case", { case_id: `smoke-merge-src-${RUN}` });
check("旧IDのget_caseが統合先を表示", g1.includes(`smoke-merge-dst-${RUN}`), g1.slice(0, 200));

// 9. invalidate_note を同一メモに2回（UNIQUE衝突でクラッシュしないこと）
await call("save_note", { key: "smoke-invalidate-target", content: "無効化テスト対象" });
const i1 = await call("invalidate_note", { key: "smoke-invalidate-target", reason: "理由その1" });
const i2 = await call("invalidate_note", { key: "smoke-invalidate-target", reason: "理由その2（再無効化）" });
check("invalidate 1回目", i1.includes("無効化しました"), i1);
check("invalidate 2回目（衝突しない）", i2.includes("無効化しました"), i2);

// 10. 会話の保存→削除
const sv = await call("save_conversation", { title: "スモーク会話", content: "会話本文テスト。削除対象。" });
const convId = Number((sv.match(/id:(\d+)/) ?? [])[1]);
check("save_conversation", Number.isFinite(convId), sv);
const del = await call("delete_conversation", { id: convId });
check("delete_conversation", del.includes("削除しました"), del);

// 11. semantic_search（endpoint稼働時のみ）
if (statsHealthy) {
  await call("save_note", { key: "smoke-semantic-target", content: "認証フローをOAuth2に移行する設計判断を記録する" });
  const sem = await call("semantic_search", { query: "ログイン方式の変更", limit: 3 });
  check("semantic_search が結果を返す", sem.includes("類似度"), sem.slice(0, 300));
} else {
  console.log("[skip] semantic_search（endpoint down）");
}

// 12. 空クエリガード
const s4 = await call("search_memory", { query: "   " });
check("空クエリでSQLエラーにならない", s4.includes("検索語"), s4);

console.log("\n=== 結果 ===");
console.log(results.join("\n"));
console.log(`\nPASS: ${pass} / FAIL: ${fail}`);
await client.close();
process.exit(fail ? 1 : 0);
