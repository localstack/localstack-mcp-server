// Helpers of the drift gates DR1-DR8. Every request goes to 127.0.0.1
// with the ARM host as SNI, like the tool's own readiness check: no DNS is needed.
import { mkdirSync, writeFileSync } from "fs";
import http from "http";
import https from "https";
import path from "path";
import tls from "tls";

export const PORT = Number(
  process.env.LOCALSTACK_AZURE_PORT || process.env.LOCALSTACK_PORT || 4566
);
export const ARM_HOST = "azure.localhost.localstack.cloud";
export const ENDPOINT = `https://${ARM_HOST}:${PORT}`;
export const REPO = path.resolve(__dirname, "../../..");

function collect(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}

/** GET over HTTPS from the emulator's ARM endpoint (no certificate check: drift only reads). */
export function armGet(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port: PORT,
        servername: ARM_HOST,
        path: urlPath,
        headers: { Host: `${ARM_HOST}:${PORT}` },
        rejectUnauthorized: false,
        timeout: 30_000,
      },
      (res) => collect(res).then((body) => resolve({ status: res.statusCode ?? 0, body }), reject)
    );
    req.on("timeout", () => req.destroy(new Error(`timeout: ${urlPath}`)));
    req.on("error", reject);
    req.end();
  });
}

/** GET over plain HTTP from the gateway (health, info, coverage). */
export function gatewayGet(urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: urlPath, timeout: 60_000 }, (res) =>
      collect(res).then((body) => resolve({ status: res.statusCode ?? 0, body }), reject)
    );
    req.on("timeout", () => req.destroy(new Error(`timeout: ${urlPath}`)));
    req.on("error", reject);
  });
}

/** The DNS names in the certificate the emulator serves for the ARM host. */
export function certificateSans(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: "127.0.0.1", port: PORT, servername: ARM_HOST, rejectUnauthorized: false },
      () => {
        const alt = socket.getPeerCertificate().subjectaltname ?? "";
        socket.end();
        resolve(
          alt
            .split(", ")
            .filter(Boolean)
            .map((s) => s.replace(/^DNS:/, ""))
            .sort()
        );
      }
    );
    socket.on("error", reject);
  });
}

/** Write a JSON report next to the other test artifacts (CI uploads test-results/). */
export function writeReport(name: string, data: unknown): string {
  const dir = path.join(REPO, "test-results");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

/** The local names az may reach; anything else is on L3's watch list. */
export const isLocalSuffix = (value: string) => /localhost\.localstack\.cloud/i.test(value);
