import { Effect, pipe } from "effect"
import * as FS from "node:fs/promises"
import "dotenv/config";

/* ---------- 型定義 ---------- */
interface GitHubIssue {
  title: string
  body: string | null
}
interface SearchIssuesResp {
  total_count: number
  incomplete_results: boolean
  items: GitHubIssue[]
}

/** 1 行分（DB 挿入用） */
export type IssueRow = {
  soupId:    string
  projectId: string
  title:     string
  body:      string
}

/** API の返却 */
export type IssueResponse = {
  count: number   // GitHub reported total_count
  query: string   // 実際に打った検索クエリ
  items: IssueRow[]
}

export interface GetIssuesArgs {
  soupId:    string
  projectId: string
  owner:     string
  repo:      string
  wantedN:   number
  labels?:   string[]
  version?:  string
}

/* ---------- ユーティリティ（CSV） ---------- */
const csvEscape = (s: string): string => {
  // RFC 4180 に準拠：ダブルクォート、カンマ、改行、先頭/末尾空白を含む場合はクォート
  const needsQuote = /[",\n\r]|^\s|\s$/.test(s)
  const escaped = s.replaceAll('"', '""')
  return needsQuote ? `"${escaped}"` : escaped
}

const rowsToCsv = (
  rows: IssueRow[],
  options?: { includeBom?: boolean; newline?: "\n" | "\r\n"; headers?: string[] }
): string => {
  const newline = options?.newline ?? "\r\n" // Excel 互換のためデフォルト CRLF
  const headers = options?.headers ?? ["soupId", "projectId", "title", "body"]
  const head = headers.map(csvEscape).join(",")
  const body = rows
    .map(r => [r.soupId, r.projectId, r.title, r.body].map(csvEscape).join(","))
    .join(newline)
  const csv = [head, body].join(newline)
  return (options?.includeBom ? "\uFEFF" : "") + csv
}

const writeFileEff = (path: string, data: string) =>
  Effect.tryPromise({
    try: () => FS.writeFile(path, data, { encoding: "utf8" }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e)))
  })

/* ---------- メイン ---------- */
export const getIssues = (
  token: string,
  {
    soupId,
    projectId,
    owner,
    repo,
    wantedN,
    labels = [],             // ← undefined 対策でデフォルト空配列
    version,
  }: GetIssuesArgs,
): Effect.Effect<never, Error, IssueResponse> => {
  /* ---- HTTP 共通ヘッダ ---- */
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  }

  /* ---- ラベルをクエリ文字列に ----
     label:"bug" label:"good first issue" … */
  const labelQuery = labels
    .filter((l) => l?.trim().length)
    .map((l) => `label:"${l!.trim()}"`)
    .join(" ")

  /* ---- 完整検索クエリ ---- */
  const query = [
    `repo:${owner}/${repo}`,
    "is:issue",
    "state:open",
    labelQuery,                          // ラベルが無い場合は空文字 → filter で消える
    "in:title,body",
    version ? `${version}` : "",
  ]
    .filter(Boolean)
    .join(" ")

  /* ---- ページネーション ---- */
  const maxPerPage = 100
  const pages = Math.ceil(Math.min(wantedN, 1000) / maxPerPage) // SearchAPI 上限

  const fetchPage = (page: number): Effect.Effect<never, Error, SearchIssuesResp> =>
    Effect.tryPromise({
      try: () =>
        fetch(
          `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&advanced_search=true&per_page=${maxPerPage}&page=${page}`,
          { headers },
        ).then(async (r) => {
          if (r.status !== 200) throw new Error(`Search API ${r.status}`)
          return (await r.json()) as SearchIssuesResp
        }),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    })

  const pageEffects = Array.from({ length: pages }, (_, i) => fetchPage(i + 1))

  /* ---- まとめて返却 ---- */
  return pipe(
    Effect.all(pageEffects),
    Effect.map((results): IssueResponse => {
      const [{ total_count, incomplete_results }] = results

      if (incomplete_results) {
        // 実運用では Logger に流すなど
        console.warn("GitHub Search API returned incomplete results.")
      }

      const items: IssueRow[] = results
        .flatMap((r) => r.items)
        .slice(0, wantedN)
        .map((it) => ({
          soupId,
          projectId,
          title: it.title,
          body: it.body ?? "",
        }))

      return { count: total_count, query, items }
    }),
  )
}

/* ---------- CSV 出力（純粋＋モナディック） ---------- */
/**
 * 取得→CSV 文字列化（副作用なし）
 */
export const getIssuesCsvString = (
  token: string,
  args: GetIssuesArgs,
  options?: { includeBom?: boolean; newline?: "\n" | "\r\n"; headers?: string[] }
): Effect.Effect<never, Error, { csv: string; response: IssueResponse }> =>
  pipe(
    getIssues(token, args),
    Effect.map((response) => ({
      csv: rowsToCsv(response.items, options),
      response,
    }))
  )

/**
 * 取得→CSV ファイル保存（副作用は Effect に閉じ込め、外からは純粋）
 */
export const writeIssuesCsvFile = (
  token: string,
  args: GetIssuesArgs,
  filePath: string,
  options?: { includeBom?: boolean; newline?: "\n" | "\r\n"; headers?: string[] }
): Effect.Effect<never, Error, { filePath: string; response: IssueResponse }> =>
  pipe(
    getIssuesCsvString(token, args, options),
    Effect.flatMap(({ csv, response }) =>
      pipe(
        writeFileEff(filePath, csv),
        Effect.as({ filePath, response })
      )
    )
  )

/* ---------- 使用例（参考：アプリ側で実行） ---------- */
// const program = writeIssuesCsvFile(
//   process.env.GH_TOKEN!,
//   { soupId: "S1", projectId: "P1", owner: "owner", repo: "repo", wantedN: 250, labels: ["bug", "good first issue"], version: "v2.0" },
//   "./issues.csv",
//   { includeBom: true }
// )
// Effect.runPromise(program).then(console.log, console.error)
