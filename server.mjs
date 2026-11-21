import { createReadStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = resolve(root, "public");
const port = Number(process.env.PORT ?? 4173);
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);
const pythonPath =
  process.platform === "win32"
    ? resolve(root, ".venv", "Scripts", "python.exe")
    : resolve(root, ".venv", "bin", "python");
let refreshRunning = false;

function refreshJobs() {
  if (!existsSync(pythonPath)) {
    console.error(`Daily refresh skipped: project Python environment not found at ${pythonPath}.`);
    return;
  }
  if (refreshRunning) {
    console.warn("Daily refresh skipped: a previous refresh is still running.");
    return;
  }

  refreshRunning = true;
  console.log("Starting daily job refresh...");
  const child = spawn(pythonPath, ["-m", "jobboard"], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[job refresh] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[job refresh] ${chunk}`));
  child.on("error", (error) => {
    refreshRunning = false;
    console.error(`Daily refresh could not start: ${error.message}`);
  });
  child.on("close", (code) => {
    refreshRunning = false;
    if (code === 0) {
      console.log("Daily job refresh completed.");
    } else {
      console.error(`Daily job refresh failed with exit code ${code}.`);
    }
  });
}

function scheduleDailyRefresh() {
  const nextRun = new Date();
  nextRun.setHours(4, 0, 0, 0);
  if (nextRun <= new Date()) nextRun.setDate(nextRun.getDate() + 1);
  const timer = setTimeout(() => {
    refreshJobs();
    scheduleDailyRefresh();
  }, nextRun.getTime() - Date.now());
  timer.unref();
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(publicRoot, `.${requestedPath}`);

  if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": pathname.endsWith(".json") ? "no-cache" : "public, max-age=3600",
    "Content-Type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  createReadStream(filePath).pipe(response);
});

server.listen(port, () => {
  console.log(`Firstlight is ready at http://localhost:${port}`);
  if (process.env.AUTO_REFRESH !== "false") {
    refreshJobs();
    scheduleDailyRefresh();
  }
});
