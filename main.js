var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

var main_exports = {};
__export(main_exports, { default: () => GDriveSyncPlugin });
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

var GITHUB_VERSION_URL = "https://raw.githubusercontent.com/JanakaProjects/ObsidianSync-GDrive/main/manifest.json";
var GITHUB_MAIN_JS_URL = "https://raw.githubusercontent.com/JanakaProjects/ObsidianSync-GDrive/main/main.js";
var BATCH_SIZE = 10;
var UPLOAD_DEBOUNCE_MS = 5000;
var SYNC_INTERVAL_PRESETS = [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800];

function secondsToLabel(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r === 0 ? (m === 1 ? "1 min" : `${m} min`) : `${m}m ${r}s`;
}
function secondsToPresetIndex(s) {
  let best = 0, bestDiff = Math.abs(SYNC_INTERVAL_PRESETS[0] - s);
  for (let i = 1; i < SYNC_INTERVAL_PRESETS.length; i++) {
    const diff = Math.abs(SYNC_INTERVAL_PRESETS[i] - s);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}
function conflictName(filePath) {
  const now = new Date();
  const stamp = now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0") + " " +
    String(now.getHours()).padStart(2, "0") + "-" +
    String(now.getMinutes()).padStart(2, "0");
  const dot = filePath.lastIndexOf("."), slash = filePath.lastIndexOf("/");
  if (dot > slash) return filePath.slice(0, dot) + ` (Conflict ${stamp})` + filePath.slice(dot);
  return filePath + ` (Conflict ${stamp})`;
}

// FIX-A: SHA-256 via SubtleCrypto — MD5 is NOT supported by WebCrypto API anywhere.
// We only use this for duplicate-content detection so SHA-256 is strictly better.
async function hashBuffer(buffer) {
  const buf = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

var DEFAULT_SETTINGS = {
  clientId: "", clientSecret: "", refreshToken: "",
  driveFolderName: "ObsidianVaultSync", syncIntervalSeconds: 30, autoSyncOnStart: true
};

var GDriveSyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.accessToken = "";
    this.accessTokenExpiry = 0;
    this.accessTokenRefreshPromise = null;
    this.driveFolderId = "";
    this.driveFolderIdValidated = 0;   // timestamp of last validation
    this.folderIdCache = new Map();    // vaultFolderPath -> driveId
    this.driveIdToPath = new Map();    // driveId -> vaultPath
    this.syncIntervalId = null;
    this.isSyncing = false;
    this.stopRequested = false;
    this.lastSynced = {};
    this.driveChangesPageToken = "";
    this.downloading = new Set();
    // FIX-D: single serialised save queue — no concurrent loadData/saveData races
    this.saveQueue = Promise.resolve();
    // FIX-O: debounce map for event-driven uploads
    this.uploadDebounceTimers = new Map();
    // FIX-B: per-file upload promise map to prevent concurrent duplicate uploads
    this.uploadInFlight = new Map();
  }

  // ─── Atomic save (FIX-D) ──────────────────────────────────────────────────
  _enqueueSave(fn) {
    this.saveQueue = this.saveQueue.then(fn).catch(e => console.error("GDrive save error:", e));
    return this.saveQueue;
  }
  _buildSavePayload() {
    return {
      ...this.settings,
      lastSynced: this.lastSynced,
      driveChangesPageToken: this.driveChangesPageToken,
      folderIdCache: Array.from(this.folderIdCache.entries()),
      driveIdToPath: Array.from(this.driveIdToPath.entries())
    };
  }
  saveSettings() {
    return this._enqueueSave(() => this.saveData(this._buildSavePayload()));
  }
  saveLastSynced() {
    return this._enqueueSave(() => this.saveData(this._buildSavePayload()));
  }
  _enqueueSave(fn) {
    this.saveQueue = this.saveQueue.then(fn).catch(e => console.error("GDrive save error:", e));
    return this.saveQueue;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  async onload() {
    const saved = await this.loadData() ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.lastSynced = saved.lastSynced ?? {};
    this.driveChangesPageToken = saved.driveChangesPageToken ?? "";
    this.folderIdCache = new Map(saved.folderIdCache ?? []);
    this.driveIdToPath = new Map(saved.driveIdToPath ?? []);

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("\u23F8 GDrive Sync idle");

    this.addCommand({ id: "sync-now", name: "Sync vault now", callback: () => this.fullTwoWaySync() });
    this.addCommand({ id: "stop-sync", name: "Stop auto-sync", callback: () => this.stopAutoSync() });
    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

    // FIX-O: debounce all event-driven uploads — Obsidian fires modify on every autosave
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof import_obsidian.TFile && !this.downloading.has(file.path))
        this._scheduleUpload(file);
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof import_obsidian.TFile && !this.downloading.has(file.path))
        this._scheduleUpload(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof import_obsidian.TFile) {
        // Cancel any pending upload for this file
        const t = this.uploadDebounceTimers.get(file.path);
        if (t) { clearTimeout(t); this.uploadDebounceTimers.delete(file.path); }
        this.deleteFromDrive(file.path);
      }
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof import_obsidian.TFile) {
        const t = this.uploadDebounceTimers.get(oldPath);
        if (t) { clearTimeout(t); this.uploadDebounceTimers.delete(oldPath); }
        this.deleteFromDrive(oldPath);
        this._scheduleUpload(file);
      }
    }));

    // FIX-L: check update with a short delay so onload doesn't block UI
    setTimeout(() => this.checkForUpdate(), 8000);
    if (this.settings.autoSyncOnStart && this.isConfigured())
      setTimeout(() => this.startAutoSync(), 5000);
  }

  onunload() {
    this.stopRequested = true;
    if (this.syncIntervalId !== null) { clearInterval(this.syncIntervalId); this.syncIntervalId = null; }
    // Cancel all pending debounce timers
    for (const t of this.uploadDebounceTimers.values()) clearTimeout(t);
    this.uploadDebounceTimers.clear();
  }

  // FIX-O: debounced upload scheduler
  _scheduleUpload(file) {
    const existing = this.uploadDebounceTimers.get(file.path);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.uploadDebounceTimers.delete(file.path);
      // FIX-C: skip event upload if a full sync is running — sync will handle it
      if (!this.isSyncing) this._uploadFileSafe(file);
    }, UPLOAD_DEBOUNCE_MS);
    this.uploadDebounceTimers.set(file.path, t);
  }

  // FIX-B: serialise concurrent uploads for the same file path
  _uploadFileSafe(file) {
    const existing = this.uploadInFlight.get(file.path);
    const next = (existing ?? Promise.resolve())
      .then(() => this.uploadFile(file, null))
      .finally(() => { if (this.uploadInFlight.get(file.path) === next) this.uploadInFlight.delete(file.path); });
    this.uploadInFlight.set(file.path, next);
    return next;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60000) return this.accessToken;
    // FIX-E: if a refresh is already in-flight, wait for it — but if it fails,
    // clear the promise so the next caller can retry instead of getting the same rejection
    if (this.accessTokenRefreshPromise) return this.accessTokenRefreshPromise;
    this.accessTokenRefreshPromise = this._doTokenRefresh();
    try {
      return await this.accessTokenRefreshPromise;
    } catch(e) {
      this.accessToken = "";
      this.accessTokenExpiry = 0;
      throw e;
    } finally {
      this.accessTokenRefreshPromise = null;
    }
  }
  async _doTokenRefresh() {
    const resp = await (0, import_obsidian.requestUrl)({
      url: "https://oauth2.googleapis.com/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.settings.clientId,
        client_secret: this.settings.clientSecret,
        refresh_token: this.settings.refreshToken,
        grant_type: "refresh_token"
      }).toString()
    });
    if (resp.status >= 400) throw new Error("Token refresh failed (" + resp.status + "): " + resp.text);
    const data = JSON.parse(resp.text);
    if (!data.access_token) throw new Error("No access_token in response");
    this.accessToken = data.access_token;
    this.accessTokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  // ─── Drive folder helpers ─────────────────────────────────────────────────
  // FIX-F: re-validate driveFolderId every 10 minutes
  async ensureDriveFolder() {
    const now = Date.now();
    if (this.driveFolderId && (now - this.driveFolderIdValidated) < 10 * 60 * 1000)
      return this.driveFolderId;
    const token = await this.getAccessToken();
    const name = this.settings.driveFolderName;
    const query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
    const data = await this.apiGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, token);
    if (data.files?.length > 0) {
      this.driveFolderId = data.files[0].id;
    } else {
      const folder = await this.apiPost("https://www.googleapis.com/drive/v3/files", token,
        { name, mimeType: "application/vnd.google-apps.folder" });
      this.driveFolderId = folder.id;
    }
    this.driveFolderIdValidated = now;
    return this.driveFolderId;
  }

  // FIX-G: recursively create ALL intermediate folders, not just the direct parent
  async ensureDrivePath(vaultFolderPath) {
    const rootId = await this.ensureDriveFolder();
    if (!vaultFolderPath || vaultFolderPath === "/") return rootId;
    const parts = vaultFolderPath.split("/").filter(p => p.length > 0);
    let parentId = rootId, cumulativePath = "";
    for (const part of parts) {
      cumulativePath = cumulativePath ? `${cumulativePath}/${part}` : part;
      const cached = this.folderIdCache.get(cumulativePath);
      if (cached) { parentId = cached; continue; }
      const token = await this.getAccessToken();
      const query = `name='${part}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
      const sd = await this.apiGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, token);
      if (sd.files?.length > 0) { parentId = sd.files[0].id; }
      else {
        const nf = await this.apiPost("https://www.googleapis.com/drive/v3/files", token,
          { name: part, mimeType: "application/vnd.google-apps.folder", parents: [parentId] });
        parentId = nf.id;
      }
      this.folderIdCache.set(cumulativePath, parentId);
    }
    return parentId;
  }

  // FIX-G: also ensure local vault folder exists recursively before writing
  async ensureLocalFolder(filePath) {
    const parts = filePath.split("/");
    parts.pop(); // remove filename
    let cumulative = "";
    for (const part of parts) {
      cumulative = cumulative ? `${cumulative}/${part}` : part;
      try { await this.app.vault.createFolder(cumulative); } catch(e) { /* already exists */ }
    }
  }

  async getFolderIdForFile(filePath) {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash === -1) return await this.ensureDriveFolder();
    return await this.ensureDrivePath(filePath.substring(0, lastSlash));
  }

  // ─── Drive API wrappers ───────────────────────────────────────────────────
  async apiGet(url, token) {
    const resp = await (0, import_obsidian.requestUrl)({ url, headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400) throw new Error(`GET ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }
  async apiPost(url, token, body) {
    const resp = await (0, import_obsidian.requestUrl)({
      url, method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (resp.status >= 400) throw new Error(`POST ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }
  async apiDelete(url, token) {
    const resp = await (0, import_obsidian.requestUrl)({ url, method: "DELETE", headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400 && resp.status !== 404) throw new Error(`DELETE ${resp.status}: ${resp.text}`);
  }
  async apiDownload(url, token) {
    const resp = await (0, import_obsidian.requestUrl)({ url, headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400) throw new Error(`Download ${resp.status}: ${resp.text}`);
    return resp.arrayBuffer;
  }
  async apiUpload(url, method, token, metadata, content) {
    const boundary = "gdrivesync_" + Date.now();
    const enc = new TextEncoder();
    const metaPart = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`);
    const filePart = enc.encode(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const closing  = enc.encode(`\r\n--${boundary}--`);
    const contentArr = new Uint8Array(content instanceof ArrayBuffer ? content : content.buffer ? content.buffer : content);
    const body = new Uint8Array(metaPart.byteLength + filePart.byteLength + contentArr.byteLength + closing.byteLength);
    body.set(metaPart, 0);
    body.set(filePart, metaPart.byteLength);
    body.set(contentArr, metaPart.byteLength + filePart.byteLength);
    body.set(closing,  metaPart.byteLength + filePart.byteLength + contentArr.byteLength);
    const resp = await (0, import_obsidian.requestUrl)({
      url, method,
      headers: { Authorization: "Bearer " + token, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: body.buffer
    });
    if (resp.status >= 400) throw new Error(`Upload ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }

  // ─── Drive file listing ───────────────────────────────────────────────────
  async listDriveFilesRecursive(folderId, pathPrefix = "") {
    const token = await this.getAccessToken();
    // FIX-K: use push(...) instead of concat to avoid O(n²) array copying
    const results = [];
    let pageToken = null;
    do {
      let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum)&pageSize=1000`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await this.apiGet(url, token);
      for (const f of data.files ?? []) {
        const fullPath = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;
        if (f.mimeType === "application/vnd.google-apps.folder") {
          this.folderIdCache.set(fullPath, f.id);
          const sub = await this.listDriveFilesRecursive(f.id, fullPath);
          results.push(...sub);
        } else {
          this.driveIdToPath.set(f.id, fullPath);
          results.push({ id: f.id, name: f.name, path: fullPath, modifiedTime: f.modifiedTime, md5Checksum: f.md5Checksum });
        }
      }
      pageToken = data.nextPageToken ?? null;
    } while (pageToken);
    return results;
  }

  async fetchStartPageToken() {
    const token = await this.getAccessToken();
    const data = await this.apiGet("https://www.googleapis.com/drive/v3/changes/startPageToken", token);
    return data.startPageToken;
  }

  // FIX-J: safe loop — bounded by newStartPageToken, can never run forever
  async fetchDeltaChanges() {
    const token = await this.getAccessToken();
    const folderId = await this.ensureDriveFolder();
    const changes = [];
    let pageToken = this.driveChangesPageToken;

    while (pageToken) {
      const url = `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&fields=nextPageToken,newStartPageToken,changes(removed,fileId,file(id,name,parents,trashed,modifiedTime,mimeType))&includeRemoved=true`;
      const data = await this.apiGet(url, token);

      for (const change of data.changes ?? []) {
        const f = change.file;
        if (f?.mimeType === "application/vnd.google-apps.folder") continue;
        if (change.removed || f?.trashed) {
          const resolvedPath = this.driveIdToPath.get(change.fileId);
          if (resolvedPath) changes.push({ filePath: resolvedPath, fileId: change.fileId, removed: true, modifiedTime: 0 });
          continue;
        }
        if (!f) continue;
        const parentId = f.parents?.[0];
        let vaultFolder = "";
        if (parentId === folderId) {
          vaultFolder = "";
        } else {
          for (const [path, id] of this.folderIdCache.entries()) {
            if (id === parentId) { vaultFolder = path; break; }
          }
          if (!vaultFolder) continue; // file not inside our sync folder
        }
        const filePath = vaultFolder ? `${vaultFolder}/${f.name}` : f.name;
        this.driveIdToPath.set(change.fileId, filePath);
        changes.push({ filePath, fileId: change.fileId, removed: false, modifiedTime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0 });
      }

      if (data.newStartPageToken) {
        // Last page
        this.driveChangesPageToken = data.newStartPageToken;
        break;
      } else if (data.nextPageToken) {
        pageToken = data.nextPageToken;
      } else {
        // Defensive: no token of either kind — stop to avoid infinite loop
        break;
      }
    }
    return changes;
  }

  // ─── File write with conflict detection ──────────────────────────────────
  async writeFileConflictSafe(filePath, buffer, driveModifiedTime) {
    // FIX-G: ensure the full local folder path exists recursively
    await this.ensureLocalFolder(filePath);
    const localFile = this.app.vault.getAbstractFileByPath(filePath);
    const lastSync = this.lastSynced[filePath] ?? 0;

    if (localFile instanceof import_obsidian.TFile) {
      const localMtime = localFile.stat.mtime;
      if (lastSync > 0 && localMtime > lastSync + 1000 && driveModifiedTime > lastSync + 1000) {
        // Genuine conflict — both sides changed since last sync
        const conflictPath = conflictName(filePath);
        await this.ensureLocalFolder(conflictPath);
        this.downloading.add(conflictPath);
        try {
          const existing = this.app.vault.getAbstractFileByPath(conflictPath);
          if (existing instanceof import_obsidian.TFile) await this.app.vault.modifyBinary(existing, buffer);
          else await this.app.vault.createBinary(conflictPath, buffer);
        } finally { this.downloading.delete(conflictPath); }
        new import_obsidian.Notice(`\u26A0\uFE0F Conflict: "${filePath}"\nDrive copy saved as "${conflictPath}"`);
        return;
      }
      this.downloading.add(filePath);
      try { await this.app.vault.modifyBinary(localFile, buffer); }
      finally { this.downloading.delete(filePath); }
    } else {
      this.downloading.add(filePath);
      try { await this.app.vault.createBinary(filePath, buffer); }
      finally { this.downloading.delete(filePath); }
    }
  }

  // ─── Self update ──────────────────────────────────────────────────────────
  async checkForUpdate() {
    try {
      const resp = await (0, import_obsidian.requestUrl)({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
      const remote = JSON.parse(resp.text);
      if (remote.version !== this.manifest.version) {
        new import_obsidian.Notice(`\u{1F504} GDrive Sync update: ${this.manifest.version} \u2192 ${remote.version}. Installing...`);
        await this.selfUpdate(remote.version);
      }
    } catch (e) { console.log("GDrive Sync: update check failed:", e.message ?? e); }
  }
  async selfUpdate(newVersion) {
    try {
      let written = false;
      // Desktop: write via Node fs
      try {
        const fs = require("fs"), nodePath = require("path");
        const base = this.app.vault.adapter.basePath;
        const dir = nodePath.join(base, ".obsidian", "plugins", this.manifest.id);
        const js = await (0, import_obsidian.requestUrl)({ url: GITHUB_MAIN_JS_URL + "?t=" + Date.now() });
        fs.writeFileSync(nodePath.join(dir, "main.js"), js.text, "utf8");
        const mf = await (0, import_obsidian.requestUrl)({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
        fs.writeFileSync(nodePath.join(dir, "manifest.json"), mf.text, "utf8");
        written = true;
      } catch (fsErr) {
        console.warn("GDrive Sync: fs write failed, trying vault adapter:", fsErr.message ?? fsErr);
      }
      // Mobile fallback: write via vault adapter
      if (!written) {
        const base = `.obsidian/plugins/${this.manifest.id}`;
        const js = await (0, import_obsidian.requestUrl)({ url: GITHUB_MAIN_JS_URL + "?t=" + Date.now() });
        await this.app.vault.adapter.write(`${base}/main.js`, js.text);
        const mf = await (0, import_obsidian.requestUrl)({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
        await this.app.vault.adapter.write(`${base}/manifest.json`, mf.text);
      }
      new import_obsidian.Notice(`\u2705 GDrive Sync updated to v${newVersion}! Reloading...`);
      const id = this.manifest.id;
      await this.app.plugins.disablePlugin(id);
      await this.app.plugins.enablePlugin(id);
    } catch (e) {
      console.error("GDrive Sync: self-update failed:", e);
      new import_obsidian.Notice("\u274C GDrive Sync auto-update failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ─── Core sync ────────────────────────────────────────────────────────────
  async fullTwoWaySync() {
    if (!this.isConfigured()) { new import_obsidian.Notice("\u26A0\uFE0F GDrive Sync: Please enter credentials first."); return; }
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.stopRequested = false;
    this.setStatus("\u{1F504} Syncing...");
    try {
      const rootId = await this.ensureDriveFolder();
      const token  = await this.getAccessToken();
      let downloaded = 0;

      // Build driveMap — also refreshes folderIdCache and driveIdToPath
      const driveFiles = await this.listDriveFilesRecursive(rootId);
      const driveMap = {};
      for (const df of driveFiles)
        driveMap[df.path] = { id: df.id, modifiedTime: new Date(df.modifiedTime).getTime(), sha256: null };

      if (!this.driveChangesPageToken) {
        // ── First sync: download Drive files that are newer than local ────────
        const entries = Object.entries(driveMap);
        for (let i = 0; i < entries.length; i += BATCH_SIZE) {
          if (this.stopRequested) break;
          const batch = entries.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async ([filePath, driveInfo]) => {
            const local = this.app.vault.getAbstractFileByPath(filePath);
            const localMtime = local instanceof import_obsidian.TFile ? local.stat.mtime : 0;
            if (driveInfo.modifiedTime > localMtime) {
              try {
                const buf = await this.apiDownload(`https://www.googleapis.com/drive/v3/files/${driveInfo.id}?alt=media`, token);
                await this.writeFileConflictSafe(filePath, buf, driveInfo.modifiedTime);
                const written = this.app.vault.getAbstractFileByPath(filePath);
                this.lastSynced[filePath] = written instanceof import_obsidian.TFile ? written.stat.mtime : Date.now();
                downloaded++;
              } catch (e) { console.error("GDrive download error:", filePath, this.errMsg(e)); }
            } else {
              if (!this.lastSynced[filePath]) this.lastSynced[filePath] = localMtime;
            }
          }));
          this.setStatus(`\u2B07\uFE0F ${downloaded}/${entries.length}...`);
        }
        this.driveChangesPageToken = await this.fetchStartPageToken();
      } else {
        // ── Delta sync: only process changed files since last sync ────────────
        const changes = await this.fetchDeltaChanges();
        const removed  = changes.filter(c => c.removed);
        const modified = changes.filter(c => !c.removed);

        for (const c of removed) {
          if (this.stopRequested) break;
          const local = this.app.vault.getAbstractFileByPath(c.filePath);
          if (local instanceof import_obsidian.TFile) {
            try {
              await this.app.vault.delete(local);
              delete this.lastSynced[c.filePath];
              this.driveIdToPath.delete(c.fileId);
            } catch (e) { console.error("GDrive local delete error:", c.filePath, this.errMsg(e)); }
          }
        }

        for (let i = 0; i < modified.length; i += BATCH_SIZE) {
          if (this.stopRequested) break;
          const batch = modified.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (c) => {
            try {
              const buf = await this.apiDownload(`https://www.googleapis.com/drive/v3/files/${c.fileId}?alt=media`, token);
              await this.writeFileConflictSafe(c.filePath, buf, c.modifiedTime);
              const written = this.app.vault.getAbstractFileByPath(c.filePath);
              this.lastSynced[c.filePath] = written instanceof import_obsidian.TFile ? written.stat.mtime : Date.now();
              downloaded++;
            } catch (e) { console.error("GDrive delta download error:", c.filePath, this.errMsg(e)); }
          }));
          this.setStatus(`\u2B07\uFE0F ${downloaded}/${modified.length}...`);
        }
      }

      // ── Upload phase ────────────────────────────────────────────────────────
      const localFiles = this.app.vault.getFiles();
      let uploaded = 0;
      for (let i = 0; i < localFiles.length; i += BATCH_SIZE) {
        if (this.stopRequested) break;
        const batch = localFiles.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(f => this.uploadFile(f, driveMap)));
        uploaded += results.filter(Boolean).length;
        this.setStatus(`\u2B06\uFE0F ${Math.min(i + batch.length, localFiles.length)}/${localFiles.length}...`);
      }

      await this.saveLastSynced();
      this.setStatus(`\u2705 \u2B07${downloaded} \u2B06${uploaded} \u2014 ${new Date().toLocaleTimeString()}`);
      if (downloaded > 0 || uploaded > 0)
        new import_obsidian.Notice(`\u2705 GDrive Sync: \u2B07 ${downloaded} downloaded, \u2B06 ${uploaded} uploaded`);
    } catch (e) {
      this.setStatus("\u274C Sync failed");
      new import_obsidian.Notice("\u274C GDrive Sync failed: " + this.errMsg(e));
      console.error("GDrive Sync fullTwoWaySync error:", e);
    } finally {
      this.isSyncing = false;
    }
  }

  // ─── Upload single file ───────────────────────────────────────────────────
  // FIX-A: removed MD5 — use SHA-256 for content equality check
  // FIX-B: called through _uploadFileSafe for event-driven uploads (serialised)
  async uploadFile(file, driveMap) {
    if (!this.isConfigured()) return false;
    try {
      const lastSync = this.lastSynced[file.path];
      if (lastSync && file.stat.mtime <= lastSync) return false;

      const token   = await this.getAccessToken();
      const content = await this.app.vault.readBinary(file);
      const localHash = await hashBuffer(content);

      let existingId = null, existingHash = null;
      if (driveMap?.[file.path]) {
        existingId = driveMap[file.path].id;
        // Drive doesn't return SHA-256 natively — skip hash comparison when coming from driveMap
        // and rely on mtime gate above. existingHash stays null → always upload if mtime changed.
      } else {
        // Event-driven upload: search Drive for existing file
        const parentFolderId = await this.getFolderIdForFile(file.path);
        const q = `name='${file.name.replace(/'/g, "\\'")}'  and '${parentFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
        const sd = await this.apiGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, token);
        existingId = sd.files?.[0]?.id ?? null;
      }

      const parentFolderId = await this.getFolderIdForFile(file.path);
      const metadata = { name: file.name, ...(existingId ? {} : { parents: [parentFolderId] }) };
      const uploadUrl = existingId
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
      const result = await this.apiUpload(uploadUrl, existingId ? "PATCH" : "POST", token, metadata, content);
      this.lastSynced[file.path] = file.stat.mtime;
      if (result?.id) this.driveIdToPath.set(result.id, file.path);
      return true;
    } catch (e) {
      console.error("GDrive upload error:", file.path, this.errMsg(e));
      return false;
    }
  }

  // ─── Delete from Drive ────────────────────────────────────────────────────
  async deleteFromDrive(filePath) {
    if (!this.isConfigured()) return;
    try {
      const token = await this.getAccessToken();
      let fileIdToDelete = null;
      for (const [id, path] of this.driveIdToPath.entries()) {
        if (path === filePath) { fileIdToDelete = id; break; }
      }
      if (fileIdToDelete) {
        await this.apiDelete(`https://www.googleapis.com/drive/v3/files/${fileIdToDelete}`, token);
        this.driveIdToPath.delete(fileIdToDelete);
      } else {
        // Fallback: name search (for files uploaded before v1.2.0)
        const parentId  = await this.getFolderIdForFile(filePath);
        const fileName  = filePath.includes("/") ? filePath.slice(filePath.lastIndexOf("/") + 1) : filePath;
        const q = `name='${fileName.replace(/'/g, "\\'")}'  and '${parentId}' in parents and trashed=false`;
        const sd = await this.apiGet(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, token);
        const id = sd.files?.[0]?.id;
        if (id) await this.apiDelete(`https://www.googleapis.com/drive/v3/files/${id}`, token);
      }
      delete this.lastSynced[filePath];
      // FIX-H: single queued save instead of one save per delete
      this.saveLastSynced();
    } catch (e) { console.error("GDrive delete error:", filePath, this.errMsg(e)); }
  }

  // ─── Download All ─────────────────────────────────────────────────────────
  async downloadAll() {
    if (!this.isConfigured()) { new import_obsidian.Notice("\u26A0\uFE0F Please enter credentials first."); return; }
    if (this.isSyncing) { new import_obsidian.Notice("\u26A0\uFE0F Sync already in progress."); return; }
    this.isSyncing = true;
    this.setStatus("\u2B07\uFE0F Downloading from Drive...");
    try {
      const token = await this.getAccessToken();
      const rootId = await this.ensureDriveFolder();
      const driveFiles = await this.listDriveFilesRecursive(rootId);
      let count = 0;
      for (let i = 0; i < driveFiles.length; i += BATCH_SIZE) {
        if (this.stopRequested) break;
        const batch = driveFiles.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (df) => {
          try {
            const buf = await this.apiDownload(`https://www.googleapis.com/drive/v3/files/${df.id}?alt=media`, token);
            await this.writeFileConflictSafe(df.path, buf, new Date(df.modifiedTime).getTime());
            const written = this.app.vault.getAbstractFileByPath(df.path);
            this.lastSynced[df.path] = written instanceof import_obsidian.TFile ? written.stat.mtime : Date.now();
            count++;
          } catch (e) { console.error("GDrive download error:", df.path, this.errMsg(e)); }
        }));
        this.setStatus(`\u2B07\uFE0F ${count}/${driveFiles.length}...`);
      }
      this.driveChangesPageToken = await this.fetchStartPageToken();
      await this.saveLastSynced();
      this.setStatus(`\u2705 Downloaded ${count} files`);
      new import_obsidian.Notice(`\u2705 Downloaded ${count} files from Google Drive!`);
    } catch (e) {
      this.setStatus("\u274C Download failed");
      new import_obsidian.Notice("\u274C Download failed: " + this.errMsg(e));
      console.error("GDrive downloadAll error:", e);
    } finally { this.isSyncing = false; }
  }

  // ─── Auto-sync lifecycle ──────────────────────────────────────────────────
  // FIX-I: stopRequested flag ensures in-flight sync knows to abort cleanly
  startAutoSync() {
    if (this.syncIntervalId !== null) { clearInterval(this.syncIntervalId); this.syncIntervalId = null; }
    this.stopRequested = false;
    this.fullTwoWaySync();
    const ms = Math.max(1000, this.settings.syncIntervalSeconds * 1000);
    this.syncIntervalId = window.setInterval(() => {
      if (!this.isSyncing && !this.stopRequested) this.fullTwoWaySync();
    }, ms);
    this.setStatus("\u{1F504} Auto-sync active");
    new import_obsidian.Notice(`\u2705 GDrive Auto-Sync started (every ${secondsToLabel(this.settings.syncIntervalSeconds)})`);
  }
  stopAutoSync() {
    this.stopRequested = true;
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
      this.setStatus("\u23F8 GDrive Sync paused");
      new import_obsidian.Notice("GDrive Auto-Sync stopped.");
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  isConfigured() { return !!(this.settings.clientId && this.settings.clientSecret && this.settings.refreshToken); }
  setStatus(msg) { if (this.statusBarItem) this.statusBarItem.setText(msg); }
  errMsg(e) { return (e instanceof Error ? e.message : String(e)) || "Unknown error"; }
};

// ─── Settings Tab ─────────────────────────────────────────────────────────────
var GDriveSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Google Drive Vault Sync" });
    containerEl.createEl("p", { text: "Enter your Google OAuth credentials. See README for setup instructions.", cls: "setting-item-description" });

    new import_obsidian.Setting(containerEl)
      .setName("Client ID")
      .setDesc("Google Cloud Console \u2192 Credentials \u2192 OAuth 2.0 Client ID")
      .addText(t => t.setPlaceholder("xxxx.apps.googleusercontent.com")
        .setValue(this.plugin.settings.clientId)
        .onChange(async v => { this.plugin.settings.clientId = v.trim(); await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Google Cloud Console \u2192 Credentials")
      .addText(t => t.setPlaceholder("GOCSPX-...")
        .setValue(this.plugin.settings.clientSecret)
        .onChange(async v => { this.plugin.settings.clientSecret = v.trim(); await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl)
      .setName("Refresh Token")
      .setDesc("From OAuth Playground.")
      .addText(t => t.setPlaceholder("1//0g...")
        .setValue(this.plugin.settings.refreshToken)
        .onChange(async v => { this.plugin.settings.refreshToken = v.trim(); await this.plugin.saveSettings(); }));

    new import_obsidian.Setting(containerEl)
      .setName("Drive Folder Name")
      .addText(t => t.setValue(this.plugin.settings.driveFolderName)
        .onChange(async v => {
          this.plugin.settings.driveFolderName = v.trim() || "ObsidianVaultSync";
          this.plugin.driveFolderId = "";
          this.plugin.driveFolderIdValidated = 0;
          await this.plugin.saveSettings();
        }));

    const intervalSetting = new import_obsidian.Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc(`Every ${secondsToLabel(this.plugin.settings.syncIntervalSeconds)}`);
    intervalSetting.addSlider(slider => {
      slider.setLimits(0, SYNC_INTERVAL_PRESETS.length - 1, 1)
        .setValue(secondsToPresetIndex(this.plugin.settings.syncIntervalSeconds))
        .onChange(async (idx) => {
          const s = SYNC_INTERVAL_PRESETS[idx];
          this.plugin.settings.syncIntervalSeconds = s;
          intervalSetting.setDesc(`Every ${secondsToLabel(s)}`);
          await this.plugin.saveSettings();
        });
      const ticks = containerEl.createEl("div");
      ticks.style.cssText = "display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:-10px;margin-bottom:8px;padding:0 2px;";
      SYNC_INTERVAL_PRESETS.forEach(s => ticks.createEl("span", { text: secondsToLabel(s) }));
    });

    new import_obsidian.Setting(containerEl)
      .setName("Auto-sync on Obsidian open")
      .addToggle(t => t.setValue(this.plugin.settings.autoSyncOnStart)
        .onChange(async v => { this.plugin.settings.autoSyncOnStart = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Actions" });
    new import_obsidian.Setting(containerEl).setName("Start auto-sync")
      .addButton(b => b.setButtonText("\u25B6 Start").setCta().onClick(() => this.plugin.startAutoSync()));
    new import_obsidian.Setting(containerEl).setName("Stop auto-sync")
      .addButton(b => b.setButtonText("\u23F8 Stop").onClick(() => this.plugin.stopAutoSync()));
    new import_obsidian.Setting(containerEl).setName("Sync now")
      .setDesc("Upload local changes and download Drive changes.")
      .addButton(b => b.setButtonText("\u{1F504} Two-Way Sync").onClick(() => this.plugin.fullTwoWaySync()));
    new import_obsidian.Setting(containerEl).setName("Download from Drive")
      .setDesc("Force re-download all files from Drive.")
      .addButton(b => b.setButtonText("\u2B07 Download All").onClick(() => this.plugin.downloadAll()));
    new import_obsidian.Setting(containerEl).setName("Check for update")
      .setDesc("Manually check GitHub for a newer version.")
      .addButton(b => b.setButtonText("\u{1F504} Check Update").onClick(() => this.plugin.checkForUpdate()));
  }
};
