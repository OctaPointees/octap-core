import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearStoredConfig,
  configPath,
  readStoredConfig,
  resolveCoreConfig,
  writeStoredConfig,
} from '../src/config.js';
import { runSetup, SetupAbortedError } from '../src/setup.js';

describe('octap-mcp saved config', () => {
  const originalEnv = { ...process.env };
  let dir: string;
  let file: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OCTAP_API_KEY;
    delete process.env.OCTAP_API_URL;
    dir = mkdtempSync(join(tmpdir(), 'octap-mcp-config-'));
    file = join(dir, 'nested', 'mcp.json');
    process.env.OCTAP_MCP_CONFIG_PATH = file;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to ~/.octap/mcp.json and re-reads the override on every call', () => {
    expect(configPath()).toBe(file);
    delete process.env.OCTAP_MCP_CONFIG_PATH;
    expect(configPath()).toBe(join(homedir(), '.octap', 'mcp.json'));
  });

  it('round-trips the config and clears it', () => {
    expect(readStoredConfig()).toBeUndefined();
    expect(writeStoredConfig({ apiUrl: 'http://127.0.0.1:3000/', apiKey: 'k_123' })).toBe(file);
    expect(readStoredConfig()).toEqual({ apiUrl: 'http://127.0.0.1:3000/', apiKey: 'k_123' });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(clearStoredConfig()).toBe(true);
    expect(clearStoredConfig()).toBe(false);
    expect(readStoredConfig()).toBeUndefined();
  });

  it('rejects a malformed config file with its path', () => {
    writeStoredConfig({ apiUrl: 'http://x', apiKey: 'k' });
    writeFileSync(file, '{ nope');
    expect(() => readStoredConfig()).toThrow(`Octap MCP config at ${file} is not valid JSON`);
  });

  it('refuses to start with neither env vars nor a saved file, naming the file and setup command', () => {
    expect(() => resolveCoreConfig()).toThrow('OCTAP_API_KEY is required');
    expect(() => resolveCoreConfig()).toThrow(`run \`octap-mcp setup\` to save it to ${file}`);
  });

  it('falls back to the saved file, and env vars win per setting', () => {
    writeStoredConfig({ apiUrl: 'https://api.example.com', apiKey: 'file-key' });
    expect(resolveCoreConfig()).toMatchObject({
      apiUrl: 'https://api.example.com/',
      apiKey: 'file-key',
      source: { apiUrl: 'file', apiKey: 'file' },
    });

    process.env.OCTAP_API_URL = 'http://127.0.0.1:3000';
    expect(resolveCoreConfig()).toMatchObject({
      apiUrl: 'http://127.0.0.1:3000/',
      apiKey: 'file-key',
      source: { apiUrl: 'env', apiKey: 'file' },
    });

    process.env.OCTAP_API_KEY = 'env-key';
    writeFileSync(file, '{ broken'); // not consulted at all when both env vars are set
    expect(resolveCoreConfig()).toMatchObject({ apiKey: 'env-key', source: { apiUrl: 'env', apiKey: 'env' } });
  });

  it('validates a URL coming from the file', () => {
    writeStoredConfig({ apiUrl: 'ftp://nope', apiKey: 'k' });
    expect(() => resolveCoreConfig()).toThrow(`OCTAP_API_URL (from ${file}) must use HTTP or HTTPS`);
  });

  describe('runSetup (piped input)', () => {
    async function setup(lines: string, args: string[] = []) {
      const input = new PassThrough();
      const output = new PassThrough();
      let printed = '';
      output.on('data', (chunk) => (printed += String(chunk)));
      input.end(lines);
      await runSetup(args, { input, output });
      return printed;
    }

    it('saves the entered URL and key and tells the user where', async () => {
      const printed = await setup('http://localhost:3000\nsecret-key-1234\n');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        apiUrl: 'http://localhost:3000/',
        apiKey: 'secret-key-1234',
      });
      expect(printed).toContain(file);
      expect(printed).toContain('****1234');
      expect(printed).not.toContain('secret-key-1234');
      expect(printed).toContain('octap-mcp setup --clear');
    });

    it('uses the default URL on Enter and keeps the existing key on Enter', async () => {
      await setup('\nfirst-key\n');
      expect(readStoredConfig()).toEqual({ apiUrl: 'http://127.0.0.1:3000/', apiKey: 'first-key' });

      await setup('https://api.example.com\n\n');
      expect(readStoredConfig()).toEqual({ apiUrl: 'https://api.example.com/', apiKey: 'first-key' });
    });

    it('re-asks for an invalid URL', async () => {
      const printed = await setup('ftp://bad\nhttp://127.0.0.1:4000\nk\n');
      expect(printed).toContain('API URL must use HTTP or HTTPS');
      expect(readStoredConfig()?.apiUrl).toBe('http://127.0.0.1:4000/');
    });

    it('saves nothing when input ends early', async () => {
      await expect(setup('http://127.0.0.1:3000\n')).rejects.toBeInstanceOf(SetupAbortedError);
      expect(readStoredConfig()).toBeUndefined();
    });

    it('--clear removes the file so the server refuses to start', async () => {
      await setup('\nk\n');
      const printed = await setup('', ['--clear']);
      expect(printed).toContain(`Removed ${file}`);
      expect(() => resolveCoreConfig()).toThrow('OCTAP_API_KEY is required');
    });
  });
  describe('runSetup (interactive terminal)', () => {
    /** A PassThrough posing as a TTY; answers each prompt once it appears on the output. */
    function fakeTerminal(answers: Record<string, string>) {
      const input = Object.assign(new PassThrough(), { isTTY: true, rawModes: [] as boolean[] });
      const setRawMode = (mode: boolean) => input.rawModes.push(mode);
      const output = new PassThrough();
      let printed = '';
      const pending = Object.entries(answers);
      output.on('data', (chunk) => {
        printed += String(chunk);
        const next = pending[0];
        if (next && printed.includes(next[0])) {
          pending.shift();
          setImmediate(() => input.write(next[1]));
        }
      });
      return { input: Object.assign(input, { setRawMode }), output, printed: () => printed };
    }

    it('masks the key, handles backspace, and restores the terminal', async () => {
      const term = fakeTerminal({ 'API URL': 'http://127.0.0.1:3001\r', 'API key': 'sk_abx\u007fc9999\r' });
      await runSetup([], { input: term.input, output: term.output });

      expect(readStoredConfig()).toEqual({ apiUrl: 'http://127.0.0.1:3001/', apiKey: 'sk_abc9999' });
      expect(term.printed()).not.toContain('sk_ab');
      expect(term.printed()).toContain('****9999');
      expect(term.input.rawModes.at(-1)).toBe(false); // terminal left in cooked mode
    });

    it('Ctrl+C at the key prompt saves nothing', async () => {
      const term = fakeTerminal({ 'API URL': '\r', 'API key': 'sk_partial\u0003' });
      await expect(runSetup([], { input: term.input, output: term.output })).rejects.toBeInstanceOf(SetupAbortedError);
      expect(readStoredConfig()).toBeUndefined();
      expect(term.input.rawModes.at(-1)).toBe(false); // terminal left in cooked mode
    });
  });
});
