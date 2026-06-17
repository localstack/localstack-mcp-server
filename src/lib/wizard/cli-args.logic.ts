import { parseArgs } from "util";
import { ALL_CLIENT_IDS } from "./clients/registry";
import { ClientId, InstallMethod } from "./types";

export interface InitFlags {
  method?: InstallMethod;
  clients?: ClientId[];
  token?: string;
  config?: string;
  cacheDir?: string;
  workspace?: string;
  imageTag?: string;
  force: boolean;
  yes: boolean;
  help: boolean;
}

export interface RemoveFlags {
  clients?: ClientId[];
  force: boolean;
  help: boolean;
}

export interface ParsedFlags<T> {
  flags?: T;
  errors: string[];
}

function parseClientList(values: string[]): { clients: ClientId[]; errors: string[] } {
  const errors: string[] = [];
  const clients: ClientId[] = [];
  for (const value of values.flatMap((entry) => entry.split(","))) {
    const id = value.trim();
    if (!id) continue;
    if ((ALL_CLIENT_IDS as string[]).includes(id)) {
      if (!clients.includes(id as ClientId)) clients.push(id as ClientId);
    } else {
      errors.push(`Unknown client "${id}". Valid clients: ${ALL_CLIENT_IDS.join(", ")}`);
    }
  }
  if (clients.length === 0 && errors.length === 0) {
    errors.push(
      `--client was given but no client ids were provided. Valid clients: ${ALL_CLIENT_IDS.join(", ")}`
    );
  }
  return { clients, errors };
}

export function parseInitFlags(argv: string[]): ParsedFlags<InitFlags> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        method: { type: "string" },
        client: { type: "string", multiple: true },
        token: { type: "string" },
        config: { type: "string" },
        "cache-dir": { type: "string" },
        workspace: { type: "string" },
        "image-tag": { type: "string" },
        force: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });

    const errors: string[] = [];
    if (values.method && values.method !== "npx" && values.method !== "docker") {
      errors.push(`Invalid --method "${values.method}". Use "npx" or "docker".`);
    }

    let clients: ClientId[] | undefined;
    if (values.client && values.client.length > 0) {
      const parsed = parseClientList(values.client);
      errors.push(...parsed.errors);
      clients = parsed.clients;
    }

    if (errors.length > 0) return { errors };
    return {
      errors: [],
      flags: {
        method: values.method as InstallMethod | undefined,
        clients,
        token: values.token,
        config: values.config,
        cacheDir: values["cache-dir"],
        workspace: values.workspace,
        imageTag: values["image-tag"],
        force: values.force ?? false,
        yes: values.yes ?? false,
        help: values.help ?? false,
      },
    };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function parseRemoveFlags(argv: string[]): ParsedFlags<RemoveFlags> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        client: { type: "string", multiple: true },
        force: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: false,
    });

    let clients: ClientId[] | undefined;
    const errors: string[] = [];
    if (values.client && values.client.length > 0) {
      const parsed = parseClientList(values.client);
      errors.push(...parsed.errors);
      clients = parsed.clients;
    }

    if (errors.length > 0) return { errors };
    return {
      errors: [],
      flags: {
        clients,
        force: (values.force || values.yes) ?? false,
        help: values.help ?? false,
      },
    };
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : String(error)] };
  }
}
