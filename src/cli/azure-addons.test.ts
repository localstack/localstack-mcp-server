import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { RunAz } from "../lib/azure/extension-install";
import { AZURE_EXTENSION_PINS } from "../lib/azure/extension-pins";
import type { AzureStepDeps } from "../lib/wizard/azure-steps";
import { runInstallAzureAddons } from "./azure-addons";

// `install-azure-addons`: what the Azure tool uses beside the Azure CLI itself. The user runs it,
// as they install the Snowflake CLI for the Snowflake tool; the setup wizard never does. az and
// the Bicep download are injected, and the home is a temporary directory, so the real
// ~/.localstack and ~/.azure are never touched.
describe("install-azure-addons", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-azure-addons-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function setup(over: Partial<AzureStepDeps> = {}) {
    const azCalls: string[][] = [];
    const run: RunAz = async (_file, args) => {
      azCalls.push(args);
      return { status: 0 };
    };
    const deps: AzureStepDeps = {
      platform: process.platform,
      arch: process.arch,
      homedir: home,
      env: {},
      locate: () => ({
        file: "/usr/bin/python3",
        prefixArgs: ["-X", "utf8", "-IBm", "azure.cli"],
        installer: "pip",
      }),
      run,
      pins: AZURE_EXTENSION_PINS,
      musl: false,
      installBicep: jest.fn(async () => ({ path: "/x/bicep", asset: "bicep-linux-x64" })),
      ...over,
    };
    const out: string[] = [];
    const err: string[] = [];
    const io = { deps, out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    return { deps, azCalls, out, err, io, text: () => [...out, ...err].join("\n") };
  }

  test("installs the 26 pinned extensions, then Bicep, and exits 0", async () => {
    const s = setup();
    expect(await runInstallAzureAddons([], s.io)).toBe(0);
    expect(s.azCalls).toHaveLength(26);
    expect(s.deps.installBicep).toHaveBeenCalledTimes(1);
    const dir = path.join(home, ".localstack", "azure", "mcp-extensions");
    expect(s.text()).toContain(`✓ 26 Azure CLI extensions in ${dir}`);
    expect(s.text()).toMatch(/✓ Bicep \d+\.\d+\.\d+ .*sha256 checked/);
    expect(s.err).toEqual([]);
  });

  test("without an Azure CLI it installs nothing and says how to install az, as for snow", async () => {
    const s = setup({
      locate: () => {
        throw new Error("no az");
      },
    });
    expect(await runInstallAzureAddons([], s.io)).toBe(1);
    const said = s.err.join("\n");
    expect(said).toMatch(/The Azure CLI \(az\) was not found/);
    expect(said).toContain("2.85 or newer");
    expect(said).toContain("winget install --exact --id Microsoft.AzureCLI");
    expect(said).toContain("brew install azure-cli");
    expect(said).toContain("curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash");
    expect(said).toContain("https://learn.microsoft.com/cli/azure/install-azure-cli");
    expect(said).toMatch(/run this command again/);
    expect(s.azCalls).toEqual([]);
    expect(s.deps.installBicep).not.toHaveBeenCalled();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  test("--no-bicep installs only the extensions; --no-extensions only Bicep", async () => {
    const onlyExtensions = setup();
    expect(await runInstallAzureAddons(["--no-bicep"], onlyExtensions.io)).toBe(0);
    expect(onlyExtensions.azCalls).toHaveLength(26);
    expect(onlyExtensions.deps.installBicep).not.toHaveBeenCalled();

    const onlyBicep = setup();
    expect(await runInstallAzureAddons(["--no-extensions"], onlyBicep.io)).toBe(0);
    expect(onlyBicep.azCalls).toEqual([]);
    expect(onlyBicep.deps.installBicep).toHaveBeenCalledTimes(1);
  });

  test("a failed step exits 1 and says which one, with the installer's message", async () => {
    const s = setup({
      installBicep: jest.fn(async () => {
        throw new Error("the downloaded bicep has sha256 abc, not the pinned def");
      }),
    });
    expect(await runInstallAzureAddons([], s.io)).toBe(1);
    expect(s.text()).toContain("✗ Bicep: the downloaded bicep has sha256 abc, not the pinned def");
    expect(s.azCalls).toHaveLength(26);
  });

  test("--help prints the usage and installs nothing", async () => {
    const s = setup();
    expect(await runInstallAzureAddons(["--help"], s.io)).toBe(0);
    expect(s.text()).toContain("install-azure-addons");
    expect(s.azCalls).toEqual([]);
    expect(s.deps.installBicep).not.toHaveBeenCalled();
  });

  test("an unknown option is an error and installs nothing", async () => {
    const s = setup();
    expect(await runInstallAzureAddons(["--azure-extensions"], s.io)).toBe(1);
    expect(s.err.join("\n")).toMatch(/Unknown option/);
    expect(s.azCalls).toEqual([]);
  });
});
