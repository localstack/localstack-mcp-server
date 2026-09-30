import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BICEP_ASSETS,
  BICEP_VERSION,
  bicepAssetFor,
  bicepInstallDir,
  bicepInstallPath,
  installBicep,
  type BicepAsset,
  type Download,
} from "./bicep-install";

// The Bicep step. Every install goes into a temporary home: the real
// ~/.localstack is never touched, and nothing is downloaded (the download is injected).

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const bytes =
  (s: string): Download =>
  async () =>
    (async function* () {
      // two chunks, so the hash is computed across chunk boundaries
      yield Buffer.from(s.slice(0, 3));
      yield Buffer.from(s.slice(3));
    })();

describe("bicepAssetFor", () => {
  test.each([
    ["win32", "x64", false, "bicep-win-x64.exe"],
    ["win32", "arm64", false, "bicep-win-arm64.exe"],
    ["linux", "x64", false, "bicep-linux-x64"],
    ["linux", "x64", true, "bicep-linux-musl-x64"],
    ["linux", "arm64", false, "bicep-linux-arm64"],
    ["darwin", "x64", false, "bicep-osx-x64"],
    ["darwin", "arm64", false, "bicep-osx-arm64"],
  ] as const)("%s/%s (musl %s) is %s, from the pinned release", (platform, arch, musl, asset) => {
    const found = bicepAssetFor(platform, arch, { musl });
    expect(found?.asset).toBe(asset);
    expect(found?.url).toBe(
      `https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/${asset}`
    );
    expect(found?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("no pinned build: undefined (the wizard then says so)", () => {
    expect(bicepAssetFor("freebsd", "x64")).toBeUndefined();
    expect(bicepAssetFor("linux", "ia32")).toBeUndefined();
    expect(bicepAssetFor("linux", "arm64", { musl: true })).toBeUndefined();
  });

  test("the Linux sha256 values equal the Dockerfile's ADD --checksum pins", () => {
    const dockerfile = fs.readFileSync(path.join(__dirname, "../../../Dockerfile"), "utf8");
    const pins = [...dockerfile.matchAll(/--checksum=sha256:([0-9a-f]{64})[^\n]*\n\s*(\S+)/g)].map(
      (m) => [m[2].split("/").pop(), m[1]]
    );
    expect(Object.fromEntries(pins)).toEqual({
      "bicep-linux-x64": BICEP_ASSETS["linux-x64"].sha256,
      "bicep-linux-arm64": BICEP_ASSETS["linux-arm64"].sha256,
    });
    expect(dockerfile).toContain(`/download/v${BICEP_VERSION}/`);
  });
});

describe("the install target", () => {
  test("is ~/.localstack/azure/bin, never ~/.azure/bin", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const home = platform === "win32" ? "C:\\Users\\me" : "/home/me";
      const target = bicepInstallPath(home, platform);
      const segments = target.split(/[\\/]/);
      expect(segments).not.toContain(".azure");
      expect(segments.slice(-4)).toEqual([
        ".localstack",
        "azure",
        "bin",
        platform === "win32" ? "bicep.exe" : "bicep",
      ]);
      expect(target.startsWith(bicepInstallDir(home, platform))).toBe(true);
    }
  });
});

describe("installBicep", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "lsmcp-bicep-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const platform = process.platform;
  const key = `${platform}-${process.arch}`;
  const table = (content: string): Record<string, BicepAsset> => ({
    [key]: { asset: "bicep-test", sha256: sha(Buffer.from(content)) },
  });
  const binDir = () => bicepInstallDir(home, platform);

  test("a matching download is installed at the target, executable, with nothing left over", async () => {
    const result = await installBicep({
      platform,
      arch: process.arch,
      homedir: home,
      download: bytes("fake-bicep-binary"),
      assets: table("fake-bicep-binary"),
    });
    expect(result.path).toBe(bicepInstallPath(home, platform));
    expect(fs.readFileSync(result.path, "utf8")).toBe("fake-bicep-binary");
    expect(fs.readdirSync(binDir())).toEqual([path.basename(result.path)]);
    if (platform !== "win32") expect(fs.statSync(result.path).mode & 0o111).not.toBe(0);
  });

  test("a sha256 mismatch aborts and leaves no file", async () => {
    await expect(
      installBicep({
        platform,
        arch: process.arch,
        homedir: home,
        download: bytes("tampered-binary"),
        assets: table("the-real-binary"),
      })
    ).rejects.toThrow(/sha256 .* not the pinned .*nothing was installed/);
    expect(fs.readdirSync(binDir())).toEqual([]);
  });

  test("a mismatch leaves an existing Bicep untouched", async () => {
    fs.mkdirSync(binDir(), { recursive: true });
    const target = bicepInstallPath(home, platform);
    fs.writeFileSync(target, "the-old-bicep");
    await expect(
      installBicep({
        platform,
        arch: process.arch,
        homedir: home,
        download: bytes("tampered-binary"),
        assets: table("the-real-binary"),
      })
    ).rejects.toThrow(/sha256/);
    expect(fs.readFileSync(target, "utf8")).toBe("the-old-bicep");
    expect(fs.readdirSync(binDir())).toEqual([path.basename(target)]);
  });

  test("a failed download leaves no file", async () => {
    const failing: Download = async () => {
      throw new Error("HTTP 503");
    };
    await expect(
      installBicep({
        platform,
        arch: process.arch,
        homedir: home,
        download: failing,
        assets: table("x"),
      })
    ).rejects.toThrow(/HTTP 503/);
    expect(fs.readdirSync(binDir())).toEqual([]);
  });

  test("a platform without a pinned build is an error that names the way out", async () => {
    await expect(
      installBicep({ platform: "freebsd", arch: "x64", homedir: home, download: bytes("x") })
    ).rejects.toThrow(/no pinned Bicep .* LOCALSTACK_AZ_BICEP_PATH/);
  });
});
