// Keeps the eval's secrets out of what it writes to disk. Results are uploaded as a CI artifact, which GitHub does not
// mask, and the agent can print what it reads, so every file goes through redact() before it is written.

/** Variables whose values must never reach a result file or a child that does not need them */
export const SECRET_NAMES = [
  "LOCALSTACK_AUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];

/** What a process needs to run, without any credential */
const BASE_NAMES = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "SHELL",
];

/** The variables in `names` that are set in `env`, and nothing else */
export function pickEnv(names, env = process.env) {
  return Object.fromEntries(
    names.filter((name) => env[name] !== undefined).map((name) => [name, env[name]])
  );
}

/** The base environment for a child process: no secrets, plus `extra` */
export function baseEnv(extra = {}, env = process.env) {
  return { ...pickEnv(BASE_NAMES, env), ...extra };
}

/** The secret values in `env`, with the forms a transcript could hold them in */
export function secretForms(env = process.env) {
  const forms = [];
  for (const name of SECRET_NAMES) {
    const value = env[name];
    if (!value || value.length < 8) continue;
    for (const form of [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      JSON.stringify(value).slice(1, -1),
    ]) {
      forms.push({ name, form });
    }
  }
  return forms;
}

/** `text` with every secret replaced by its name, and the names that were found */
export function redact(text, env = process.env) {
  let result = text;
  const found = new Set();
  for (const { name, form } of secretForms(env)) {
    if (!result.includes(form)) continue;
    found.add(name);
    result = result.split(form).join(`[REDACTED ${name}]`);
  }
  return { text: result, found: [...found] };
}
