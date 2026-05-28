import {
  App, Plugin, PluginSettingTab, Setting,
  Notice, TFile, requestUrl
} from "obsidian";

const GITHUB_VERSION_URL = "https://raw.githubusercontent.com/JanakaProjects/obsidian-gdrive-sync/main/manifest.json";
const GITHUB_MAIN_JS_URL = "https://raw.githubusercontent.com/JanakaProjects/obsidian-gdrive-sync/main/main.js";
const BATCH_SIZE = 5;

// Snap-point presets for the sync interval slider.
// The slider position (0–9) maps to these second values.
const SYNC_INTERVAL_PRESETS: number[] = [1, 5, 10, 30, 60, 120, 300, 600, 900, 1800];

function secondsToLabel(s: number): string {
  if (s < 60) return `${s}s`;
  const m = s / 60;
  return m === 1 ? "1 min" : `${m} min`;
}

// Find the nearest preset index for a stored seconds value
function secondsToPresetIndex(s: number): number {
  let best = 0;
  let bestDiff = Math.abs(SYNC_INTERVAL_PRESETS[0] - s);
  for (let i = 1; i < SYNC_INTERVAL_PRESETS.length; i++) {
    const diff = Math.abs(SYNC_INTERVAL_PRESETS[i] - s);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

// Encode/decode vault paths to flat Drive filenames
function encodePath(vaultPath: string): string {
  return vaultPath.replace(/___/g, "__TRIPLEUNDERSCORE__").replace(/\//g, "___");
}
function decodePath(driveName: string): string {
  return driveName.replace(/___/g, "/").replace(/__TRIPLEUNDERSCORE__/g, "___");
}

// Conflict copy filename: "Notes/Todo.md" -> "Notes/Todo (Conflict 2026-05-28 21-30).md"
function conflictName(filePath: string): string {
  const now = new Date();
  const stamp = now.getFullYear() + "-"
    + String(now.getMonth() + 1).padStart(2, "0") + "-"
    + String(now.getDate()).padStart(2, "0") + " "
    + String(now.getHours()).padStart(2, "0") + "-"
    + String(now.getMinutes()).padStart(2, "0");
  const dot = filePath.lastIndexOf(".");
  const slash = filePath.lastIndexOf("/");
  if (dot > slash) {
    return filePath.slice(0, dot) + ` (Conflict ${stamp})` + filePath.slice(dot);
  }
  return filePath + ` (Conflict ${stamp})`;
}

interface GDriveSyncSettings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  driveFolderName: string;
  syncIntervalSeconds: number;
  autoSyncOnStart: boolean;
}

const DEFAULT_SETTINGS: GDriveSyncSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  driveFolderName: "ObsidianVaultSync",
  syncIntervalSeconds: 30,
  autoSyncOnStart: true,
};

export default class GDriveSyncPlugin extends Plugin {
  settings: GDriveSyncSettings;
  accessToken: string = "";
  accessTokenExpiry: number = 0;
  accessTokenRefreshPromise: Promise<string> | null = null;
  driveFolderId: string = "";
  syncIntervalId: number | null = null;
  statusBarItem: HTMLElement;
  isSyncing: boolean = false;
  lastSynced: Record<string, number> = {};
  driveChangesPageToken: string = "";
  private downloading: Set<string> = new Set();

  async onload() {
    const saved = await this.loadData() ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.lastSynced = saved.lastSynced ?? {};
    this.driveChangesPageToken = saved.driveChangesPageToken ?? "";

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("⏸ GDrive Sync idle");

    this.addCommand({ id: "sync-now", name: "Sync vault now", callback: () => this.fullTwoWaySync() });
    this.addCommand({ id: "stop-sync", name: "Stop auto-sync", callback: () => this.stopAutoSync() });
    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && !this.downloading.has(file.path)) this.uploadFile(file);
    }));
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file instanceof TFile && !this.downloading.has(file.path)) this.uploadFile(file);
    }));
    this.registerEvent(this.app.vault.on("delete", (file) => {
      if (file instanceof TFile) this.deleteFromDrive(file.path);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) { this.deleteFromDrive(oldPath); this.uploadFile(file as TFile); }
    }));

    await this.checkForUpdate();

    if (this.settings.autoSyncOnStart && this.isConfigured()) {
      setTimeout(() => this.startAutoSync(), 3000);
    }
  }

  onunload() {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────
  async apiGet(url: string, token: string): Promise<any> {
    const resp = await requestUrl({ url, headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400) throw new Error(`GET failed ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }

  async apiPost(url: string, token: string, body: any): Promise<any> {
    const resp = await requestUrl({
      url, method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status >= 400) throw new Error(`POST failed ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }

  async apiDelete(url: string, token: string): Promise<void> {
    const resp = await requestUrl({ url, method: "DELETE", headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400 && resp.status !== 404) throw new Error(`DELETE failed ${resp.status}: ${resp.text}`);
  }

  async apiDownload(url: string, token: string): Promise<ArrayBuffer> {
    const resp = await requestUrl({ url, headers: { Authorization: "Bearer " + token } });
    if (resp.status >= 400) throw new Error(`Download failed ${resp.status}: ${resp.text}`);
    return resp.arrayBuffer;
  }

  async apiUpload(url: string, method: string, token: string, metadata: any, content: ArrayBuffer): Promise<any> {
    const boundary = "gdrivesync_" + Date.now();
    const enc = new TextEncoder();
    const metaPart = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`);
    const filePart = enc.encode(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const closing = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(metaPart.byteLength + filePart.byteLength + content.byteLength + closing.byteLength);
    body.set(metaPart, 0);
    body.set(filePart, metaPart.byteLength);
    body.set(new Uint8Array(content), metaPart.byteLength + filePart.byteLength);
    body.set(closing, metaPart.byteLength + filePart.byteLength + content.byteLength);
    const resp = await requestUrl({
      url, method,
      headers: { Authorization: "Bearer " + token, "Content-Type": `multipart/related; boundary=${boundary}` },
      body: body.buffer,
    });
    if (resp.status >= 400) throw new Error(`Upload failed ${resp.status}: ${resp.text}`);
    return JSON.parse(resp.text);
  }

  // ── Auto-Updater ──────────────────────────────────────────────────────
  async checkForUpdate() {
    try {
      const resp = await requestUrl({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
      const remote = JSON.parse(resp.text);
      if (remote.version !== this.manifest.version) {
        new Notice(`🔄 GDrive Sync: Update found (${this.manifest.version} → ${remote.version}). Installing...`);
        await this.selfUpdate(remote.version);
      }
    } catch (e) { console.log("GDrive Sync: update check failed", e); }
  }

  async selfUpdate(newVersion: string) {
    try {
      let written = false;
      try {
        const fs = require("fs");
        const nodePath = require("path");
        const basePath = (this.app.vault.adapter as any).basePath;
        const pluginDir = nodePath.join(basePath, ".obsidian", "plugins", this.manifest.id);
        const jsResp = await requestUrl({ url: GITHUB_MAIN_JS_URL + "?t=" + Date.now() });
        fs.writeFileSync(nodePath.join(pluginDir, "main.js"), jsResp.text, "utf8");
        const mResp = await requestUrl({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
        fs.writeFileSync(nodePath.join(pluginDir, "manifest.json"), mResp.text, "utf8");
        written = true;
      } catch {}
      if (!written) {
        const pluginPath = `.obsidian/plugins/${this.manifest.id}`;
        const jsResp = await requestUrl({ url: GITHUB_MAIN_JS_URL + "?t=" + Date.now() });
        await this.app.vault.adapter.write(`${pluginPath}/main.js`, jsResp.text);
        const mResp = await requestUrl({ url: GITHUB_VERSION_URL + "?t=" + Date.now() });
        await this.app.vault.adapter.write(`${pluginPath}/manifest.json`, mResp.text);
      }
      new Notice(`✅ GDrive Sync updated to v${newVersion}! Reloading...`);
      const id = this.manifest.id;
      // @ts-ignore
      await this.app.plugins.disablePlugin(id);
      // @ts-ignore
      await this.app.plugins.enablePlugin(id);
    } catch (e) {
      console.error("GDrive Sync: self-update failed", e);
      new Notice("❌ GDrive Sync: Auto-update failed. Please update manually.");
    }
  }

  isConfigured(): boolean {
    return !!(this.settings.clientId && this.settings.clientSecret && this.settings.refreshToken);
  }

  setStatus(msg: string) { this.statusBarItem.setText(msg); }

  errMsg(e: any): string {
    return (e instanceof Error ? e.message : String(e)) || "Unknown error";
  }

  async saveSettings() {
    const current = await this.loadData() ?? {};
    await this.saveData({ ...current, ...this.settings, lastSynced: this.lastSynced, driveChangesPageToken: this.driveChangesPageToken });
  }

  async saveLastSynced() {
    const current = await this.loadData() ?? {};
    await this.saveData({ ...current, lastSynced: this.lastSynced, driveChangesPageToken: this.driveChangesPageToken });
  }

  // ── OAuth ─────────────────────────────────────────────────────────────
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiry - 60000) return this.accessToken;
    if (this.accessTokenRefreshPromise) return this.accessTokenRefreshPromise;
    this.accessTokenRefreshPromise = (async () => {
      const resp = await requestUrl({
        url: "https://oauth2.googleapis.com/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          refresh_token: this.settings.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      });
      if (resp.status >= 400) throw new Error("Token refresh failed: " + resp.text);
      const data = JSON.parse(resp.text);
      if (!data.access_token) throw new Error("No access_token in response: " + resp.text);
      this.accessToken = data.access_token;
      this.accessTokenExpiry = Date.now() + data.expires_in * 1000;
      return this.accessToken;
    })();
    try {
      return await this.accessTokenRefreshPromise;
    } finally {
      this.accessTokenRefreshPromise = null;
    }
  }

  // ── Drive Folder ──────────────────────────────────────────────────────
  async ensureDriveFolder(): Promise<string> {
    if (this.driveFolderId) return this.driveFolderId;
    const token = await this.getAccessToken();
    const name = this.settings.driveFolderName;
    const query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchData = await this.apiGet(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`, token
    );
    if (searchData.files?.length > 0) { this.driveFolderId = searchData.files[0].id; return this.driveFolderId; }
    const folder = await this.apiPost("https://www.googleapis.com/drive/v3/files", token, {
      name, mimeType: "application/vnd.google-apps.folder"
    });
    this.driveFolderId = folder.id;
    return this.driveFolderId;
  }

  // ── Delta Sync: Drive Changes API ─────────────────────────────────────
  async fetchStartPageToken(): Promise<string> {
    const token = await this.getAccessToken();
    const data = await this.apiGet("https://www.googleapis.com/drive/v3/changes/startPageToken", token);
    return data.startPageToken;
  }

  async fetchDeltaChanges(): Promise<{ filePath: string; fileId: string; removed: boolean; modifiedTime: number }[]> {
    const token = await this.getAccessToken();
    const folderId = await this.ensureDriveFolder();
    const changes: { filePath: string; fileId: string; removed: boolean; modifiedTime: number }[] = [];
    let pageToken = this.driveChangesPageToken;
    let newPageToken = pageToken;

    do {
      const url = `https://www.googleapis.com/drive/v3/changes`
        + `?pageToken=${encodeURIComponent(pageToken)}`
        + `&fields=nextPageToken,newStartPageToken,changes(removed,fileId,file(id,name,parents,trashed,modifiedTime))`
        + `&includeRemoved=true`;
      const data = await this.apiGet(url, token);

      for (const change of (data.changes || [])) {
        const f = change.file;
        if (!f) continue;
        const inFolder = f.parents && f.parents.includes(folderId);
        if (!inFolder && !change.removed) continue;
        const filePath = decodePath(f.name || "");
        changes.push({
          filePath,
          fileId: change.fileId,
          removed: !!(change.removed || f.trashed),
          modifiedTime: f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0,
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

  // ── Full file listing (first sync / no token) ───────────────────────────
  async listDriveFiles(): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    const token = await this.getAccessToken();
    const folderId = await this.ensureDriveFolder();
    let allFiles: any[] = [];
    let pageToken: string | null = null;
    do {
      let url = `https://www.googleapis.com/drive/v3/files`
        + `?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}`
        + `&fields=nextPageToken,files(id,name,modifiedTime)`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
      const data = await this.apiGet(url, token);
      allFiles = allFiles.concat(data.files || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return allFiles;
  }

  // ── Conflict-safe file write ──────────────────────────────────────────
  async writeFileConflictSafe(filePath: string, buffer: ArrayBuffer, driveModifiedTime: number): Promise<void> {
    const localFile = this.app.vault.getAbstractFileByPath(filePath);
    const lastSync = this.lastSynced[filePath] ?? 0;

    const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : null;
    if (dir) { try { await this.app.vault.createFolder(dir); } catch {} }

    if (localFile instanceof TFile) {
      const localMtime = localFile.stat.mtime;
      if (lastSync > 0 && localMtime > lastSync && driveModifiedTime > lastSync) {
        const conflictPath = conflictName(filePath);
        const conflictDir = conflictPath.includes("/") ? conflictPath.substring(0, conflictPath.lastIndexOf("/")) : null;
        if (conflictDir) { try { await this.app.vault.createFolder(conflictDir); } catch {} }
        this.downloading.add(conflictPath);
        try {
          await this.app.vault.createBinary(conflictPath, buffer);
        } catch {
          const existing = this.app.vault.getAbstractFileByPath(conflictPath);
          if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buffer);
        } finally {
          this.downloading.delete(conflictPath);
        }
        new Notice(`⚠️ Conflict detected: "${filePath}"\nDrive version saved as "${conflictPath}"`);
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

  // ── Two-way sync (delta-aware) ────────────────────────────────────────
  async fullTwoWaySync() {
    if (!this.isConfigured()) { new Notice("⚠️ GDrive Sync: Please enter credentials first."); return; }
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.setStatus("🔄 Syncing...");
    try {
      await this.ensureDriveFolder();
      const token = await this.getAccessToken();
      let downloaded = 0;

      if (!this.driveChangesPageToken) {
        const driveFiles = await this.listDriveFiles();
        const driveMap: Record<string, { id: string; modifiedTime: number }> = {};
        for (const df of driveFiles) {
          driveMap[decodePath(df.name)] = { id: df.id, modifiedTime: new Date(df.modifiedTime).getTime() };
        }
        const driveEntries = Object.entries(driveMap);
        for (let i = 0; i < driveEntries.length; i += BATCH_SIZE) {
          const batch = driveEntries.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async ([filePath, driveInfo]) => {
            const localFile = this.app.vault.getAbstractFileByPath(filePath);
            const localMtime = localFile instanceof TFile ? localFile.stat.mtime : 0;
            if (driveInfo.modifiedTime > localMtime) {
              try {
                const buffer = await this.apiDownload(
                  `https://www.googleapis.com/drive/v3/files/${driveInfo.id}?alt=media`, token
                );
                await this.writeFileConflictSafe(filePath, buffer, driveInfo.modifiedTime);
                this.lastSynced[filePath] = driveInfo.modifiedTime;
                downloaded++;
              } catch (e) { console.error("Download error:", filePath, this.errMsg(e)); }
            }
          }));
          this.setStatus(`⬇️ ${downloaded}/${driveEntries.length}...`);
        }
        this.driveChangesPageToken = await this.fetchStartPageToken();
      } else {
        const changes = await this.fetchDeltaChanges();
        const relevant = changes.filter(c => !c.removed);
        const removed = changes.filter(c => c.removed);
        for (const c of removed) {
          const localFile = this.app.vault.getAbstractFileByPath(c.filePath);
          if (localFile instanceof TFile) {
            try { await this.app.vault.delete(localFile); delete this.lastSynced[c.filePath]; }
            catch (e) { console.error("Local delete error:", c.filePath, this.errMsg(e)); }
          }
        }
        for (let i = 0; i < relevant.length; i += BATCH_SIZE) {
          const batch = relevant.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (c) => {
            try {
              const buffer = await this.apiDownload(
                `https://www.googleapis.com/drive/v3/files/${c.fileId}?alt=media`, token
              );
              await this.writeFileConflictSafe(c.filePath, buffer, c.modifiedTime);
              this.lastSynced[c.filePath] = c.modifiedTime;
              downloaded++;
            } catch (e) { console.error("Delta download error:", c.filePath, this.errMsg(e)); }
          }));
          this.setStatus(`⬇️ ${downloaded}/${relevant.length}...`);
        }
      }

      const localFiles = this.app.vault.getFiles();
      const toUpload = localFiles.filter(f => {
        const lastSync = this.lastSynced[f.path] ?? 0;
        return f.stat.mtime > lastSync;
      });
      let uploaded = 0;
      for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
        const batch = toUpload.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(f => this.uploadFile(f, true)));
        uploaded += results.filter(Boolean).length;
        this.setStatus(`⬆️ ${uploaded}/${toUpload.length}...`);
      }

      await this.saveLastSynced();
      this.setStatus(`✅ ⬇${downloaded} ⬆${uploaded} — ${new Date().toLocaleTimeString()}`);
      if (downloaded > 0 || uploaded > 0) {
        new Notice(`✅ GDrive Sync: ⬇ ${downloaded} downloaded, ⬆ ${uploaded} uploaded`);
      }
    } catch (e) {
      this.setStatus("❌ Sync failed");
      new Notice("❌ GDrive Sync failed: " + this.errMsg(e));
    } finally {
      this.isSyncing = false;
    }
  }

  // ── Upload single file ────────────────────────────────────────────────
  async uploadFile(file: TFile, force = false): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (!force && this.lastSynced[file.path] && this.lastSynced[file.path] >= file.stat.mtime) return false;
    try {
      const token = await this.getAccessToken();
      const folderId = await this.ensureDriveFolder();
      const content = await this.app.vault.readBinary(file);
      const safeName = encodePath(file.path);
      const query = `name='${safeName}' and '${folderId}' in parents and trashed=false`;
      const searchData = await this.apiGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`, token
      );
      const existingId = searchData.files?.[0]?.id;
      const metadata = { name: safeName, ...(existingId ? {} : { parents: [folderId] }) };
      const uploadUrl = existingId
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
        : `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`;
      await this.apiUpload(uploadUrl, existingId ? "PATCH" : "POST", token, metadata, content);
      this.lastSynced[file.path] = file.stat.mtime;
      return true;
    } catch (e) {
      console.error("GDrive upload error:", file.path, this.errMsg(e));
      return false;
    }
  }

  // ── Delete from Drive ─────────────────────────────────────────────────
  async deleteFromDrive(filePath: string) {
    if (!this.isConfigured()) return;
    try {
      const token = await this.getAccessToken();
      const folderId = await this.ensureDriveFolder();
      const safeName = encodePath(filePath);
      const query = `name='${safeName}' and '${folderId}' in parents and trashed=false`;
      const searchData = await this.apiGet(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`, token
      );
      if (searchData.files?.[0]?.id) {
        await this.apiDelete(`https://www.googleapis.com/drive/v3/files/${searchData.files[0].id}`, token);
        delete this.lastSynced[filePath];
        await this.saveLastSynced();
      }
    } catch (e) { console.error("GDrive delete error:", this.errMsg(e)); }
  }

  // ── Download All (force full re-download) ─────────────────────────────
  async downloadAll() {
    if (!this.isConfigured()) { new Notice("⚠️ Please enter credentials first."); return; }
    if (this.isSyncing) { new Notice("⚠️ Sync already in progress, please wait."); return; }
    this.isSyncing = true;
    this.setStatus("⬇️ Downloading from Drive...");
    try {
      const token = await this.getAccessToken();
      const driveFiles = await this.listDriveFiles();
      let count = 0;
      for (let i = 0; i < driveFiles.length; i += BATCH_SIZE) {
        const batch = driveFiles.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (df) => {
          const realPath = decodePath(df.name);
          try {
            const buffer = await this.apiDownload(
              `https://www.googleapis.com/drive/v3/files/${df.id}?alt=media`, token
            );
            await this.writeFileConflictSafe(realPath, buffer, new Date(df.modifiedTime).getTime());
            count++;
          } catch (e) { console.error("Download error:", realPath, this.errMsg(e)); }
        }));
        this.setStatus(`⬇️ ${count}/${driveFiles.length}...`);
      }
      this.driveChangesPageToken = await this.fetchStartPageToken();
      await this.saveLastSynced();
      this.setStatus(`✅ Downloaded ${count} files`);
      new Notice(`✅ Downloaded ${count} files from Google Drive!`);
    } catch (e) {
      this.setStatus("❌ Download failed");
      new Notice("❌ Download failed: " + this.errMsg(e));
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
    const ms = Math.max(1, this.settings.syncIntervalSeconds) * 1000;
    this.syncIntervalId = window.setInterval(() => {
      if (!this.isSyncing) this.fullTwoWaySync();
      else console.log("GDrive Sync: sync in progress, skipping tick");
    }, ms);
    this.setStatus("🔄 Auto-sync active");
    new Notice(`✅ GDrive Auto-Sync started! (every ${secondsToLabel(this.settings.syncIntervalSeconds)})`);
  }

  stopAutoSync() {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
      this.setStatus("⏸ GDrive Sync paused");
      new Notice("GDrive Auto-Sync stopped.");
    }
  }

  async loadSettings() {
    const saved = await this.loadData() ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.lastSynced = saved.lastSynced ?? {};
    this.driveChangesPageToken = saved.driveChangesPageToken ?? "";
  }
}

// ── Settings UI ───────────────────────────────────────────────────────────
class GDriveSyncSettingTab extends PluginSettingTab {
  plugin: GDriveSyncPlugin;
  constructor(app: App, plugin: GDriveSyncPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Google Drive Vault Sync" });
    containerEl.createEl("p", { text: "Enter your Google OAuth credentials. See README for setup instructions.", cls: "setting-item-description" });

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("Google Cloud Console → Credentials → OAuth 2.0 Client ID")
      .addText(t => t.setPlaceholder("xxxx.apps.googleusercontent.com").setValue(this.plugin.settings.clientId)
        .onChange(async v => { this.plugin.settings.clientId = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("Google Cloud Console → Credentials")
      .addText(t => t.setPlaceholder("GOCSPX-...").setValue(this.plugin.settings.clientSecret)
        .onChange(async v => { this.plugin.settings.clientSecret = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Refresh Token")
      .setDesc("From OAuth Playground.")
      .addText(t => t.setPlaceholder("1//0g...").setValue(this.plugin.settings.refreshToken)
        .onChange(async v => { this.plugin.settings.refreshToken = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Drive Folder Name")
      .addText(t => t.setValue(this.plugin.settings.driveFolderName)
        .onChange(async v => { this.plugin.settings.driveFolderName = v.trim() || "ObsidianVaultSync"; this.plugin.driveFolderId = ""; await this.plugin.saveSettings(); }));

    // ── Snap-point interval slider ──
    // Slider position 0–9 maps to SYNC_INTERVAL_PRESETS.
    // The setting desc shows the human-readable label and updates live as you drag.
    const intervalSetting = new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc(`Every ${secondsToLabel(this.plugin.settings.syncIntervalSeconds)}`);

    intervalSetting.addSlider(slider => {
      const currentIndex = secondsToPresetIndex(this.plugin.settings.syncIntervalSeconds);
      slider
        .setLimits(0, SYNC_INTERVAL_PRESETS.length - 1, 1)
        .setValue(currentIndex)
        .onChange(async (idx: number) => {
          const seconds = SYNC_INTERVAL_PRESETS[idx];
          this.plugin.settings.syncIntervalSeconds = seconds;
          // Update the description label live
          intervalSetting.setDesc(`Every ${secondsToLabel(seconds)}`);
          await this.plugin.saveSettings();
        });
      // Show tick marks by listing all labels beneath the slider
      const tickContainer = containerEl.createEl("div", { cls: "gdrive-slider-ticks" });
      tickContainer.style.cssText = "display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:-10px;margin-bottom:8px;padding:0 2px;";
      SYNC_INTERVAL_PRESETS.forEach(s => {
        tickContainer.createEl("span", { text: secondsToLabel(s) });
      });
    });

    new Setting(containerEl)
      .setName("Auto-sync on Obsidian open")
      .addToggle(t => t.setValue(this.plugin.settings.autoSyncOnStart)
        .onChange(async v => { this.plugin.settings.autoSyncOnStart = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl).setName("Start auto-sync")
      .addButton(b => b.setButtonText("▶ Start").setCta().onClick(() => this.plugin.startAutoSync()));
    new Setting(containerEl).setName("Stop auto-sync")
      .addButton(b => b.setButtonText("⏸ Stop").onClick(() => this.plugin.stopAutoSync()));
    new Setting(containerEl).setName("Sync now").setDesc("Upload local changes and download Drive changes.")
      .addButton(b => b.setButtonText("🔄 Two-Way Sync").onClick(() => this.plugin.fullTwoWaySync()));
    new Setting(containerEl).setName("Download from Drive").setDesc("Force re-download all files from Drive.")
      .addButton(b => b.setButtonText("⬇ Download All").onClick(() => this.plugin.downloadAll()));
    new Setting(containerEl).setName("Check for update").setDesc("Manually check GitHub for a newer version.")
      .addButton(b => b.setButtonText("🔄 Check Update").onClick(() => this.plugin.checkForUpdate()));
  }
}
