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

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GDriveSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var GITHUB_VERSION_URL = "https://raw.githubusercontent.com/JanakaProjects/ObsidianSync-GDrive/main/manifest.json";
var GITHUB_MAIN_JS_URL = "https://raw.githubusercontent.com/JanakaProjects/ObsidianSync-GDrive/main/main.js";
var BATCH_SIZE = 5;
var SYNC_INTERVAL_PRESETS = [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800];
function secondsToLabel(s) {
  if (s < 60)
    return `${s}s`;
  const m = s / 60;
  return m === 1 ? "1 min" : `${m} min`;
}
function secondsToPresetIndex(s) {
  let best = 0;
  let bestDiff = Math.abs(SYNC_INTERVAL_PRESETS[0] - s);
  for (let i = 1; i < SYNC_INTERVAL_PRESETS.length; i++) {
    const diff = Math.abs(SYNC_INTERVAL_PRESETS[i] - s);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}
function conflictName(filePath) {
  const now = new Date();
  const stamp = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0") + " " + String(now.getHours()).padStart(2, "0") + "-" + String(now.getMinutes()).padStart(2, "0");
  const dot = filePath.lastIndexOf(".");
  const slash = filePath.lastIndexOf("/");
  if (dot > slash) {
    return filePath.slice(0, dot) + ` (Conflict ${stamp})` + filePath.slice(dot);
  }
  return filePath + ` (Conflict ${stamp})`;
}
var DEFAULT_SETTINGS = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  driveFolderName: "ObsidianVaultSync",
  syncIntervalSeconds: 30,
  autoSyncOnStart: true
};
var GDriveSyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.accessToken = "";
    this.accessTokenExpiry = 0;
    this.accessTokenRefreshPromise = null;
    this.driveFolderId = "";
    // Cache: folderPath (relative to vault root in Drive) -> Drive folder ID
    this.folderIdCache = /* @__PURE__ */ new Map();
    this.syncIntervalId = null;
    this.isSyncing = false;
    this.lastSynced = {};
    this.driveChangesPageToken = "";
    this.downloading = /* @__PURE__ */ new Set();
  }
  async onload() {
    var _a, _b, _c;
    const saved = (_a = await this.loadData()) != null ? _a : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.lastSynced = (_b = saved.lastSynced) != null ? _b : {};
    this.driveChangesPageToken = (_c = saved.driveChangesPageToken) != null ? _c : "";
    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("\u23F8 GDrive Sync idle");
    this.addCommand({ id: "sync-now", name: "Sync vault now", callback: () => this.fullTwoWaySync() });
    this.addCommand({ id: "stop-sync", name: "Stop auto-sync", callback: () => this.stopAutoSync() });
    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof import_obsidian.TFile && !this.downloading.has(file.path))
        this.uploadFile(file);
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof import_obsidian.TFile && !this.downloading.has(file.path))
        this.uploadFile(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof import_obsidian.TFile)
        this.deleteFromDrive(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof import_obsidian.TFile) {
        this.deleteFromDrive(oldPath);
        this.uploadFile(file);
      }
    }));
    await this.checkForUpdate();
    if (this.settings.autoSyncOnStart && this.isConfigured()) {
      setTimeout(() => this.startAutoSync(), 3e3);
    }
  }
  onunload() {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }
  // ── HTTP helpers ──────────────────────────────────────────────────────
  async apiGet(url, token) {
    const resp = await (0, import_obsidian.requestUrl)({ url, headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400)
      throw new Error(`GET failed ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }
  async apiPost(url, token, body) {
    const resp = await (0, import_obsidian.requestUrl)({
      url,
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (resp.status >= 400)
      throw new Error(`POST failed ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }
  async apiDelete(url, token) {
    const resp = await (0, import_obsidian.requestUrl)({ url, method: "DELETE", headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400 && resp.status !== 404)
      throw new Error(`DELETE failed ${resp.status}: ${resp.text}`);
  }
  async apiDownload(url, token) {
    const resp = await (0, import_obsidian.requestUrl)({ url, headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400)
      throw new Error(`Download failed ${resp.status}: ${resp.text}`);
    return resp.arrayBuffer;
  }
  async apiUpload(url, method, token, metadata, content) {
    const boundary = "gdrivesync_" + Date.now();
    const enc = new TextEncoder();
    const metaPart = enc.encode(`--${boundary}\r
Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(metadata)}\r
`);
    const filePart = enc.encode(`--${boundary}\r
Content-Type: application/octet-stream\r
\r
`);
    const closing = enc.encode(`\r
--${boundary}--`);
    const body = new Uint8Array(metaPart.byteLength + filePart.byteLength + content.byteLength + closing.byteLength);
    body.set(metaPart, 0);
    body.set(filePart, metaPart.byteLength);
    body.set(new Uint8Array(content), metaPart.byteLength + filePart.byteLength);
    body.set(closing, metaPart.byteLength + filePart.byteLength + content.byteLength);
    const resp = await (0, import_obsidian.requestUrl)({
      url,
      method,
      headers: { Authorization: "Bearer " + token, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: body.buffer
    });
    if (resp.status >= 400)
      throw new Error(`Upload failed ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }
  // ── Auto-Updater ──────────────────────────────────────────────────────
  async checkForUpdate() {
    try {
      const resp = await (0, import_obsidian.requestUrl)({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
      const remote = JSON.parse(resp.text);
      if (remote.version !== this.manifest.version) {
        new import_obsidian.Notice(`\u{1F504} GDrive Sync: Update found (${this.manifest.version} \u2192 ${remote.version}). Installing...`);
        await this.selfUpdate(remote.version);
      }
    } catch (e) {
      console.log("GDrive Sync: update check failed", e);
    }
  }
  async selfUpdate(newVersion) {
    try {
      let written = false;
      try {
        const fs = require("fs");
        const nodePath = require("path");
        const basePath = this.app.vault.adapter.basePath;
        const pluginDir = nodePath.join(basePath, ".obsidian", "plugins", this.manifest.id);
        const jsResp = await (0, import_obsidian.requestUrl)({ url: GITHUB_MAIN_JS_URL + "?t=" + Date.now() });
        fs.writeFileSync(nodePath.join(pluginDir, "main.js"), jsResp.text, "utf8");
        const mResp = await (0, import_obsidian.requestUrl)({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
        fs.writeFileSync(nodePath.join(pluginDir, "manifest.json"), mResp.text, "utf8");
        written = true;
      } catch (e) {
      }
      if (!written) {
        const pluginPath = `.obsidian/plugins/${this.manifest.id}`;
        const jsResp = await (0, import_obsidian.requestUrl)({ url: GITHUB_MAIN_JS_URL + "?t=" + Date.now() });
        await this.app.vault.adapter.write(`${pluginPath}/main.js`, jsResp.text);
        const mResp = await (0, import_obsidian.requestUrl)({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
        await this.app.vault.adapter.write(`${pluginPath}/manifest.json`, mResp.text);
      }
      new import_obsidian.Notice(`\u2705 GDrive Sync updated to v${newVersion}! Reloading...`);
      const id = this.manifest.id;
      await this.app.plugins.disablePlugin(id);
      await this.app.plugins.enablePlugin(id);
    } catch (e) {
      console.error("GDrive Sync: self-update failed", e);
      new import_obsidian.Notice("\u274C GDrive Sync: Auto-update failed. Please update manually.");
    }
  }
  isConfigured() {
    return !!(this.settings.clientId && this.settings.clientSecret && this.settings.refreshToken);
  }
  setStatus(msg) {
    this.statusBarItem.setText(msg);
  }
  errMsg(e) {
    return (e instanceof Error ? e.message : String(e)) || "Unknown error";
  }
  async saveSettings() {
    var _a;
    const current = (_a = await this.loadData()) != null ? _a : {};
    await this.saveData({ ...current, ...this.settings, lastSynced: this.lastSynced, driveChangesPageToken: this.driveChangesPageToken });
  }
  async saveLastSynced() {
    var _a;
    const current = (_a = await this.loadData()) != null ? _a : {};
    await this.saveData({ ...current, lastSynced: this.lastSynced, driveChangesPageToken: this.driveChangesPageToken });
  }
  // ── OAuth ─────────────────────────────────────────────────────────────
  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 6e4)
      return this.accessToken;
    if (this.accessTokenRefreshPromise)
      return this.accessTokenRefreshPromise;
    this.accessTokenRefreshPromise = (async () => {
      const resp = await (0, import_obsidian.requestUrl)({
        url: "https://oauth2.googleapis.com/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          refresh_token: this.settings.refreshToken,
          grant_type: "refresh_token"
        }).toString()
      });
      if (resp.status >= 400)
        throw new Error("Token refresh failed: " + resp.text);
      const data = JSON.parse(resp.text);
      if (!data.access_token)
        throw new Error("No access_token in response: " + resp.text);
      this.accessToken = data.access_token;
      this.accessTokenExpiry = Date.now() + data.expires_in * 1e3;
      return this.accessToken;
    })();
    try {
      return await this.accessTokenRefreshPromise;
    } finally {
      this.accessTokenRefreshPromise = null;
    }
  }
  // ── Drive Root Folder ─────────────────────────────────────────────────
  async ensureDriveFolder() {
    var _a;
    if (this.driveFolderId)
      return this.driveFolderId;
    const token = await this.getAccessToken();
    const name = this.settings.driveFolderName;
    const query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
    const searchData = await this.apiGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
      token
    );
    if (((_a = searchData.files) == null ? void 0 : _a.length) > 0) {
      this.driveFolderId = searchData.files[0].id;
      return this.driveFolderId;
    }
    const folder = await this.apiPost("https://www.googleapis.com/drive/v3/files", token, {
      name,
      mimeType: "application/vnd.google-apps.folder"
    });
    this.driveFolderId = folder.id;
    return this.driveFolderId;
  }
  // ── Ensure nested subfolder path, returns leaf folder ID ─────────────
  // vaultFolderPath: e.g. "Notes/Work" relative to vault root
  async ensureDrivePath(vaultFolderPath) {
    var _a;
    const rootId = await this.ensureDriveFolder();
    if (!vaultFolderPath || vaultFolderPath === "/")
      return rootId;
    const parts = vaultFolderPath.split("/").filter((p) => p.length > 0);
    let parentId = rootId;
    let cumulativePath = "";
    for (const part of parts) {
      cumulativePath = cumulativePath ? `${cumulativePath}/${part}` : part;
      const cached = this.folderIdCache.get(cumulativePath);
      if (cached) {
        parentId = cached;
        continue;
      }
      const token = await this.getAccessToken();
      const query = `name='${part}' and mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents`;
      const searchData = await this.apiGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`,
        token
      );
      if (((_a = searchData.files) == null ? void 0 : _a.length) > 0) {
        parentId = searchData.files[0].id;
      } else {
        const newFolder = await this.apiPost("https://www.googleapis.com/drive/v3/files", token, {
          name: part,
          mimeType: "application/vnd.google-apps.folder",
          parents: [parentId]
        });
        parentId = newFolder.id;
      }
      this.folderIdCache.set(cumulativePath, parentId);
    }
    return parentId;
  }
  // ── Get folder ID for a vault file path ──────────────────────────────
  async getFolderIdForFile(filePath) {
    const lastSlash = filePath.lastIndexOf("/");
    if (lastSlash === -1)
      return await this.ensureDriveFolder();
    const folderPath = filePath.substring(0, lastSlash);
    return await this.ensureDrivePath(folderPath);
  }
  // ── Recursively list all files in Drive folder tree ───────────────────
  async listDriveFilesRecursive(folderId, pathPrefix = "") {
    const token = await this.getAccessToken();
    let results = [];
    let pageToken = null;
    do {
      let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=nextPageToken,files(id,name,mimeType,modifiedTime)`;
      if (pageToken)
        url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await this.apiGet(url, token);
      for (const f of data.files || []) {
        const fullPath = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;
        if (f.mimeType === "application/vnd.google-apps.folder") {
          this.folderIdCache.set(fullPath, f.id);
          const children = await this.listDriveFilesRecursive(f.id, fullPath);
          results = results.concat(children);
        } else {
          results.push({ id: f.id, name: f.name, path: fullPath, modifiedTime: f.modifiedTime });
        }
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return results;
  }
  // ── Delta Sync: Drive Changes API ─────────────────────────────────────
  async fetchStartPageToken() {
    const token = await this.getAccessToken();
    const data = await this.apiGet("https://www.googleapis.com/drive/v3/changes/startPageToken", token);
    return data.startPageToken;
  }
  async fetchDeltaChanges() {
    var _a;
    const token = await this.getAccessToken();
    const folderId = await this.ensureDriveFolder();
    const changes = [];
    let pageToken = this.driveChangesPageToken;
    let newPageToken = pageToken;
    do {
      const url = `https://www.googleapis.com/drive/v3/changes?pageToken=${encodeURIComponent(pageToken)}&fields=nextPageToken,newStartPageToken,changes(removed,fileId,file(id,name,parents,trashed,modifiedTime,mimeType))&includeRemoved=true`;
      const data = await this.apiGet(url, token);
      for (const change of data.changes || []) {
        const f = change.file;
        if (!f)
          continue;
        if (f.mimeType === "application/vnd.google-apps.folder")
          continue;
        if (change.removed || f.trashed) {
          changes.push({ filePath: change.fileId, fileId: change.fileId, removed: true, modifiedTime: 0 });
          continue;
        }
        const parentId = (_a = f.parents) == null ? void 0 : _a[0];
        let vaultFolder = "";
        if (parentId === folderId) {
          vaultFolder = "";
        } else {
          for (const [path, id] of this.folderIdCache.entries()) {
            if (id === parentId) {
              vaultFolder = path;
              break;
            }
          }
          if (!vaultFolder && parentId !== folderId)
            continue;
        }
        const filePath = vaultFolder ? `${vaultFolder}/${f.name}` : f.name;
        changes.push({
          filePath,
          fileId: change.fileId,
          removed: false,
          modifiedTime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0
        });
      }
      if (data.nextPageToken) {
        pageToken = data.nextPageToken;
      } else {
        newPageToken = data.newStartPageToken || pageToken;
        break;
      }
    } while (true);
    this.driveChangesPageToken = newPageToken;
    return changes;
  }
  // ── Conflict-safe file write ──────────────────────────────────────────
  async writeFileConflictSafe(filePath, buffer, driveModifiedTime) {
    var _a;
    const localFile = this.app.vault.getAbstractFileByPath(filePath);
    const lastSync = (_a = this.lastSynced[filePath]) != null ? _a : 0;
    const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : null;
    if (dir) {
      try {
        await this.app.vault.createFolder(dir);
      } catch (e) {
      }
    }
    if (localFile instanceof import_obsidian.TFile) {
      const localMtime = localFile.stat.mtime;
      if (lastSync > 0 && localMtime > lastSync && driveModifiedTime > lastSync) {
        const conflictPath = conflictName(filePath);
        const conflictDir = conflictPath.includes("/") ? conflictPath.substring(0, conflictPath.lastIndexOf("/")) : null;
        if (conflictDir) {
          try {
            await this.app.vault.createFolder(conflictDir);
          } catch (e) {
          }
        }
        this.downloading.add(conflictPath);
        try {
          await this.app.vault.createBinary(conflictPath, buffer);
        } catch (e) {
          const existing = this.app.vault.getAbstractFileByPath(conflictPath);
          if (existing instanceof import_obsidian.TFile)
            await this.app.vault.modifyBinary(existing, buffer);
        } finally {
          this.downloading.delete(conflictPath);
        }
        new import_obsidian.Notice(`\u26A0\uFE0F Conflict detected: "${filePath}"
Drive version saved as "${conflictPath}"`);
        return;
      }
      this.downloading.add(filePath);
      try {
        await this.app.vault.modifyBinary(localFile, buffer);
      } finally {
        this.downloading.delete(filePath);
      }
    } else {
      this.downloading.add(filePath);
      try {
        await this.app.vault.createBinary(filePath, buffer);
      } finally {
        this.downloading.delete(filePath);
      }
    }
  }
  // ── Two-way sync (delta-aware) ────────────────────────────────────────
  async fullTwoWaySync() {
    if (!this.isConfigured()) {
      new import_obsidian.Notice("\u26A0\uFE0F GDrive Sync: Please enter credentials first.");
      return;
    }
    if (this.isSyncing)
      return;
    this.isSyncing = true;
    this.setStatus("\u{1F504} Syncing...");
    try {
      const rootId = await this.ensureDriveFolder();
      const token = await this.getAccessToken();
      let downloaded = 0;
      if (!this.driveChangesPageToken) {
        const driveFiles = await this.listDriveFilesRecursive(rootId);
        const driveMap = {};
        for (const df of driveFiles) {
          driveMap[df.path] = { id: df.id, modifiedTime: new Date(df.modifiedTime).getTime() };
        }
        const driveEntries = Object.entries(driveMap);
        for (let i = 0; i < driveEntries.length; i += BATCH_SIZE) {
          const batch = driveEntries.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async ([filePath, driveInfo]) => {
            const localFile = this.app.vault.getAbstractFileByPath(filePath);
            const localMtime = localFile instanceof import_obsidian.TFile ? localFile.stat.mtime : 0;
            if (driveInfo.modifiedTime > localMtime) {
              try {
                const buffer = await this.apiDownload(
                  `https://www.googleapis.com/drive/v3/files/${driveInfo.id}?alt=media`,
                  token
                );
                await this.writeFileConflictSafe(filePath, buffer, driveInfo.modifiedTime);
                this.lastSynced[filePath] = driveInfo.modifiedTime;
                downloaded++;
              } catch (e) {
                console.error("Download error:", filePath, this.errMsg(e));
              }
            }
          }));
          this.setStatus(`\u2B07\uFE0F ${downloaded}/${driveEntries.length}...`);
        }
        this.driveChangesPageToken = await this.fetchStartPageToken();
      } else {
        const changes = await this.fetchDeltaChanges();
        const relevant = changes.filter((c) => !c.removed);
        const removed = changes.filter((c) => c.removed);
        for (const c of removed) {
          const localFile = this.app.vault.getAbstractFileByPath(c.filePath);
          if (localFile instanceof import_obsidian.TFile) {
            try {
              await this.app.vault.delete(localFile);
              delete this.lastSynced[c.filePath];
            } catch (e) {
              console.error("Local delete error:", c.filePath, this.errMsg(e));
            }
          }
        }
        for (let i = 0; i < relevant.length; i += BATCH_SIZE) {
          const batch = relevant.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (c) => {
            try {
              const buffer = await this.apiDownload(
                `https://www.googleapis.com/drive/v3/files/${c.fileId}?alt=media`,
                token
              );
              await this.writeFileConflictSafe(c.filePath, buffer, c.modifiedTime);
              this.lastSynced[c.filePath] = c.modifiedTime;
              downloaded++;
            } catch (e) {
              console.error("Delta download error:", c.filePath, this.errMsg(e));
            }
          }));
          this.setStatus(`\u2B07\uFE0F ${downloaded}/${relevant.length}...`);
        }
      }
      const localFiles = this.app.vault.getFiles();
      const toUpload = localFiles.filter((f) => {
        var _a;
        const lastSync = (_a = this.lastSynced[f.path]) != null ? _a : 0;
        return f.stat.mtime > lastSync;
      });
      let uploaded = 0;
      for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
        const batch = toUpload.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map((f) => this.uploadFile(f, true)));
        uploaded += results.filter(Boolean).length;
        this.setStatus(`\u2B06\uFE0F ${uploaded}/${toUpload.length}...`);
      }
      await this.saveLastSynced();
      this.setStatus(`\u2705 \u2B07${downloaded} \u2B06${uploaded} \u2014 ${new Date().toLocaleTimeString()}`);
      if (downloaded > 0 || uploaded > 0) {
        new import_obsidian.Notice(`\u2705 GDrive Sync: \u2B07 ${downloaded} downloaded, \u2B06 ${uploaded} uploaded`);
      }
    } catch (e) {
      this.setStatus("\u274C Sync failed");
      new import_obsidian.Notice("\u274C GDrive Sync failed: " + this.errMsg(e));
    } finally {
      this.isSyncing = false;
    }
  }
  // ── Upload single file ────────────────────────────────────────────────
  async uploadFile(file, force = false) {
    var _a, _b;
    if (!this.isConfigured())
      return false;
    if (!force && this.lastSynced[file.path] && this.lastSynced[file.path] >= file.stat.mtime)
      return false;
    try {
      const token = await this.getAccessToken();
      const parentFolderId = await this.getFolderIdForFile(file.path);
      const content = await this.app.vault.readBinary(file);
      const fileName = file.name;
      const query = `name='${fileName}' and '${parentFolderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
      const searchData = await this.apiGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
        token
      );
      const existingId = (_b = (_a = searchData.files) == null ? void 0 : _a[0]) == null ? void 0 : _b.id;
      const metadata = { name: fileName, ...existingId ? {} : { parents: [parentFolderId] } };
      const uploadUrl = existingId ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart` : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
      await this.apiUpload(uploadUrl, existingId ? "PATCH" : "POST", token, metadata, content);
      this.lastSynced[file.path] = file.stat.mtime;
      return true;
    } catch (e) {
      console.error("GDrive upload error:", file.path, this.errMsg(e));
      return false;
    }
  }
  // ── Delete from Drive ─────────────────────────────────────────────────
  async deleteFromDrive(filePath) {
    var _a, _b;
    if (!this.isConfigured())
      return;
    try {
      const token = await this.getAccessToken();
      const parentFolderId = await this.getFolderIdForFile(filePath);
      const fileName = filePath.includes("/") ? filePath.substring(filePath.lastIndexOf("/") + 1) : filePath;
      const query = `name='${fileName}' and '${parentFolderId}' in parents and trashed=false`;
      const searchData = await this.apiGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
        token
      );
      if ((_b = (_a = searchData.files) == null ? void 0 : _a[0]) == null ? void 0 : _b.id) {
        await this.apiDelete(`https://www.googleapis.com/drive/v3/files/${searchData.files[0].id}`, token);
        delete this.lastSynced[filePath];
        await this.saveLastSynced();
      }
    } catch (e) {
      console.error("GDrive delete error:", this.errMsg(e));
    }
  }
  // ── Download All (force full re-download) ─────────────────────────────
  async downloadAll() {
    if (!this.isConfigured()) {
      new import_obsidian.Notice("\u26A0\uFE0F Please enter credentials first.");
      return;
    }
    if (this.isSyncing) {
      new import_obsidian.Notice("\u26A0\uFE0F Sync already in progress, please wait.");
      return;
    }
    this.isSyncing = true;
    this.setStatus("\u2B07\uFE0F Downloading from Drive...");
    try {
      const token = await this.getAccessToken();
      const rootId = await this.ensureDriveFolder();
      const driveFiles = await this.listDriveFilesRecursive(rootId);
      let count = 0;
      for (let i = 0; i < driveFiles.length; i += BATCH_SIZE) {
        const batch = driveFiles.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (df) => {
          try {
            const buffer = await this.apiDownload(
              `https://www.googleapis.com/drive/v3/files/${df.id}?alt=media`,
              token
            );
            await this.writeFileConflictSafe(df.path, buffer, new Date(df.modifiedTime).getTime());
            count++;
          } catch (e) {
            console.error("Download error:", df.path, this.errMsg(e));
          }
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
    } finally {
      this.isSyncing = false;
    }
  }
  startAutoSync() {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    this.fullTwoWaySync();
    const ms = Math.max(1, this.settings.syncIntervalSeconds) * 1e3;
    this.syncIntervalId = window.setInterval(() => {
      if (!this.isSyncing)
        this.fullTwoWaySync();
      else
        console.log("GDrive Sync: sync in progress, skipping tick");
    }, ms);
    this.setStatus("\u{1F504} Auto-sync active");
    new import_obsidian.Notice(`\u2705 GDrive Auto-Sync started! (every ${secondsToLabel(this.settings.syncIntervalSeconds)})`);
  }
  stopAutoSync() {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
      this.setStatus("\u23F8 GDrive Sync paused");
      new import_obsidian.Notice("GDrive Auto-Sync stopped.");
    }
  }
  async loadSettings() {
    var _a, _b, _c;
    const saved = (_a = await this.loadData()) != null ? _a : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.lastSynced = (_b = saved.lastSynced) != null ? _b : {};
    this.driveChangesPageToken = (_c = saved.driveChangesPageToken) != null ? _c : "";
  }
};
var GDriveSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Google Drive Vault Sync" });
    containerEl.createEl("p", { text: "Enter your Google OAuth credentials. See README for setup instructions.", cls: "setting-item-description" });
    new import_obsidian.Setting(containerEl).setName("Client ID").setDesc("Google Cloud Console \u2192 Credentials \u2192 OAuth 2.0 Client ID").addText((t) => t.setPlaceholder("xxxx.apps.googleusercontent.com").setValue(this.plugin.settings.clientId).onChange(async (v) => {
      this.plugin.settings.clientId = v.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Client Secret").setDesc("Google Cloud Console \u2192 Credentials").addText((t) => t.setPlaceholder("GOCSPX-...").setValue(this.plugin.settings.clientSecret).onChange(async (v) => {
      this.plugin.settings.clientSecret = v.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Refresh Token").setDesc("From OAuth Playground.").addText((t) => t.setPlaceholder("1//0g...").setValue(this.plugin.settings.refreshToken).onChange(async (v) => {
      this.plugin.settings.refreshToken = v.trim();
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Drive Folder Name").addText((t) => t.setValue(this.plugin.settings.driveFolderName).onChange(async (v) => {
      this.plugin.settings.driveFolderName = v.trim() || "ObsidianVaultSync";
      this.plugin.driveFolderId = "";
      await this.plugin.saveSettings();
    }));
    const intervalSetting = new import_obsidian.Setting(containerEl).setName("Auto-sync interval").setDesc(`Every ${secondsToLabel(this.plugin.settings.syncIntervalSeconds)}`);
    intervalSetting.addSlider((slider) => {
      const currentIndex = secondsToPresetIndex(this.plugin.settings.syncIntervalSeconds);
      slider.setLimits(0, SYNC_INTERVAL_PRESETS.length - 1, 1).setValue(currentIndex).onChange(async (idx) => {
        const seconds = SYNC_INTERVAL_PRESETS[idx];
        this.plugin.settings.syncIntervalSeconds = seconds;
        intervalSetting.setDesc(`Every ${secondsToLabel(seconds)}`);
        await this.plugin.saveSettings();
      });
      const tickContainer = containerEl.createEl("div", { cls: "gdrive-slider-ticks" });
      tickContainer.style.cssText = "display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:-10px;margin-bottom:8px;padding:0 2px;";
      SYNC_INTERVAL_PRESETS.forEach((s) => {
        tickContainer.createEl("span", { text: secondsToLabel(s) });
      });
    });
    new import_obsidian.Setting(containerEl).setName("Auto-sync on Obsidian open").addToggle((t) => t.setValue(this.plugin.settings.autoSyncOnStart).onChange(async (v) => {
      this.plugin.settings.autoSyncOnStart = v;
      await this.plugin.saveSettings();
    }));
    containerEl.createEl("h3", { text: "Actions" });
    new import_obsidian.Setting(containerEl).setName("Start auto-sync").addButton((b) => b.setButtonText("\u25B6 Start").setCta().onClick(() => this.plugin.startAutoSync()));
    new import_obsidian.Setting(containerEl).setName("Stop auto-sync").addButton((b) => b.setButtonText("\u23F8 Stop").onClick(() => this.plugin.stopAutoSync()));
    new import_obsidian.Setting(containerEl).setName("Sync now").setDesc("Upload local changes and download Drive changes.").addButton((b) => b.setButtonText("\u{1F504} Two-Way Sync").onClick(() => this.plugin.fullTwoWaySync()));
    new import_obsidian.Setting(containerEl).setName("Download from Drive").setDesc("Force re-download all files from Drive.").addButton((b) => b.setButtonText("\u2B07 Download All").onClick(() => this.plugin.downloadAll()));
    new import_obsidian.Setting(containerEl).setName("Check for update").setDesc("Manually check GitHub for a newer version.").addButton((b) => b.setButtonText("\u{1F504} Check Update").onClick(() => this.plugin.checkForUpdate()));
  }
};
