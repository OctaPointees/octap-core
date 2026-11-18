import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Filesystem-only config for the standalone `octap-mcp` CLI. Kept free of any terminal/readline code
 * so the stdio server can import it without pulling in the interactive setup flow.
 */
export interface StoredConfig {
  apiUrl: string;
  apiKey: string;
}

export interface ResolvedCoreConfig extends StoredConfig {
  /** Where each value came from, for the startup line on stderr. Never includes the key itself. */
  source: { apiUrl: 'env' | 'file'; apiKey: 'env' | 'file' };
  /** The config file that was consulted (whether or not it existed). */
  configFile: string;
}

/**
 * Resolved on every call (not cached) so tests and demos can point it elsewhere via
 * `OCTAP_MCP_CONFIG_PATH`.
 */
export function configPath(): string {
  const override = process.env.OCTAP_MCP_CONFIG_PATH?.trim();
  return override ? override : join(homedir(), '.octap', 'mcp.json');
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Returns the saved config, or `undefined` when no config file exists. Throws if the file is unreadable or malformed. */
export function readStoredConfig(): Partial<StoredConfig> | undefined {
  const path = configPath();
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error(`Could not read Octap MCP config at ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Octap MCP config at ${path} is not valid JSON. Run \`octap-mcp setup\` to rewrite it.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Octap MCP config at ${path} must be a JSON object. Run \`octap-mcp setup\` to rewrite it.`);
  }

  const record = parsed as Record<string, unknown>;
  const config: Partial<StoredConfig> = {};
  if (typeof record.apiUrl === 'string') config.apiUrl = record.apiUrl;
  if (typeof record.apiKey === 'string') config.apiKey = record.apiKey;
  return config;
}

/** Writes the config with owner-only permissions and returns the path written. */
export function writeStoredConfig(config: StoredConfig): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ apiUrl: config.apiUrl, apiKey: config.apiKey }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // `mode` above only applies when the file is created; tighten an existing file too. Best effort:
  // not every filesystem honours POSIX modes (Windows relies on the user-profile ACL instead).
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore
  }
  return path;
}

/** Deletes the config file. Returns `false` when there was nothing to delete. */
export function clearStoredConfig(): boolean {
  const path = configPath();
  try {
    rmSync(path);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

/** Validates an API base URL; `label` names the setting in error messages. */
export function parseApiUrl(rawUrl: string, label = 'OCTAP_API_URL'): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return parsed;
}

/**
 * Env vars win per setting (so a host can still override one value), otherwise the saved config file
 * is used. With neither, startup fails — deleting the file reproduces "no key, no access".
 */
export function resolveCoreConfig(): ResolvedCoreConfig {
  const configFile = configPath();
  const envKey = process.env.OCTAP_API_KEY?.trim();
  const envUrl = process.env.OCTAP_API_URL?.trim();
  const stored = envKey && envUrl ? undefined : readStoredConfig();
  const storedKey = stored?.apiKey?.trim();
  const storedUrl = stored?.apiUrl?.trim();
  const hint = `Set it in the environment, or run \`octap-mcp setup\` to save it to ${configFile}.`;

  const apiKey = envKey || storedKey;
  if (!apiKey) throw new Error(`OCTAP_API_KEY is required. ${hint}`);

  const rawUrl = envUrl || storedUrl;
  if (!rawUrl) throw new Error(`OCTAP_API_URL is required. ${hint}`);
  const apiUrl = parseApiUrl(rawUrl, envUrl ? 'OCTAP_API_URL' : `OCTAP_API_URL (from ${configFile})`).toString();

  return {
    apiUrl,
    apiKey,
    source: { apiUrl: envUrl ? 'env' : 'file', apiKey: envKey ? 'env' : 'file' },
    configFile,
  };
}
