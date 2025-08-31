import { Effect } from "effect";
import { writeIssuesCsvFile } from "./issues";
import "dotenv/config";

const token = process.env.GH_TOKEN!;
const args = {
  soupId: "S1",
  projectId: "P1",
  owner: "vercel",
  repo: "next.js",
  wantedN: 200,
  labels: ["bug"],
  version: "" // 任意。不要なら消してOK
} as const;

const program = writeIssuesCsvFile(token, args, "./issues.csv", { includeBom: true });

Effect.runPromise(program).then(({ filePath, response }) => {
  console.log("Saved:", filePath);
  console.log("Query:", response.query);
  console.log("Total (reported):", response.count);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
