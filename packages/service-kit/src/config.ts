export const DEFAULT_PORT = 8080;

/**
 * Port the service listens on, from the PORT environment variable.
 * Every service listens on the same internal port: containers have their own
 * network namespace, and nothing is published on the host except the proxy.
 */
export function readPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["PORT"];
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}
