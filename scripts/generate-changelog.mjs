import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument?.startsWith("--")) {
    args.set(argument.slice(2), process.argv[index + 1]);
    index += 1;
  }
}

const desktopPackage = JSON.parse(
  NodeFS.readFileSync(NodePath.join(repoRoot, "apps", "desktop", "package.json"), "utf8"),
);
const requestedVersion = String(args.get("version") ?? `v${desktopPackage.version}`);
const version = requestedVersion.replace(/^v/, "");
const outputPath = NodePath.resolve(
  repoRoot,
  String(args.get("out") ?? NodePath.join("release", `CHANGELOG-v${version}.md`)),
);
const changelogPath = NodePath.join(repoRoot, "CHANGELOG.md");
const changelog = NodeFS.readFileSync(changelogPath, "utf8").replace(/\r\n/g, "\n");
const lines = changelog.split("\n");
const heading = /^##\s+\[?v?([0-9]+(?:\.[0-9]+){2}(?:[-+][^\]\s]+)?)\]?(?:\s+-.*)?\s*$/i;

let section = "";
for (let index = 0; index < lines.length; index += 1) {
  const match = lines[index]?.match(heading);
  if (match?.[1] !== version) continue;
  let end = lines.length;
  for (let next = index + 1; next < lines.length; next += 1) {
    if (/^##\s+/.test(lines[next] ?? "")) {
      end = next;
      break;
    }
  }
  section = lines.slice(index, end).join("\n").trim();
  break;
}

if (!section) {
  throw new Error(`CHANGELOG.md has no section for ${version}.`);
}

NodeFS.mkdirSync(NodePath.dirname(outputPath), { recursive: true });
NodeFS.writeFileSync(outputPath, `${section}\n`);
console.log(outputPath);
