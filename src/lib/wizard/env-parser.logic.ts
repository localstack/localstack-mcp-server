import { AUTH_TOKEN_ENV } from "./types";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ParsedEnvVars {
  env: Record<string, string>;
  errors: string[];
}

/**
 * Parses the wizard's free-text extra-config input, e.g. "DEBUG=1,IMAGE_NAME=xxx".
 * Pairs are comma-separated; values therefore cannot contain commas.
 */
export function parseEnvVarsInput(input: string): ParsedEnvVars {
  const env: Record<string, string> = {};
  const errors: string[] = [];

  for (const rawPair of input.split(",")) {
    const pair = rawPair.trim();
    if (!pair) continue;

    const separatorIndex = pair.indexOf("=");
    if (separatorIndex <= 0) {
      errors.push(`"${pair}" is not in KEY=value format`);
      continue;
    }

    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();

    if (!ENV_KEY_PATTERN.test(key)) {
      errors.push(`"${key}" is not a valid environment variable name`);
      continue;
    }
    if (key === AUTH_TOKEN_ENV) {
      errors.push(`${AUTH_TOKEN_ENV} is set via the token step, not here`);
      continue;
    }
    if (!value) {
      errors.push(`"${key}" has an empty value`);
      continue;
    }

    env[key] = value;
  }

  return { env, errors };
}
