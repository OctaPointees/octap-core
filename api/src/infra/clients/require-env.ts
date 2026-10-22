/** Reads a required env var lazily, naming the adapter that needed it in the error. */
export function requireEnv(name: string, adapter: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} for the ${adapter}`);
  }
  return value;
}
