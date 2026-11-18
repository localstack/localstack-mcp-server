import fs from "fs";
import path from "path";

// Dependabot updates each version in exactly one place (see .github/dependabot.yml). These
// checks catch the places it cannot keep in sync: Node's major line, which the Dockerfile,
// the workflows and esbuild's target must share, and installs that bypass the lockfiles.

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

// Joins backslash-continued lines so each Dockerfile instruction is one string.
const dockerfileInstructions = () =>
  read("Dockerfile")
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"));

const nodeImageTags = () =>
  dockerfileInstructions()
    .filter((line) => /^FROM\b/.test(line))
    .map((line) => line.match(/\bnode:(\S+)/)?.[1])
    .filter((tag): tag is string => tag !== undefined);

const workflowNodeVersions = () =>
  fs
    .readdirSync(path.join(ROOT, ".github/workflows"))
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      [...read(`.github/workflows/${file}`).matchAll(/node-version:\s*["']?([^"'\s]+)/g)].map(
        (match) => ({ file, version: match[1] })
      )
    );

describe("dependency pins", () => {
  it("builds every Dockerfile stage from the same exact node image", () => {
    const tags = nodeImageTags();

    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tags).size).toBe(1);
    expect(tags[0]).toMatch(/^\d+\.\d+\.\d+-bookworm-slim$/);
  });

  it("runs CI and esbuild on the Dockerfile's node major", () => {
    const major = nodeImageTags()[0].split(".")[0];
    const versions = workflowNodeVersions();

    expect(versions.length).toBeGreaterThan(0);
    for (const { file, version } of versions) {
      expect(`${file}: ${version.split(".")[0]}`).toBe(`${file}: ${major}`);
    }
    expect(JSON.parse(read("package.json")).scripts["build:cli"]).toContain(
      `--target=node${major} `
    );
  });

  it("installs image tools only from lockfiles", () => {
    const instructions = dockerfileInstructions();
    const commands = instructions
      .filter((line) => /^RUN\b/.test(line))
      .flatMap((line) => line.split(/&&|;/));

    for (const command of commands.filter((c) => /\bpip install\b/.test(c))) {
      expect(command).toContain("--require-hashes");
      expect(command).toMatch(/-r\s+\S+requirements\.txt/);
    }
    for (const command of commands.filter((c) => /\b(npm (install|i|add)|yarn add|npx)\b/.test(c))) {
      throw new Error(`install from a lockfile ("npm ci") instead of: ${command.trim()}`);
    }
    for (const command of commands.filter((c) => /\byarn install\b/.test(c))) {
      expect(command).toContain("--frozen-lockfile");
    }
    // A version in an ARG is invisible to Dependabot; put it in a manifest or a FROM line.
    expect(instructions.filter((line) => /^ARG\s+\w*VERSION\b/i.test(line))).toEqual([]);
  });

  it("installs CI dependencies from the same frozen lockfile as the image", () => {
    for (const file of fs.readdirSync(path.join(ROOT, ".github/workflows"))) {
      for (const match of read(`.github/workflows/${file}`).matchAll(/run:\s*(yarn\b.*)/g)) {
        const command = match[1];
        if (/^yarn\s*$|^yarn\s+install\b/.test(command)) {
          expect(`${file}: ${command}`).toContain("--frozen-lockfile");
        }
      }
    }
  });
});
