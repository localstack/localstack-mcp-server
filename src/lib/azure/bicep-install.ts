import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

/**
 * The Bicep step of `install-azure-addons` (plan task 5.3; check C08; Appendix E): the pinned Bicep
 * release for this OS and architecture, downloaded from GitHub and checked against the
 * sha256 table below before it is moved into ~/.localstack/azure/bin, where the tool
 * looks second (after LOCALSTACK_AZ_BICEP_PATH). Never agent-triggered, and never
 * ~/.azure/bin, which belongs to the user's own `az bicep install`.
 */

export const BICEP_VERSION = "0.47.16";

export interface BicepAsset {
  asset: string;
  sha256: string;
}

/** Keyed `<platform>-<arch>` (Node's names); `linux-musl-x64` for musl libc (Alpine). */
export const BICEP_ASSETS: Readonly<Record<string, BicepAsset>> = {
  "win32-x64": {
    asset: "bicep-win-x64.exe",
    sha256: "3f343ab1ce41feac156464adee3dc499cb6c197366fc731aed276192011d867c",
  },
  "win32-arm64": {
    asset: "bicep-win-arm64.exe",
    sha256: "657e6aacc4e44d73674874f802d98396bf5e2e23530d160f275fbf9d67b7fde7",
  },
  "linux-x64": {
    asset: "bicep-linux-x64",
    sha256: "64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a",
  },
  "linux-musl-x64": {
    asset: "bicep-linux-musl-x64",
    sha256: "ffa36eca49db30fb2d6a9b44cf9e49ef4946f0a26425714c8483f8f63cfff125",
  },
  "linux-arm64": {
    asset: "bicep-linux-arm64",
    sha256: "4406214cc274cfac7c821552aec2178b80aec637d91ed8b244282964c1cf24e3",
  },
  "darwin-x64": {
    asset: "bicep-osx-x64",
    sha256: "8ba5771b5261413d88583829f2ea24509eb65b06d899620c17283ecb60d5ca73",
  },
  "darwin-arm64": {
    asset: "bicep-osx-arm64",
    sha256: "68046a084c88503cf6bd11dacf2a1c4ffcb7e3ac9c6b310d295e024af21bbea4",
  },
};

function assetKey(platform: NodeJS.Platform, arch: string, musl?: boolean): string {
  return platform === "linux" && musl ? `linux-musl-${arch}` : `${platform}-${arch}`;
}

function releaseUrl(asset: string): string {
  return `https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/${asset}`;
}

export function bicepAssetFor(
  platform: NodeJS.Platform,
  arch: string,
  opts: { musl?: boolean } = {}
): (BicepAsset & { url: string }) | undefined {
  const asset = BICEP_ASSETS[assetKey(platform, arch, opts.musl)];
  return asset ? { ...asset, url: releaseUrl(asset.asset) } : undefined;
}

/** ~/.localstack/azure/bin: the tool's own Bicep dir (resolveBicep's second choice). */
export function bicepInstallDir(homedir: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.join(homedir, ".localstack", "azure", "bin");
}

export function bicepInstallPath(homedir: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.join(bicepInstallDir(homedir, platform), platform === "win32" ? "bicep.exe" : "bicep");
}

/** musl libc (Alpine): Node's report has no glibc runtime version there. */
export function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
  return !report?.header?.glibcVersionRuntime;
}

export type Download = (url: string) => Promise<AsyncIterable<Uint8Array>>;

/** The release asset, following GitHub's redirect to its object store. */
export const httpsDownload: Download = async (url) => {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`downloading ${url} failed: HTTP ${response.status}`);
  }
  return Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>);
};

/**
 * Downloads the pinned asset into a temporary file next to the target, checks its
 * sha256, and only then renames it into place. On any failure, a mismatch included,
 * the temporary file is removed and nothing is installed.
 */
export async function installBicep(opts: {
  platform: NodeJS.Platform;
  arch: string;
  homedir: string;
  musl?: boolean;
  download?: Download;
  /** Tests: another sha256 table. */
  assets?: Readonly<Record<string, BicepAsset>>;
}): Promise<{ path: string; asset: string }> {
  const pinned = (opts.assets ?? BICEP_ASSETS)[assetKey(opts.platform, opts.arch, opts.musl)];
  if (!pinned) {
    throw new Error(
      `there is no pinned Bicep ${BICEP_VERSION} build for ${opts.platform}/${opts.arch}; install Bicep yourself and set LOCALSTACK_AZ_BICEP_PATH`
    );
  }
  const url = releaseUrl(pinned.asset);
  const target = bicepInstallPath(opts.homedir, opts.platform);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.bicep-download-${randomBytes(6).toString("hex")}`);
  const hash = createHash("sha256");
  try {
    const body = await (opts.download ?? httpsDownload)(url);
    await pipeline(
      Readable.from(body),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(temp, { mode: 0o755 })
    );
    const digest = hash.digest("hex");
    if (digest !== pinned.sha256) {
      throw new Error(
        `the downloaded ${pinned.asset} has sha256 ${digest}, not the pinned ${pinned.sha256}; nothing was installed`
      );
    }
    if (opts.platform !== "win32") fs.chmodSync(temp, 0o755);
    fs.renameSync(temp, target);
    return { path: target, asset: pinned.asset };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
