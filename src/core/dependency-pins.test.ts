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

    for (const command of commands.filter((c) => /\buv sync\b/.test(c))) {
      expect(command).toContain("--locked");
    }
    for (const command of commands.filter((c) =>
      /\b(pip install|uv (pip|tool) install|uvx|npm (install|i|add)|yarn add|npx)\b/.test(c)
    )) {
      throw new Error(`install from a lockfile ("npm ci") instead of: ${command.trim()}`);
    }
    for (const command of commands.filter((c) => /\byarn install\b/.test(c))) {
      expect(command).toContain("--frozen-lockfile");
    }
    // A version in an ARG is invisible to Dependabot; put it in a manifest or a FROM line.
    expect(instructions.filter((line) => /^ARG\s+\w*VERSION\b/i.test(line))).toEqual([]);
  });

  it("runs CI and the image builds on one pinned Ubuntu release for every architecture", () => {
    // Runners are either a literal label or `${{ matrix.runner }}`, whose values are checked
    // as literals; any other expression could hide an unpinned label.
    const docker = read(".github/workflows/docker.yml");
    const workflow = [
      docker,
      read(".github/workflows/ci.yml"),
      read(".github/workflows/mcp-evals.yml"),
    ].join("\n");
    for (const [, value] of workflow.matchAll(/^[ \t]*runs-on:[ \t]*(.*)$/gm)) {
      if (value.startsWith("${{")) expect(value).toBe("${{ matrix.runner }}");
    }
    const labels = [...workflow.matchAll(/^[ \t]*(?:-[ \t]*)?(?:runs-on|runner):[ \t]*(.*)$/gm)]
      .map((match) => match[1].trim())
      .filter((label) => label !== "${{ matrix.runner }}");

    for (const label of labels) {
      expect(label).toMatch(/^ubuntu-\d+\.\d+(-arm)?$/);
    }
    expect(new Set(labels.map((label) => label.replace(/-arm$/, ""))).size).toBe(1);
    expect(docker).toMatch(/^[ \t]*(?:-[ \t]*)?runner:[ \t]*ubuntu-[\d.]+-arm[ \t]*$/m);
  });

  it("takes Terraform and uv versions in workflows from the Dockerfile's FROM lines", () => {
    // Dependabot bumps the FROM lines but not action inputs, so a literal version would drift.
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/^FROM hashicorp\/terraform:\S+/m);
    expect(dockerfile).toMatch(/^FROM ghcr\.io\/astral-sh\/uv:\S+/m);

    // Without its version input, each action installs the latest release. Steps are split at
    // their leading "- ", so a step's inputs may come in any order.
    const inputs = {
      "hashicorp/setup-terraform": "terraform_version",
      "astral-sh/setup-uv": "version",
    };
    for (const file of fs.readdirSync(path.join(ROOT, ".github/workflows"))) {
      for (const step of read(`.github/workflows/${file}`).split(/^[ \t]*- /m)) {
        for (const [action, input] of Object.entries(inputs)) {
          if (!new RegExp(`uses:[ \\t]*${action}@`).test(step)) continue;
          const version = step.match(new RegExp(`^[ \\t]*${input}:[ \\t]*(.*)$`, "m"))?.[1];
          expect(`${file} ${action}: ${version}`).toMatch(
            /: \$\{\{ steps\.\w+\.outputs\.\w+ \}\}$/
          );
        }
      }
    }
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
