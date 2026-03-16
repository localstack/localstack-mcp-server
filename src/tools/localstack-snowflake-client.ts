import { z } from "zod";
import { type ToolMetadata, type InferSchema } from "xmcp";
import { runCommand } from "../core/command-runner";
import { runPreflights, requireSnowflakeCli, requireProFeature } from "../core/preflight";
import { ResponseBuilder } from "../core/response-builder";
import { ProFeature } from "../lib/localstack/license-checker";
import { withToolAnalytics } from "../core/analytics";

const SNOWFLAKE_CONNECTION_NAME = "localstack";

export const schema = {
  action: z.enum(["execute", "check-connection"]).describe("Action to perform"),
  query: z
    .string()
    .trim()
    .optional()
    .describe(
      "SQL query to execute (e.g. 'SELECT * FROM mytable', 'SHOW DATABASES', 'CREATE TABLE ...'). Required when action is 'execute' and file_path is not provided."
    ),
  file_path: z
    .string()
    .trim()
    .optional()
    .describe(
      "Absolute path to a .sql file to execute. Required when action is 'execute' and query is not provided."
    ),
  database: z.string().trim().optional().describe("Snowflake database context for this query."),
  schema: z.string().trim().optional().describe("Snowflake schema context for this query."),
  warehouse: z.string().trim().optional().describe("Snowflake warehouse to use for this query."),
  role: z.string().trim().optional().describe("Snowflake role to use for this query."),
};

export const metadata: ToolMetadata = {
  name: "localstack-snowflake-client",
  description:
    "Execute SQL queries and commands against the LocalStack Snowflake emulator using the Snowflake CLI (snow). Use this to run SELECT queries, DDL (CREATE/DROP), DML (INSERT/UPDATE/DELETE), SHOW DATABASES/SCHEMAS/TABLES, DESCRIBE TABLE, and any other Snowflake SQL.",
  annotations: { title: "LocalStack Snowflake Client" },
};

async function requireSnowflakeConnectionProfile() {
  const listResult = await runCommand("snow", ["connection", "list"], { env: { ...process.env } });
  const listCombined = `${listResult.stdout || ""}\n${listResult.stderr || ""}`.toLowerCase();

  if (
    listResult.exitCode === 0 &&
    listCombined.includes(SNOWFLAKE_CONNECTION_NAME.toLowerCase())
  ) {
    return null;
  }

  const addResult = await runCommand(
    "snow",
    [
      "connection",
      "add",
      "--connection-name",
      SNOWFLAKE_CONNECTION_NAME,
      "--user",
      "test",
      "--password",
      "test",
      "--account",
      "test",
      "--role",
      "test",
      "--warehouse",
      "test",
      "--database",
      "test",
      "--schema",
      "test",
      "--port",
      "4566",
      "--host",
      "snowflake.localhost.localstack.cloud",
      "--no-interactive",
    ],
    { env: { ...process.env } }
  );
  const combined = `${addResult.stdout || ""}\n${addResult.stderr || ""}`.toLowerCase();
  const alreadyExists =
    combined.includes("already exists") ||
    combined.includes("already configured") ||
    combined.includes("already present");

  if (alreadyExists) {
    return null;
  }

  if (addResult.error || addResult.exitCode !== 0) {
    return ResponseBuilder.error(
      "Snowflake Connection Profile Setup Failed",
      (addResult.stderr || addResult.stdout || addResult.error?.message || "Unknown error").trim()
    );
  }

  return null;
}

export default async function localstackSnowflakeClient({
  action,
  query,
  file_path,
  database,
  schema: schemaName,
  warehouse,
  role,
}: InferSchema<typeof schema>) {
  return withToolAnalytics("localstack-snowflake-client", { action }, async () => {
    const preflightError = await runPreflights([
      requireSnowflakeCli(),
      requireProFeature(ProFeature.SNOWFLAKE),
      requireSnowflakeConnectionProfile(),
    ]);
    if (preflightError) return preflightError;

    if (action === "check-connection") {
      const result = await runCommand(
        "snow",
        ["connection", "test", "--connection", SNOWFLAKE_CONNECTION_NAME],
        { env: { ...process.env } }
      );

      if (result.exitCode === 0) {
        return ResponseBuilder.markdown(result.stdout || "");
      }

      return ResponseBuilder.error("Connection Check Failed", (result.stderr || result.stdout || "").trim());
    }

    const hasQuery = !!query;
    const hasFilePath = !!file_path;
    if ((hasQuery && hasFilePath) || (!hasQuery && !hasFilePath)) {
      return ResponseBuilder.error(
        "Invalid Parameters",
        "Provide exactly one of `query` or `file_path` when action is `execute`."
      );
    }

    const args = ["sql", "--connection", SNOWFLAKE_CONNECTION_NAME];
    if (query) args.push("--query", query);
    if (file_path) args.push("-f", file_path);
    if (database) args.push("--dbname", database);
    if (schemaName) args.push("--schemaname", schemaName);
    if (warehouse) args.push("--warehouse", warehouse);
    if (role) args.push("--rolename", role);

    const result = await runCommand("snow", args, { env: { ...process.env } });
    if (result.exitCode === 0) {
      return ResponseBuilder.markdown(result.stdout || "");
    }

    const rawError = (result.stderr || result.stdout || result.error?.message || "Unknown error").trim();
    return ResponseBuilder.error(
      "Command Failed",
      `${rawError}\n\nCheck Snowflake feature coverage: https://docs.localstack.cloud/snowflake/feature-coverage/`
    );
  });
}
