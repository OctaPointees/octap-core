import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { clearStoredConfig, configPath, parseApiUrl, readStoredConfig, writeStoredConfig } from './config.js';

/**
 * `octap-mcp setup`: run once in a terminal, outside any MCP host. The stdio server can't prompt
 * because its stdout carries JSON-RPC, so credentials are collected here and saved to a file the
 * server reads at startup.
 */
export const DEFAULT_API_URL = 'http://127.0.0.1:3000';

type SetupInput = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

export interface SetupIo {
  input?: SetupInput;
  output?: Writable;
}

export class SetupAbortedError extends Error {
  constructor() {
    super('Setup cancelled; nothing was saved.');
    this.name = 'SetupAbortedError';
  }
}

interface Prompter {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
  close(): void;
}

/** Piped stdin (scripts, CI): read lines in order from one buffered iterator; nothing to mask. */
function linePrompter(input: SetupInput, output: Writable): Prompter {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question: string) => {
    output.write(question);
    const next = await lines.next();
    if (next.done) throw new SetupAbortedError();
    output.write('\n');
    return next.value;
  };
  return { ask, askHidden: ask, close: () => rl.close() };
}

/** Interactive terminal: readline for visible answers, raw mode for the masked API key. */
function ttyPrompter(input: SetupInput, output: Writable): Prompter {
  const ask = (question: string) =>
    new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input, output, terminal: true });
      let answered = false;
      rl.on('SIGINT', () => {
        rl.close();
        reject(new SetupAbortedError());
      });
      rl.on('close', () => {
        if (!answered) reject(new SetupAbortedError());
      });
      rl.question(question, (answer) => {
        answered = true;
        rl.close();
        resolve(answer);
      });
    });

  const askHidden = (question: string) =>
    new Promise<string>((resolve, reject) => {
      output.write(question);
      let value = '';
      const finish = (error?: Error) => {
        input.off('data', onData);
        input.setRawMode?.(false);
        input.pause();
        output.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') return finish();
          if (char === '\u0003') return finish(new SetupAbortedError()); // Ctrl+C
          if (char === '\u0004') {
            // Ctrl+D: submit what was typed, or abort on an empty line.
            return value ? finish() : finish(new SetupAbortedError());
          }
          if (char === '\u007f' || char === '\b') {
            if (value) {
              value = value.slice(0, -1);
              output.write('\b \b');
            }
            continue;
          }
          if (char < ' ') continue; // other control characters / escape sequences
          value += char;
          output.write('*');
        }
      };
      input.setRawMode?.(true);
      input.resume();
      input.on('data', onData);
    });

  return { ask, askHidden, close: () => undefined };
}

function maskKey(key: string): string {
  return key.length <= 4 ? '****' : `****${key.slice(-4)}`;
}

export async function runSetup(args: string[] = [], io: SetupIo = {}): Promise<void> {
  const input = io.input ?? (process.stdin as SetupInput);
  const output = io.output ?? process.stdout;
  const say = (line = '') => output.write(`${line}\n`);

  if (args.includes('--clear')) {
    const path = configPath();
    say(clearStoredConfig() ? `Removed ${path}` : `No saved config at ${path}; nothing to remove.`);
    say('Without OCTAP_API_URL/OCTAP_API_KEY in the environment, octap-mcp will now refuse to start.');
    return;
  }
  if (args.includes('--path')) {
    say(configPath());
    return;
  }
  const unknown = args.filter((arg) => arg !== '--clear' && arg !== '--path');
  if (unknown.length > 0) throw new Error(`Unknown setup option: ${unknown.join(' ')}`);

  let existing: ReturnType<typeof readStoredConfig>;
  try {
    existing = readStoredConfig();
  } catch {
    existing = undefined; // a broken file is simply overwritten
  }
  const defaultUrl = existing?.apiUrl?.trim() || process.env.OCTAP_API_URL?.trim() || DEFAULT_API_URL;
  const existingKey = existing?.apiKey?.trim();

  const prompter = input.isTTY ? ttyPrompter(input, output) : linePrompter(input, output);
  try {
    say('Octap MCP setup — saves the Core API URL and an organization API key for octap-mcp.');
    say(`Config file: ${configPath()}`);
    say();

    let apiUrl: string | undefined;
    for (let attempt = 0; attempt < 3 && !apiUrl; attempt++) {
      const answer = (await prompter.ask(`Octap API URL [${defaultUrl}]: `)).trim() || defaultUrl;
      try {
        apiUrl = parseApiUrl(answer, 'API URL').toString();
      } catch (error) {
        say((error as Error).message);
      }
    }
    if (!apiUrl) throw new Error('No valid API URL entered; nothing was saved.');

    let apiKey: string | undefined;
    const keyPrompt = existingKey
      ? `Octap API key [Enter keeps ${maskKey(existingKey)}]: `
      : 'Octap API key (input hidden): ';
    for (let attempt = 0; attempt < 3 && !apiKey; attempt++) {
      apiKey = (await prompter.askHidden(keyPrompt)).trim() || existingKey;
      if (!apiKey) say('The API key cannot be empty.');
    }
    if (!apiKey) throw new Error('No API key entered; nothing was saved.');

    const path = writeStoredConfig({ apiUrl, apiKey });
    say();
    say(`Saved API URL ${apiUrl} and key ${maskKey(apiKey)} to:`);
    say(`  ${path}`);
    say();
    say('Your MCP host now needs no env vars, e.g. { "command": "npx", "args": ["-y", "@octap/mcp"] }.');
    say('OCTAP_API_URL / OCTAP_API_KEY in the environment still take precedence over this file.');
    say('To revoke local access: octap-mcp setup --clear (or delete the file above).');
  } finally {
    prompter.close();
  }
}
