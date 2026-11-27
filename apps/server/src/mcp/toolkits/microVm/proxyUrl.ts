const MICROVM_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Chromium's `--proxy-server` flag needs a bare `scheme://host:port`.
 * `URL.toString()` appends `/` for an empty path, and some Chromium builds
 * reject that with `ERR_NO_SUPPORTED_PROXIES`. Rewrite loopback endpoints to
 * the microVM host gateway and drop any path, query, or fragment.
 */
export function normalizeMicroVmProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (MICROVM_LOOPBACK_HOSTS.has(url.hostname)) {
      url.hostname = "host.microsandbox.internal";
    }
    return `${url.protocol}//${url.hostname}${url.port.length > 0 ? `:${url.port}` : ""}`;
  } catch {
    return proxyUrl;
  }
}
