/**
 * Launcher for the published bin. With no recognized subcommand it starts the
 * MCP server exactly as before (dist/stdio.js), so every existing client
 * config keeps working. `init`/`remove` run the setup wizard.
 */
import * as fs from "fs";
import * as path from "path";

function getVersion(): string {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
    );
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case "init": {
      const { runInit } = await import("./init");
      process.exit(await runInit(process.argv.slice(3)));
      break;
    }
    case "remove": {
      const { runRemove } = await import("./remove");
      process.exit(await runRemove(process.argv.slice(3)));
      break;
    }
    case "help":
    case "--help":
    case "-h": {
      const { HELP_TEXT } = await import("./help");
      console.log(HELP_TEXT);
      process.exit(0);
      break;
    }
    case "version":
    case "--version":
    case "-v": {
      console.log(getVersion());
      process.exit(0);
      break;
    }
    default:
      // Anything else (including no args) starts the MCP server, matching the
      // pre-wizard behavior for MCP clients that launch this bin. A stderr
      // hint covers typos like "innit" — MCP hosts ignore stderr.
      if (command !== undefined) {
        console.error(
          `Unknown command "${command}" — starting the MCP server. Did you mean "init"? See --help for setup commands.`
        );
      }
      require("./stdio.js");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
