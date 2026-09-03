// SALIM HOSTING - frontend logic (v2: multi-user + admin)
const $ = (id) => document.getElementById(id);
let currentPath = "";
let consolePollTimer = null;
let me = null; // { username, role, viewingAs }

// Vanity URL support: /u/<username> just pre-fills the login username field.
// It does NOT grant access by itself — the server still checks the session.
function vanityUsernameFromPath() {
  const m = location.pathname.match(/^\/u\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
const vanityUser = vanityUsernameFromPath();
if (vanityUser) $("loginUsername").value = vanityUser;

// ---------- Login ----------
$("loginBtn").addEventListener("click", doLogin);
$("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

async function doLogin() {
  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value;
  $("loginError").textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      $("loginError").textContent = data.error || "Login failed";
      return;
    }
    await afterLogin();
  } catch (err) {
    $("loginError").textContent = "Could not reach server";
  }
}

$("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  clearInterval(consolePollTimer);
  $("dashboard").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  history.replaceState(null, "", "/");
});

async function afterLogin() {
  const res = await fetch("/api/me");
  me = await res.json();

  // If an admin logged in via someone else's /u/<username> link, switch
  // the dashboard to "view as" that user. Admins viewing their own link
  // just see their own dashboard normally.
  if (me.role === "admin" && vanityUser && vanityUser.toLowerCase() !== me.username.toLowerCase()) {
    await fetch("/api/admin/view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: vanityUser }),
    });
    const res2 = await fetch("/api/me");
    me = await res2.json();
  }

  $("adminTabBtn").classList.toggle("hidden", me.role !== "admin");
  showDashboard();
}

async function showDashboard() {
  $("loginScreen").classList.add("hidden");
  $("dashboard").classList.remove("hidden");

  if (me.viewingAs) {
    $("viewAsBanner").classList.remove("hidden");
    $("viewAsName").textContent = me.viewingAs;
  } else {
    $("viewAsBanner").classList.add("hidden");
  }

  await refreshStatus();
  await loadFiles("");
  await loadStartupConfig();
  startConsolePolling();
  if (me.role === "admin") loadUsers();
}

$("exitViewAsBtn").addEventListener("click", async () => {
  await fetch("/api/admin/view", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: null }),
  });
  history.replaceState(null, "", "/");
  const res = await fetch("/api/me");
  me = await res.json();
  showDashboard();
});

// If already logged in (cookie still valid) and page loads on a vanity link
// or the root, try to resume the session automatically.
(async function tryResume() {
  const res = await fetch("/api/me");
  if (res.ok) {
    me = await res.json();
    if (me.role === "admin" && vanityUser && vanityUser.toLowerCase() !== me.username.toLowerCase() && me.viewingAs !== vanityUser) {
      await fetch("/api/admin/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: vanityUser }),
      });
      const res2 = await fetch("/api/me");
      me = await res2.json();
    }
    $("adminTabBtn").classList.toggle("hidden", me.role !== "admin");
    showDashboard();
  }
})();

// ---------- Status + process controls ----------
async function refreshStatus() {
  const res = await fetch("/api/status");
  if (!res.ok) return;
  const s = await res.json();
  $("topUsername").textContent = s.username;
  $("instanceId").textContent = s.instanceId;
  $("cpuLimit").textContent = s.cpuLimit + "%";
  $("expires").textContent = s.expires;
  $("newUsername").value = s.username;
}

$("startBtn").addEventListener("click", () => fetch("/api/process/start", { method: "POST" }));
$("stopBtn").addEventListener("click", () => fetch("/api/process/stop", { method: "POST" }));
$("restartBtn").addEventListener("click", () => fetch("/api/process/restart", { method: "POST" }));
$("clearBtn").addEventListener("click", async () => {
  await fetch("/api/console/clear", { method: "POST" });
  $("consoleOutput").textContent = "";
});

// ---------- Tabs ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("tab-" + tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "admin") loadUsers();
  });
});

// ---------- Console ----------
function startConsolePolling() {
  pollConsole();
  clearInterval(consolePollTimer);
  consolePollTimer = setInterval(pollConsole, 1500);
}
async function pollConsole() {
  const res = await fetch("/api/console");
  if (!res.ok) return;
  const data = await res.json();
  const box = $("consoleOutput");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.textContent = data.logs.join("\n");
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- Files ----------
async function loadFiles(p) {
  currentPath = p;
  $("currentPath").textContent = "📁 /" + p;
  const res = await fetch("/api/files?path=" + encodeURIComponent(p));
  const data = await res.json();
  const list = $("filesList");
  list.innerHTML = "";

  if (p) {
    const up = document.createElement("div");
    up.className = "file-row";
    up.innerHTML = `<span class="fname">⬅️ ..</span>`;
    up.querySelector(".fname").addEventListener("click", () => {
      const parts = p.split("/").filter(Boolean);
      parts.pop();
      loadFiles(parts.join("/"));
    });
    list.appendChild(up);
  }

  (data.entries || []).forEach((entry) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const icon = entry.isDir ? "📁" : "📄";
    const sizeText = entry.isDir ? "-" : formatSize(entry.size);
    row.innerHTML = `
      <span class="fname">${icon} ${entry.name}</span>
      <span class="fmeta">${sizeText}</span>
      <button class="fdel" title="Delete">🗑</button>
    `;
    row.querySelector(".fname").addEventListener("click", () => {
      if (entry.isDir) loadFiles((p ? p + "/" : "") + entry.name);
    });
    row.querySelector(".fdel").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${entry.name}"?`)) return;
      await fetch("/api/files?path=" + encodeURIComponent((p ? p + "/" : "") + entry.name), {
        method: "DELETE",
      });
      loadFiles(p);
    });
    list.appendChild(row);
  });
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

$("uploadBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async () => {
  const files = $("fileInput").files;
  if (!files.length) return;
  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  formData.append("path", currentPath);
  await fetch("/api/files/upload", { method: "POST", body: formData });
  loadFiles(currentPath);
});
$("newFolderBtn").addEventListener("click", async () => {
  const name = prompt("Folder name:");
  if (!name) return;
  await fetch("/api/files/folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: currentPath, name }),
  });
  loadFiles(currentPath);
});
$("newFileBtn").addEventListener("click", () => $("fileInput").click());

// ---------- GitHub deploy ----------
$("deployPublicBtn").addEventListener("click", async () => {
  const repoUrl = $("publicRepoUrl").value.trim();
  if (!repoUrl) return alert("Enter a repo URL");
  document.querySelector('.tab[data-tab="console"]').click();
  await fetch("/api/github/deploy/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl }),
  });
});
$("deployPrivateBtn").addEventListener("click", async () => {
  const repoUrl = $("privateRepoUrl").value.trim();
  const token = $("privateRepoToken").value.trim();
  if (!repoUrl || !token) return alert("Enter repo URL and access token");
  document.querySelector('.tab[data-tab="console"]').click();
  await fetch("/api/github/deploy/private", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl, token }),
  });
});

// ---------- Startup config ----------
async function loadStartupConfig() {
  const res = await fetch("/api/startup");
  const data = await res.json();
  $("mainFile").value = data.mainFile || "main.py";
  $("requirementsFile").value = data.requirementsFile || "requirements.txt";
}
$("saveStartupBtn").addEventListener("click", async () => {
  await fetch("/api/startup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mainFile: $("mainFile").value.trim(),
      requirementsFile: $("requirementsFile").value.trim(),
    }),
  });
  alert("Startup config saved");
});

// ---------- Profile ----------
$("updateCredBtn").addEventListener("click", async () => {
  const newUsername = $("newUsername").value.trim();
  const newPassword = $("newPassword").value;
  const confirmPassword = $("confirmPassword").value;
  if (newPassword && newPassword !== confirmPassword) {
    alert("Passwords do not match");
    return;
  }
  const res = await fetch("/api/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newUsername, newPassword }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Update failed");
    return;
  }
  $("newPassword").value = "";
  $("confirmPassword").value = "";
  alert("Credentials updated");
  refreshStatus();
});

// ---------- Admin ----------
$("createUserBtn").addEventListener("click", async () => {
  const username = $("newUserUsername").value.trim();
  const password = $("newUserPassword").value;
  const role = $("newUserRole").value;
  $("createUserError").textContent = "";
  const res = await fetch("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, role }),
  });
  const data = await res.json();
  if (!res.ok) {
    $("createUserError").textContent = data.error || "Failed to create user";
    return;
  }
  $("newUserUsername").value = "";
  $("newUserPassword").value = "";
  loadUsers();
});

async function loadUsers() {
  const res = await fetch("/api/admin/users");
  if (!res.ok) return;
  const data = await res.json();
  const list = $("usersList");
  list.innerHTML = "";
  data.users.forEach((u) => {
    const link = `${location.origin}/u/${encodeURIComponent(u.username)}`;
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `
      <div class="user-row-main">
        <b>${u.username}</b> <span class="role-badge ${u.role}">${u.role}</span>
        <div class="user-link">${link}</div>
      </div>
      <div class="user-row-actions">
        <button class="btn btn-outline small" data-act="view">👁 View As</button>
        <button class="btn btn-outline small" data-act="copy">🔗 Copy Link</button>
        <button class="btn btn-outline small" data-act="reset">🔑 Reset Pass</button>
        <button class="btn btn-outline small" data-act="delete">🗑 Delete</button>
      </div>
    `;
    row.querySelector('[data-act="view"]').addEventListener("click", async () => {
      await fetch("/api/admin/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.username }),
      });
      history.replaceState(null, "", "/u/" + encodeURIComponent(u.username));
      const res2 = await fetch("/api/me");
      me = await res2.json();
      showDashboard();
    });
    row.querySelector('[data-act="copy"]').addEventListener("click", () => {
      navigator.clipboard?.writeText(link);
      alert("Link copied:\n" + link);
    });
    row.querySelector('[data-act="reset"]').addEventListener("click", async () => {
      const pw = prompt(`New password for ${u.username} (min 6 chars):`);
      if (!pw) return;
      const r = await fetch(`/api/admin/users/${u.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const d = await r.json();
      if (!r.ok) alert(d.error || "Failed");
      else alert("Password updated");
    });
    row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
      const r = await fetch(`/api/admin/users/${u.id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) alert(d.error || "Failed");
      loadUsers();
    });
    list.appendChild(row);
  });
}
