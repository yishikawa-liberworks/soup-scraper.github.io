# soup\_scraper\_local — README (.env 版)

GitHub の Issues を **CSV にエクスポート**し、その CSV を **OpenAI で日本語翻訳した CSV** に変換するツール群です。環境変数は `.env` から読み込みます。

---

## 構成

* `src/issues.ts` … GitHub → CSV ライブラリ（Effect/TS, 純粋＋モナディック）
* `src/run.ts` … 取得＆CSV保存の実行用スクリプト（任意名）
* `src/csv-translate.ts` … CSV → 日本語翻訳 CSV の CLI
* `issues.csv` / `issues_ja.csv` … 出力例

---

## 必要要件

* Node.js **18+**（推奨 20+）
* 依存パッケージ

  ```bash
  npm i effect openai
  npm i -D tsx typescript @types/node csv-parse dotenv
  ```


---

## .env の用意

プロジェクト直下に `.env` を作成：

```
GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```


## 実行

### 1) GitHub Issues → CSV（src/run.ts）
PowerShell 実行例

```powershell
# 事前に .env をプロジェクト直下へ
npx tsx .\src\run.ts --owner vercel --repo next.js --wantedN 200 --labels "bug" --version v14 --out .\issues.csv --bom                  
# → issues.csv を生成
```

引数

--owner（必須）: GitHub リポジトリのオーナー（例: vercel）

--repo（必須）: リポジトリ名（例: next.js）

--wantedN : 取得件数（既定: 200、Search API 上限 1000）

--labels : カンマ区切りのラベル（例: "bug,good first issue"）

--version : 任意のキーワード（例: v14）

--soup : CSV列 soupId に入る値（既定: S1）

--project : CSV列 projectId に入る値（既定: P1）

--out : 出力 CSV パス（既定: ./issues.csv）

--lf : 改行を LF に（既定は CRLF）

--bom : UTF-8 BOM を付与（Excel 互換）

出力 CSV の列: soupId,projectId,title,body


---

### 2) CSV → 日本語翻訳 CSV（src/csv-translate.ts）
PowerShell 実行例
```powershell
npx tsx .\src\csv-translate.ts --in .\issues.csv --out .\issues_ja.csv --bom --concurrency 5
```

引数

--in, -i（必須）: 入力 CSV パス

--out, -o（必須）: 出力 CSV パス

--concurrency, -c : 並列翻訳数（既定: 5）

--model, -m : OpenAI モデル（既定: gpt-4o-mini）

--temp, -t : 温度（既定: 0.2）

--newline : lf / crlf（既定: crlf）

--bom : UTF-8 BOM 付与（フラグ）

入力 CSV の想定列: soupId,projectId,title,body
title/body がない場合、フォールバックとして summary/first_comment を参照します。
出力 CSV の列: 既存列 + titleJa,bodyJa

## 入力／出力 CSV の仕様

* 入力：既定は `soupId,projectId,title,body` を想定。足りない場合は `summary` / `first_comment` を自動フォールバック。
* 出力：**元の列 + `titleJa, bodyJa`** を追加。RFC4180 準拠のエスケープ、CRLF、BOM（任意）。


