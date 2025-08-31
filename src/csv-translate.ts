#!/usr/bin/env -S node --no-warnings
import "dotenv/config";
import { Effect, pipe } from "effect";
import OpenAI from "openai";
import * as fs from "node:fs/promises";
import { parse as csvParse } from "csv-parse/sync";
import path from "node:path";

/* ====== args ====== */
const argv = process.argv.slice(2);
const has = (k: string, a?: string) => argv.includes(k) || (a ? argv.includes(a) : false);
const val = (k: string, a?: string, def?: string) => {
  const i = argv.findIndex((x) => x === k || x === a);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};

const showHelp = () => {
  console.log(
`CSV Translator CLI

Usage:
  tsx src/csv-translate.ts --in ./issues.csv --out ./issues_ja.csv [options]

Options:
  --in,  -i   Input CSV path (required)
  --out, -o   Output CSV path (required)
  --concurrency, -c  Parallel translations (default 5)
  --model, -m  OpenAI model (default gpt-4o-mini)
  --temp, -t   Temperature (default 0.2)
  --newline     lf | crlf  (default crlf)
  --bom         Include UTF-8 BOM (flag)
  -h, --help    Show help`
  );
};

if (has("-h", "--help")) { showHelp(); process.exit(0); }

const input = val("--in", "-i");
const output = val("--out", "-o");
if (!input || !output) { showHelp(); process.exit(1); }

const concurrency  = parseInt(val("--concurrency", "-c", "5")!, 10);
const model        = val("--model", "-m", "gpt-4o-mini")!;
const temperature  = parseFloat(val("--temp", "-t", "0.2")!);
const newlineOpt   = (val("--newline") ?? "crlf").toLowerCase();
const newline      = newlineOpt === "lf" ? "\n" : "\r\n";
const includeBom   = has("--bom");
const apiKey       = process.env.OPENAI_API_KEY ?? "";
if (!apiKey) { console.error("❌ OPENAI_API_KEY is required"); process.exit(2); }

/* ====== helpers (pure) ====== */
const SYSTEM_PROMPT = (
  "You are a professional Japanese translator.\n" +
  "Return ONLY translated text, no explanation.\n" +
  "Format: first line = translated title, blank line, then translated body."
).trim();

const csvEscape = (s: string): string => {
  const needsQuote = /[",\n\r]|\s$|^\s/.test(s);
  const escaped = s.replaceAll('"', '""');
  return needsQuote ? `"${escaped}"` : escaped;
};

const toCsv = (rows: Record<string, string>[], headers: string[], opt: { includeBom: boolean; newline: string }) => {
  const head = headers.map(csvEscape).join(",");
  const body = rows.map(r => headers.map(h => csvEscape(String(r[h] ?? ""))).join(",")).join(opt.newline);
  const csv = [head, body].join(opt.newline);
  return (opt.includeBom ? "\uFEFF" : "") + csv;
};

const readFileEff  = (p: string) => Effect.tryPromise({ try: () => fs.readFile(p, "utf8"), catch: toErr });
const writeFileEff = (p: string, d: string) => Effect.tryPromise({ try: () => fs.writeFile(p, d, "utf8"), catch: toErr });
function toErr(e: unknown) { return e instanceof Error ? e : new Error(String(e)); }

/* ====== main (wrap everything; no top-level await) ====== */
async function main() {
  const inAbs  = path.resolve(input!);
  const outAbs = path.resolve(output!);

  console.log([
    "🚀 csv-translate starting",
    ` in : ${inAbs}`,
    ` out: ${outAbs}`,
    ` model=${model} temp=${temperature}`,
    ` concurrency=${concurrency} newline=${newlineOpt} bom=${includeBom}`,
  ].join("\n"));

  // 入力存在チェック（async 関数内なので OK）
  try {
    const st = await fs.stat(inAbs);
    console.log(`📄 input exists (${st.size} bytes)`);
  } catch {
    console.error(`❌ input not found: ${inAbs}`);
    process.exit(3);
  }

  const client = new OpenAI({ apiKey });
  const translateOne = (title: string, body: string) =>
    Effect.tryPromise({
      try: async () => {
        const res = await client.chat.completions.create({
          model,
          temperature,
          max_tokens: 2048,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: `TITLE:\n${title}\n\nBODY:\n${body}` },
          ],
        });
        const txt = res.choices[0]?.message?.content ?? "";
        const [first, ...rest] = txt.split(/\n{2,}/);
        return { titleJa: (first ?? "").trim(), bodyJa: rest.join("\n\n").trim() };
      },
      catch: toErr,
    });

  type Row = Record<string, string>;

  const program = pipe(
    readFileEff(inAbs),
    Effect.map((text) => csvParse(text, { columns: true, skip_empty_lines: true, bom: true }) as Row[]),
    Effect.flatMap((rows) => {
      if (!rows.length) return Effect.succeed({ rows, headers: [] as string[] });
      const known = ["soupId","projectId","title","body"];
      const extra = Object.keys(rows[0]).filter(k => !known.includes(k));
      const headers = [...known.filter(k => k in rows[0]), ...extra, "titleJa","bodyJa"];

      let done = 0; const total = rows.length; const LOG_EVERY = Math.max(10, Math.floor(total / 20));
      console.log(`🔍 rows: ${total}, headers: ${headers.join(", ")}`);

      return pipe(
        Effect.forEach(
          rows,
          (r) => {
            const title = r.title ?? r.summary ?? "";
            const body  = r.body  ?? r.first_comment ?? "";
            if (!title && !body) {
              done++; if (done % LOG_EVERY === 0 || done === total) process.stdout.write(`\r📦 ${done}/${total}`);
              return Effect.succeed({ ...r, titleJa: "", bodyJa: "" });
            }
            return pipe(
              translateOne(title, body),
              Effect.map(({ titleJa, bodyJa }) => ({ ...r, titleJa, bodyJa })),
              Effect.tap(() => { done++; if (done % LOG_EVERY === 0 || done === total) process.stdout.write(`\r📦 ${done}/${total}`); })
            );
          },
          { concurrency }
        ),
        Effect.map((translated) => ({ rows: translated as Row[], headers }))
      );
    }),
    Effect.flatMap(({ rows, headers }) => writeFileEff(outAbs, toCsv(rows, headers, { includeBom, newline }))),
    Effect.as({ input: inAbs, output: outAbs })
  );

  await Effect.runPromise(program);
  process.stdout.write("\n");
  console.log("✅ Done");
  console.log("   in :", inAbs);
  console.log("   out:", outAbs);
}

main().catch((e) => { console.error("💥 Failed:", e); process.exit(1); });
process.on("unhandledRejection", (r) => console.error("UNHANDLED REJECTION:", r));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));
