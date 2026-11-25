import fs from "fs";
import path from "path";
import { buildAwsChildEnv, privateDirs, safePath } from "./child-env";
import { programPath } from "./lstk-aws";

const options = {
  homeDir: "/p/home",
  tmpDir: "/p/tmp",
  endpointUrl: "http://localhost.localstack.cloud:4566",
  proxyUrl: "http://127.0.0.1:1",
};

describe("safePath", () => {
  test("drops entries that resolve in the working directory", () => {
    expect(safePath("/usr/bin::.:bin:/opt/x/bin", "linux")).toBe("/usr/bin:/opt/x/bin");
    // On Windows a drive-less \dir is relative to the current drive.
    expect(safePath("C:\\bin;;.;bin;\\tools;\\\\server\\share;D:\\x", "win32")).toBe(
      "C:\\bin;\\\\server\\share;D:\\x"
    );
  });
});

test("safePath drops entries inside a directory the AWS client writes to", () => {
  // npx puts the project's node_modules/.bin first; the project is the default workdir.
  expect(
    safePath("/w/node_modules/.bin:/w:/usr/bin:/w2/bin:/p/home/bin", "linux", ["/w", "/p/home"])
  ).toBe("/usr/bin:/w2/bin");
  expect(safePath("c:\\W\\node_modules\\.bin;C:\\bin", "win32", ["C:\\w"])).toBe("C:\\bin");
  // Device-path spellings of the same directory.
  expect(safePath("\\\\?\\C:\\w\\bin;\\\\.\\c:\\W;C:\\bin", "win32", ["C:\\w"])).toBe("C:\\bin");
});

(process.platform === "darwin" ? test : test.skip)(
  "safePath drops a writable directory spelled in another case (macOS)",
  () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(require("os").tmpdir(), "safepath-")));
    fs.mkdirSync(path.join(root, "work", "bin"), { recursive: true });
    expect(safePath(`${root}/WORK/bin:/usr/bin`, "darwin", [path.join(root, "work")])).toBe(
      "/usr/bin"
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
);

test("safePath follows symlinks to a writable directory", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(require("os").tmpdir(), "safepath-")));
  fs.mkdirSync(path.join(root, "work", "bin"), { recursive: true });
  fs.symlinkSync(path.join(root, "work"), path.join(root, "alias"));
  expect(safePath(`${root}/alias/bin:/usr/bin`, process.platform, [path.join(root, "work")])).toBe(
    "/usr/bin"
  );
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildAwsChildEnv", () => {
  test("keeps only PATH's absolute entries outside the workdir and private dirs", () => {
    const env = buildAwsChildEnv({ PATH: ".:/w/node_modules/.bin:/usr/bin:/p/tmp/x:" }, "linux", {
      ...options,
      workdir: "/w",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });

  test("on Windows, keeps cmd.exe from running programs in the working directory", () => {
    const env = buildAwsChildEnv({ Path: "C:\\bin;." }, "win32", options);
    expect(env.PATH).toBe("C:\\bin");
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe("1");
  });
});

describe("privateDirs", () => {
  test("the private home's CLI config reads blobs as raw text, as awslocal did", () => {
    const config = fs.readFileSync(path.join(privateDirs().homeDir, ".aws", "config"), "utf8");
    expect(config).toBe("[default]\ncli_binary_format = raw-in-base64-out\n");
  });
});

describe("programPath", () => {
  test("elsewhere than Windows, the bare name: only PATH is searched", () => {
    expect(programPath("lstk", { PATH: "/usr/bin" }, "linux")).toBe("lstk");
  });

  test("null when no PATH entry is left: an empty PATH means the working directory", () => {
    expect(programPath("lstk", { PATH: ".::bin" }, "linux")).toBeNull();
    expect(programPath("lstk", {}, "linux")).toBeNull();
    expect(programPath("lstk", { Path: ".;" }, "win32")).toBeNull();
  });

  (process.platform === "win32" ? test : test.skip)(
    "on Windows, the full path from PATH, never the working directory",
    () => {
      const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "prog-"));
      fs.writeFileSync(path.join(dir, "lstk.exe"), "");
      expect(programPath("lstk", { Path: `.;${dir}` }, "win32")).toBe(path.join(dir, "lstk.exe"));
      expect(programPath("lstk", { Path: "." }, "win32")).toBeNull();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );
});
