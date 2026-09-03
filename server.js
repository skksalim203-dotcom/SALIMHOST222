/**
 * SALIM HOSTING - Backend Server (v2: multi-user + admin)
 * A self-hosted panel to upload, deploy (via GitHub), configure and run
 * Python (or any) scripts / bots / projects on your own machine or VPS.
 *
 * v2 changes:
 *  - Multi-user system with roles: "admin" and "user"
 *  - Each user gets an isolated workspace folder + isolated running process
 *  - Each user gets their own vanity URL: /u/<username>
 *  - Admin panel to create/delete users and reset passwords, and to
 *    "view as" any user's dashboard
 *  - Passwords are hashed (bcryptjs), never stored in plain text
 *  - Session secret is randomly generated and persisted (not hardcoded)
 *  - Path-traversal check hardened
 *  - GitHub access tokens are masked before being written to logs
 *
 * Credit: SALIM
 */

const express = require("express");
const session = require("express-session");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const APP_ROOT = __dirname;
const DATA_DIR = path.join(APP_ROOT, "data");
const WORKSPACE_ROOT = path.join(APP_ROOT, "workspace");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const UPLOAD_TMP_DIR = path.join(APP_ROOT, "tmp_uploads");

for (const dir of [DATA_DIR, WORKSPACE_ROOT, UPLOAD_TMP_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------- Users store ----------
function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

function loadStore() {
  if (!fs.existsSync(USERS_FILE)) {
    const defaultStore = {
      sessionSecret: crypto.randomBytes(32).toString("hex"),
      users: [
        {
          id: makeId(),
          username: "SALIM",
          passwordHash: bcrypt.hashSync("changeme123", 10),
          role: "admin",
          mainFile: "main.py",
          requirementsFile: "requirements.txt",
          cpuLimit: 100,
          expires: "2026-12-31",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultStore, null, 2));
    return defaultStore;
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
}
function saveStore(s) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(s, null, 2));
}
let store = loadStore();

function findUserByUsername(username) {
  return store.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
}
function findUserById(id) {
  return store.users.find((u) => u.id === id);
}
function userWorkspace(username) {
  const dir = path.join(WORKSPACE_ROOT, username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

// ---------- Process manager (per user) ----------
const processManagers = {};
function getProcessManager(username) {
  if (processManagers[username]) return processManagers[username];
  const mgr = {
    child: null,
    status: "stopped",
    pid: null,
    logs: [],
    MAX_LOGS: 1000,
    log(line) {
      const stamp = new Date().toLocaleTimeString("en-US", { hour12: true });
      this.logs.push(`[${stamp}] ${line}`);
      if (this.logs.length > this.MAX_LOGS) this.logs.shift();
    },
    start() {
      const u = findUserByUsername(username);
      if (!u) return;
      if (this.status === "running") {
        this.log("Server is already running.");
        return;
      }
      const wsDir = userWorkspace(username);
      const mainFile = u.mainFile || "main.py";
      const reqFile = u.requirementsFile || "";
      const mainPath = path.join(wsDir, mainFile);

      if (!fs.existsSync(mainPath)) {
        this.log(`Error: main file "${mainFile}" not found in workspace.`);
        return;
      }

      const launch = () => {
        this.log(`Run: python3 ${mainFile}`);
        const child = spawn("python3", [mainFile], { cwd: wsDir });
        this.child = child;
        this.status = "running";
        this.pid = child.pid;
        this.log(`Server marked as running`);
        this.log(`PID: ${child.pid}`);

        child.stdout.on("data", (data) => this.log(data.toString().trimEnd()));
        child.stderr.on("data", (data) => this.log("⚠️ " + data.toString().trimEnd()));
        child.on("close", (code) => {
          this.log(`Process exited with code ${code}`);
          this.status = "stopped";
          this.child = null;
          this.pid = null;
        });
        child.on("error", (err) => {
          this.log(`Error starting process: ${err.message}`);
          this.status = "stopped";
        });
      };

      const reqPath = path.join(wsDir, reqFile);
      if (reqFile && fs.existsSync(reqPath)) {
        this.log(`Installing dependencies from ${reqFile} ...`);
        const pip = spawn("pip3", ["install", "-r", reqFile], { cwd: wsDir });
        pip.stdout.on("data", (d) => this.log(d.toString().trimEnd()));
        pip.stderr.on("data", (d) => this.log(d.toString().trimEnd()));
        pip.on("close", () => launch());
      } else {
        launch();
      }
    },
    stop() {
      if (this.child) {
        this.child.kill();
      }
      this.log("Server stopped by user");
      this.status = "stopped";
      this.child = null;
      this.pid = null;
    },
    restart() {
      this.log("Restarting server...");
      this.stop();
      setTimeout(() => this.start(), 800);
    },
    clear() {
      this.logs = [];
    },
  };
  processManagers[username] = mgr;
  return mgr;
}

// ---------- App setup ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: store.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
  })
);
app.use(express.static(path.join(APP_ROOT, "public")));

// Very small login rate-limiter (per IP) to slow down brute force.
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  entry.count++;
  if (entry.count > 10) {
    return res.status(429).json({ error: "Too many login attempts. Try again in a minute." });
  }
  next();
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId && findUserById(req.session.userId)) return next();
  return res.status(401).json({ error: "Not authenticated" });
}
function requireAdmin(req, res, next) {
  const u = req.session.userId && findUserById(req.session.userId);
  if (u && u.role === "admin") return next();
  return res.status(403).json({ error: "Admin access required" });
}
// Resolves which user's workspace/process a request should act on: normally
// the logged-in user, but if an admin is "viewing as" someone else, that user.
function effectiveUsername(req) {
  const self = findUserById(req.session.userId);
  if (self.role === "admin" && req.session.viewAs && findUserByUsername(req.session.viewAs)) {
    return req.session.viewAs;
  }
  return self.username;
}

// ---------- Auth routes ----------
app.post("/api/login", loginRateLimit, (req, res) => {
  const { username, password } = req.body;
  const u = username && findUserByUsername(username);
  if (!u || !bcrypt.compareSync(password || "", u.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  req.session.userId = u.id;
  req.session.viewAs = null;
  res.json({ ok: true, role: u.role, username: u.username });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => {
  const self = findUserById(req.session.userId);
  res.json({
    username: self.username,
    role: self.role,
    viewingAs: self.role === "admin" ? req.session.viewAs || null : null,
  });
});

// Admin: switch dashboard to view/control another user's workspace.
app.post("/api/admin/view", requireAuth, requireAdmin, (req, res) => {
  const { username } = req.body;
  if (username && !findUserByUsername(username)) {
    return res.status(404).json({ error: "User not found" });
  }
  req.session.viewAs = username || null;
  res.json({ ok: true });
});

// ---------- Admin: user management ----------
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  res.json({ users: store.users.map(publicUser) });
});

app.post("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }
  if (findUserByUsername(username)) {
    return res.status(400).json({ error: "Username already exists" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const newUser = {
    id: makeId(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    role: role === "admin" ? "admin" : "user",
    mainFile: "main.py",
    requirementsFile: "requirements.txt",
    cpuLimit: 100,
    expires: "2026-12-31",
    createdAt: new Date().toISOString(),
  };
  store.users.push(newUser);
  saveStore(store);
  userWorkspace(username);
  res.json({ ok: true, user: publicUser(newUser), link: `/u/${encodeURIComponent(username)}` });
});

app.put("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  const { password, role } = req.body;
  if (password) {
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    u.passwordHash = bcrypt.hashSync(password, 10);
  }
  if (role === "admin" || role === "user") {
    if (u.role === "admin" && role === "user") {
      const otherAdmins = store.users.filter((x) => x.role === "admin" && x.id !== u.id);
      if (otherAdmins.length === 0) {
        return res.status(400).json({ error: "Cannot demote the last remaining admin" });
      }
    }
    u.role = role;
  }
  saveStore(store);
  res.json({ ok: true, user: publicUser(u) });
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "User not found" });
  if (u.role === "admin") {
    const otherAdmins = store.users.filter((x) => x.role === "admin" && x.id !== u.id);
    if (otherAdmins.length === 0) {
      return res.status(400).json({ error: "Cannot delete the last remaining admin" });
    }
  }
  if (u.id === req.session.userId) {
    return res.status(400).json({ error: "You cannot delete your own account while logged in" });
  }
  const mgr = processManagers[u.username];
  if (mgr) mgr.stop();
  store.users = store.users.filter((x) => x.id !== u.id);
  saveStore(store);
  res.json({ ok: true });
});

// ---------- Status ----------
app.get("/api/status", requireAuth, (req, res) => {
  const username = effectiveUsername(req);
  const u = findUserByUsername(username);
  const mgr = getProcessManager(username);
  res.json({
    username: u.username,
    role: findUserById(req.session.userId).role,
    instanceId: u.id,
    cpuLimit: u.cpuLimit,
    expires: u.expires,
    status: mgr.status,
    pid: mgr.pid,
  });
});

// ---------- Process control ----------
app.post("/api/process/start", requireAuth, (req, res) => {
  getProcessManager(effectiveUsername(req)).start();
  res.json({ ok: true });
});
app.post("/api/process/stop", requireAuth, (req, res) => {
  getProcessManager(effectiveUsername(req)).stop();
  res.json({ ok: true });
});
app.post("/api/process/restart", requireAuth, (req, res) => {
  getProcessManager(effectiveUsername(req)).restart();
  res.json({ ok: true });
});
app.post("/api/console/clear", requireAuth, (req, res) => {
  getProcessManager(effectiveUsername(req)).clear();
  res.json({ ok: true });
});
app.get("/api/console", requireAuth, (req, res) => {
  const mgr = getProcessManager(effectiveUsername(req));
  res.json({ logs: mgr.logs, status: mgr.status });
});

// ---------- File manager (scoped to the effective user's workspace) ----------
function safeJoin(base, target) {
  const resolvedBase = path.resolve(base);
  const targetPath = path.resolve(resolvedBase, target || "");
  if (targetPath !== resolvedBase && !targetPath.startsWith(resolvedBase + path.sep)) {
    throw new Error("Invalid path");
  }
  return targetPath;
}

app.get("/api/files", requireAuth, (req, res) => {
  try {
    const base = userWorkspace(effectiveUsername(req));
    const dirPath = safeJoin(base, req.query.path || "");
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((e) => {
      const full = path.join(dirPath, e.name);
      const stat = fs.statSync(full);
      return {
        name: e.name,
        isDir: e.isDirectory(),
        size: e.isDirectory() ? null : stat.size,
        modified: stat.mtime,
      };
    });
    res.json({ path: req.query.path || "", entries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const upload = multer({ dest: UPLOAD_TMP_DIR, limits: { fileSize: 50 * 1024 * 1024 } });
app.post("/api/files/upload", requireAuth, upload.array("files"), (req, res) => {
  try {
    const base = userWorkspace(effectiveUsername(req));
    const targetDir = safeJoin(base, req.body.path || "");
    for (const f of req.files) {
      fs.renameSync(f.path, path.join(targetDir, f.originalname));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/files/folder", requireAuth, (req, res) => {
  try {
    const base = userWorkspace(effectiveUsername(req));
    const dirPath = safeJoin(base, path.join(req.body.path || "", req.body.name));
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/files", requireAuth, (req, res) => {
  try {
    const base = userWorkspace(effectiveUsername(req));
    const target = safeJoin(base, req.query.path || "");
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- GitHub deploy ----------
function maskUrl(url) {
  return url.replace(/https:\/\/[^@]+@/, "https://***@");
}
function runGitClone(username, url, res) {
  const mgr = getProcessManager(username);
  const wsDir = userWorkspace(username);
  mgr.log(`Cloning repository: ${maskUrl(url)}`);
  const child = spawn("git", ["clone", url, "."], { cwd: wsDir });
  child.stdout.on("data", (d) => mgr.log(d.toString().trimEnd()));
  child.stderr.on("data", (d) => mgr.log(maskUrl(d.toString().trimEnd())));
  child.on("close", (code) => {
    if (code === 0) {
      mgr.log("✅ Repository deployed successfully");
      res.json({ ok: true });
    } else {
      mgr.log("❌ Deploy failed");
      res.status(400).json({ error: "Git clone failed, check console" });
    }
  });
}
app.post("/api/github/deploy/public", requireAuth, (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });
  runGitClone(effectiveUsername(req), repoUrl, res);
});
app.post("/api/github/deploy/private", requireAuth, (req, res) => {
  const { repoUrl, token } = req.body;
  if (!repoUrl || !token) return res.status(400).json({ error: "repoUrl and token required" });
  const authedUrl = repoUrl.replace("https://", `https://${token}@`);
  runGitClone(effectiveUsername(req), authedUrl, res);
});

// ---------- Startup config ----------
app.get("/api/startup", requireAuth, (req, res) => {
  const u = findUserByUsername(effectiveUsername(req));
  res.json({ mainFile: u.mainFile, requirementsFile: u.requirementsFile });
});
app.post("/api/startup", requireAuth, (req, res) => {
  const u = findUserByUsername(effectiveUsername(req));
  u.mainFile = req.body.mainFile || u.mainFile;
  u.requirementsFile = req.body.requirementsFile || u.requirementsFile;
  saveStore(store);
  res.json({ ok: true });
});

// ---------- Profile (always affects the logged-in account, not "view as") ----------
app.post("/api/profile", requireAuth, (req, res) => {
  const self = findUserById(req.session.userId);
  const { newUsername, newPassword } = req.body;
  if (newUsername && newUsername !== self.username) {
    if (findUserByUsername(newUsername)) {
      return res.status(400).json({ error: "Username already taken" });
    }
    const oldWs = userWorkspace(self.username);
    const newWs = path.join(WORKSPACE_ROOT, newUsername);
    if (fs.existsSync(oldWs) && !fs.existsSync(newWs)) fs.renameSync(oldWs, newWs);
    if (processManagers[self.username]) {
      processManagers[newUsername] = processManagers[self.username];
      delete processManagers[self.username];
    }
    self.username = newUsername;
  }
  if (newPassword) {
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    self.passwordHash = bcrypt.hashSync(newPassword, 10);
  }
  saveStore(store);
  res.json({ ok: true });
});

// ---------- Vanity per-user links: /u/<username>, plus /admin ----------
app.get("/u/:username", (req, res) => {
  res.sendFile(path.join(APP_ROOT, "public", "index.html"));
});
app.get("/admin", (req, res) => {
  res.sendFile(path.join(APP_ROOT, "public", "index.html"));
});

const PORT = process.env.PORT || 26365;
app.listen(PORT, () => {
  console.log(`SALIM HOSTING panel running at http://localhost:${PORT}`);
});
