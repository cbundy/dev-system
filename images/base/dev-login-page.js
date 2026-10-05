// dev-login-page.js: the login page behind `dev-login serve`
// (cbundy/dev-system#74). Node, no dependencies.
//
// One card per tool in DEV_LOGIN_TOOLS: Claude's sign-in link and a box for
// the code its sign-in page shows; codex's and gh's link and one-time code; a
// tick once a tool is logged in. All the work is dev-login's: a GET runs
// `dev-login start --json` (starting any missing login, keeping one in
// progress) and the code is handed to `dev-login claude <code>`.
//
// What it accepts is deliberately small: GET / (the page), GET /status (each
// tool's state, for the page to refresh itself), GET /healthz (200 while it is
// up), and a POST / with the code. A code can only finish a login this
// container started (Claude's PKCE verifier never leaves the process), so
// whoever reaches the page cannot get at tokens; the worst case is logging
// the container into their own account, which is why the page is opt-in and
// belongs on a LAN, a VPN or behind an authenticating proxy (Coder).
//
// Every link, form action, fetch and redirect is relative ("." and "status"),
// so the page works at / and behind a proxy that serves it under a path
// prefix and strips it (a Coder path-based app, an nginx route such as
// /login/<container>/), as long as the page URL ends in a slash
// (cbundy/dev-system#79).
//
// Environment: DEV_LOGIN_PORT (required), DEV_LOGIN_PAGE_EXIT (1, the
// default: exit once every login is done; 0 keeps it up).
"use strict";

const http = require("node:http");
const { execFile } = require("node:child_process");

const port = Number(process.env.DEV_LOGIN_PORT);
const exitWhenDone = process.env.DEV_LOGIN_PAGE_EXIT !== "0";
const DONE = new Set(["in", "other", "token", "off"]);
const MAX_BODY = 4096;
const CHECK_EVERY_MS = 10000;
const NAMES = { claude: "Claude", codex: "codex", gh: "GitHub CLI" };

const log = (msg) => console.error(`dev-login-page: ${msg}`);

// Runs dev-login; resolves with its exit status and output, never rejects.
const devLogin = (args, timeout = 90000) =>
  new Promise((resolve) =>
    execFile("dev-login", args, { timeout }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

const json = async (args) => {
  const r = await devLogin(args);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

const allDone = (tools) => Object.values(tools).every((t) => DONE.has(t.state));

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STYLE = `
:root{--bg:#faf9f5;--fg:#1f1e1d;--muted:#6b6a66;--card:#fff;--line:#e5e3dc;--accent:#c96442;--ok:#2f7d4a}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1d;--fg:#f0eee6;--muted:#a3a19a;--card:#2a2927;--line:#3a3936;--accent:#d97757;--ok:#5cb87a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:34rem;margin:0 auto;padding:1.5rem 1rem}h1{font-size:1.4rem;margin:0 0 .25rem}
.sub{color:var(--muted);margin:0 0 1.25rem}.card{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:1rem;margin:0 0 1rem}
.card h2{font-size:1.05rem;margin:0 0 .5rem;display:flex;justify-content:space-between}.ok{color:var(--ok)}.muted{color:var(--muted)}
ol{margin:.25rem 0 .75rem;padding-left:1.25rem}a.btn,button{display:block;width:100%;padding:.75rem;border:0;border-radius:.5rem;
background:var(--accent);color:#fff;font:inherit;text-align:center;text-decoration:none;cursor:pointer;margin:.5rem 0}
input{width:100%;padding:.7rem;font:inherit;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:var(--fg)}
code.otp{display:block;font-size:1.6rem;letter-spacing:.15em;text-align:center;padding:.5rem;border:1px dashed var(--line);border-radius:.5rem;user-select:all}
.err{border-color:var(--accent)}`;

const page = (title, body, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${script}</body></html>`;

const card = (tool, t) => {
  const name = NAMES[tool];
  const head = (status) => `<h2><span>${name}</span>${status}</h2>`;
  switch (t.state) {
    case "in":
      return `<section class="card">${head('<span class="ok">&#10003; logged in</span>')}</section>`;
    case "other":
      return `<section class="card">${head('<span class="ok">&#10003; logged in</span>')}<p class="muted">Not with a claude.ai account, so Remote Control is not available.</p></section>`;
    case "token":
      return `<section class="card">${head('<span class="ok">&#10003; token provided</span>')}</section>`;
  }
  if (!t.url) {
    return `<section class="card">${head('<span class="muted">starting&hellip;</span>')}<p class="muted">No sign-in link yet. Reload in a moment.</p></section>`;
  }
  if (tool === "claude") {
    return `<section class="card">${head("")}<ol><li>Open the sign-in page and approve.</li><li>Copy the code it shows and paste it here.</li></ol>
<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Open sign-in page</a>
<form method="post" action="."><input name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste code" required><button>Log in</button></form></section>`;
  }
  return `<section class="card">${head("")}<ol><li>Open the sign-in page.</li><li>Enter this code and approve. That is all.</li></ol>
<code class="otp">${esc(t.code || "")}</code>
<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">Open sign-in page</a></section>`;
};

// Reloads once a state changes (an approval elsewhere), unless a code is
// being typed.
const REFRESH = `<script>
const shown = document.body.dataset.states;
setInterval(async () => {
  try {
    const r = await fetch("status", { cache: "no-store" });
    if (!r.ok) return;
    const now = JSON.stringify(await r.json());
    const typing = [...document.querySelectorAll("input")].some((i) => i.value);
    if (now !== shown && !typing) location.reload();
  } catch {}
}, 5000);
</script>`;

const statesOf = (tools) => Object.fromEntries(Object.entries(tools).map(([k, t]) => [k, t.state]));

const send = (res, status, type, body, headers = {}) => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
};

const showPage = async (res) => {
  const tools = await json(["start", "--json"]);
  if (!tools) {
    send(res, 500, "text/html; charset=utf-8", page("Logins", `<h1>Logins</h1><p>Could not start the logins. See the container log.</p>`));
    return;
  }
  const visible = Object.entries(tools).filter(([, t]) => t.state !== "off");
  const done = allDone(tools);
  const body =
    `<h1>Logins</h1><p class="sub">${done ? "All done. This container is ready." : "Sign in to each tool below. Any device works, a phone included."}</p>` +
    visible.map(([tool, t]) => card(tool, t)).join("");
  const html = page("Logins", body, REFRESH).replace("<body>", `<body data-states="${esc(JSON.stringify(statesOf(tools)))}">`);
  send(res, 200, "text/html; charset=utf-8", html);
};

const readCode = (req) =>
  new Promise((resolve) => {
    let data = "";
    let tooBig = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => resolve(tooBig ? null : (new URLSearchParams(data).get("code") || "").trim()));
    req.on("error", () => resolve(null));
  });

let shuttingDown = false;
const exitIfDone = async () => {
  if (!exitWhenDone || shuttingDown) return;
  const tools = await json(["status", "--json"]);
  if (tools && allDone(tools)) {
    shuttingDown = true;
    log("every login is done - closing the login page");
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  }
};

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://page").pathname;
  try {
    if (req.method === "GET" && path === "/healthz") return send(res, 200, "text/plain", "ok\n");
    if (req.method === "GET" && path === "/status") {
      const tools = await json(["status", "--json"]);
      return tools ? send(res, 200, "application/json", JSON.stringify(statesOf(tools))) : send(res, 500, "text/plain", "error\n");
    }
    if (req.method === "GET" && path === "/") return await showPage(res);
    if (req.method === "POST" && path === "/") {
      const type = String(req.headers["content-type"] || "");
      if (!type.startsWith("application/x-www-form-urlencoded")) return send(res, 415, "text/plain", "unsupported\n");
      const code = await readCode(req);
      if (!code) return send(res, 400, "text/plain", "no code\n");
      const r = await devLogin(["claude", code]);
      if (r.ok) {
        send(res, 303, "text/plain", "logged in\n", { Location: "." });
        exitIfDone();
        return;
      }
      // dev-login's own message: why, and what to do next. No credentials.
      const why = r.stderr.trim().split("\n").pop().replace(/^dev-login: /, "");
      return send(res, 200, "text/html; charset=utf-8",
        page("Logins", `<h1>That did not work</h1><section class="card err"><p>${esc(why || "The login failed.")}</p><a class="btn" href=".">Get a new link</a></section>`));
    }
    send(res, 404, "text/plain", "not found\n");
  } catch (e) {
    log(`error: ${e.message}`);
    if (!res.headersSent) send(res, 500, "text/plain", "error\n");
  }
});
server.requestTimeout = 120000;

const main = async () => {
  if (exitWhenDone) {
    const tools = await json(["status", "--json"]);
    if (tools && allDone(tools)) {
      log("every login is done - no login page needed");
      return;
    }
  }
  server.listen(port, "0.0.0.0", () => log(`login page on port ${port}`));
  setInterval(exitIfDone, CHECK_EVERY_MS).unref();
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
};
main();
