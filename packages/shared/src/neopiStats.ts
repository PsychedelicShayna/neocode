const READ_PATHS = new Set([
  "/embed", "/api/events", "/api/status", "/api/stats", "/api/stats/overview",
  "/api/stats/model-dashboard", "/api/stats/costs", "/api/stats/frustration",
  "/api/frustration/estimate", "/api/stats/tools", "/api/stats/provider-windows",
  "/api/stats/providers", "/api/stats/recent", "/api/stats/errors", "/api/stats/models",
  "/api/stats/folders", "/api/stats/timeseries", "/api/stats/gain", "/api/sessions",
  "/api/session/trace", "/api/session/entry",
]);
const WRITE_PATHS = new Set(["/api/sync", "/api/frustration/judge", "/api/frustration/cancel"]);

/** Fixed native routes only. A frame cannot turn the host into an authenticated URL fetcher. */
export function isNeoPiStatsPathAllowed(method: string, path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) return false;
  const pathname = path.split("?", 1)[0]!;
  return ((method === "GET" || method === "HEAD") && (READ_PATHS.has(pathname) || /^\/api\/request\/\d+$/.test(pathname))) ||
    (method === "POST" && WRITE_PATHS.has(pathname)) || (method === "DELETE" && path === "/");
}
