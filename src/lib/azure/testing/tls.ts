import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";

/**
 * A throwaway self-signed certificate for tests that need a local TLS server. It is
 * generated at test time, so no private key is ever checked in. Undefined when
 * openssl is not available (the calling test then skips).
 */
export function makeTestCertificate(
  commonName = "azure.localhost.localstack.cloud"
): { key: string; cert: string } | undefined {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lsaz-tls-"));
  try {
    const keyFile = path.join(dir, "key.pem");
    const certFile = path.join(dir, "cert.pem");
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        `/CN=${commonName}`,
        "-addext",
        `subjectAltName=DNS:${commonName},DNS:localhost,IP:127.0.0.1`,
      ],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, MSYS_NO_PATHCONV: "1" } }
    );
    if (result.status !== 0) return undefined;
    return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
