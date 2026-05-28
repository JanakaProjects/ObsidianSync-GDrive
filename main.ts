import {
  App, Plugin, PluginSettingTab, Setting,
  Notice, TFile, requestUrl
} from "obsidian";

const GITHUB_VERSION_URL = "https://raw.githubusercontent.com/JanakaProjects/obsidian-gdrive-sync/main/manifest.json";
const GITHUB_MAIN_JS_URL = "https://raw.githubusercontent.com/JanakaProjects/obsidian-gdrive-sync/main/main.js";
const BATCH_SIZE = 5;

// fix #7: proper encode/decode that handles literal ___ in filenames
function encodePath(vaultPath: string): string {
  return vaultPath.replace(/___/g, "__TRIPLEUNDERSCORE__").replace(/\//g, "___");
}
function decodePath(driveName: string): string {
  return driveName.replace(/___/g, "/").replace(/__TRIPLEUNDERSCORE__/g, "___");
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
  // fix #12: serialise concurrent token refreshes
  accessTokenRefreshPromise: Promise<string> | null = null;
  driveFolderId: string = "";
  syncIntervalId: number | null = null;
  statusBarItem: HTMLElement;
  isSyncing: boolean = false;
  lastSynced: Record<string, number> = {};
  // fix #6: paths currently being written from Drive so watcher ignores them
  private downloading: Set<string> = new Set();

  async onload() {
    // fix #2: single loadData call, cleanly split settings and lastSynced
    const saved = await this.loadData() ?? {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    this.lastSynced = saved.lastSynced ?? {};

    this.statusBarItem = this.addStatusBarItem();
    this.setStatus("⏸ GDrive Sync idle");

    this.addCommand({ id: "sync-now", name: "Sync vault now", callback: () => this.fullTwoWaySync() });
    this.addCommand({ id: "stop-sync", name: "Stop auto-sync", callback: () => this.stopAutoSync() });
    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));

    // fix #6: skip upload for files currently being written from Drive
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

  // fix #8: onunload silently clears interval, no Notice spam on Obsidian close
  onunload() {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  // ── HTTP helpers (requestUrl only — works on all platforms) ───────────
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

  // fix #11: apiDelete now checks response status
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

  // ── Auto-Updater ──────────────────────────────────────────────
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
      // fix #10: no top-level fs/path imports — dynamic require inside try (desktop only)
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

  // fix #3: saveSettings always merges with existing data — never wipes lastSynced
  async saveSettings() {
    const current = await this.loadData() ?? {};
    await this.saveData({ ...current, ...this.settings, lastSynced: this.lastSynced });
  }

  async saveLastSynced() {
    const current = await this.loadData() ?? {};
    await this.saveData({ ...current, lastSynced: this.lastSynced });
  }

  // ── OAuth ─────────────────────────────────────────────────────────
  // fix #12: all concurrent callers await same single refresh promise
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

  // ── Drive Folder ─────────────────────────────────────────────────────
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

  // ── List all Drive files (paginated) ─────────────────────────────────
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

  // ── Two-way sync ─────────────────────────────────────────────────────
  async fullTwoWaySync() {
    if (!this.isConfigured()) { new Notice("⚠️ GDrive Sync: Please enter credentials first."); return; }
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.setStatus("🔄 Syncing...");
    try {
      await this.ensureDriveFolder();
      const driveFiles = await this.listDriveFiles();
      const driveMap: Record<string, { id: string; modifiedTime: number }> = {};
      for (const df of driveFiles) {
        // fix #7: use decodePath
        const realPath = decodePath(df.name);
        driveMap[realPath] = { id: df.id, modifiedTime: new Date(df.modifiedTime).getTime() };
      }

      const token = await this.getAccessToken();
      let downloaded = 0;
      const driveEntries = Object.entries(driveMap);

      for (let i = 0; i < driveEntries.length; i += BATCH_SIZE) {
        const batch = driveEntries.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async ([filePath, driveInfo]) => {
          const localFile = this.app.vault.getAbstractFileByPath(filePath);
          const localMtime = localFile instanceof TFile ? localFile.stat.mtime : 0;
          if (driveInfo.modifiedTime > localMtime) {
            // fix #6: mark downloading before write
            this.downloading.add(filePath);
            try {
              const buffer = await this.apiDownload(
                `https://www.googleapis.com/drive/v3/files/${driveInfo.id}?alt=media`, token
              );
              const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : null;
              if (dir) { try { await this.app.vault.createFolder(dir); } catch {} }
              if (localFile instanceof TFile) await this.app.vault.modifyBinary(localFile, buffer);
              else await this.app.vault.createBinary(filePath, buffer);
              this.lastSynced[filePath] = driveInfo.modifiedTime;
              downloaded++;
            } catch (e) { console.error("Download error:", filePath, this.errMsg(e)); }
            finally { this.downloading.delete(filePath); }
          }
        }));
        this.setStatus(`⬇️ ${downloaded}/${driveEntries.length}...`);
      }

      const localFiles = this.app.vault.getFiles();
      const toUpload = localFiles.filter(f => {
        const driveInfo = driveMap[f.path];
        return !driveInfo || f.stat.mtime > driveInfo.modifiedTime;
      });

      // fix #5: count only successful uploads
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
      // fix #1: ALWAYS reset isSyncing even if exception escapes
      this.isSyncing = false;
    }
  }

  // ── Upload single file — returns true on success ───────────────────────
  async uploadFile(file: TFile, force = false): Promise<boolean> {
    if (!this.isConfigured()) return false;
    if (!force && this.lastSynced[file.path] && this.lastSynced[file.path] >= file.stat.mtime) return false;
    try {
      const token = await this.getAccessToken();
      const folderId = await this.ensureDriveFolder();
      const content = await this.app.vault.readBinary(file);
      // fix #7: use encodePath
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

  // ── Delete from Drive ────────────────────────────────────────────────
  async deleteFromDrive(filePath: string) {
    if (!this.isConfigured()) return;
    try {
      const token = await this.getAccessToken();
      const folderId = await this.ensureDriveFolder();
      // fix #7: use encodePath
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

  // ── Download All ─────────────────────────────────────────────────────
  async downloadAll() {
    if (!this.isConfigured()) { new Notice("⚠️ Please enter credentials first."); return; }
    // fix #4: respect isSyncing lock
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
          // fix #7: use decodePath
          const realPath = decodePath(df.name);
          this.downloading.add(realPath);
          try {
            const buffer = await this.apiDownload(
              `https://www.googleapis.com/drive/v3/files/${df.id}?alt=media`, token
            );
            const dir = realPath.includes("/") ? realPath.substring(0, realPath.lastIndexOf("/")) : null;
            if (dir) { try { await this.app.vault.createFolder(dir); } catch {} }
            const existing = this.app.vault.getAbstractFileByPath(realPath);
            if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, buffer);
            else await this.app.vault.createBinary(realPath, buffer);
            count++;
          } catch (e) { console.error("Download error:", realPath, this.errMsg(e)); }
          finally { this.downloading.delete(realPath); }
        }));
        this.setStatus(`⬇️ ${count}/${driveFiles.length}...`);
      }
      this.setStatus(`✅ Downloaded ${count} files`);
      new Notice(`✅ Downloaded ${count} files from Google Drive!`);
    } catch (e) {
      this.setStatus("❌ Download failed");
      new Notice("❌ Download failed: " + this.errMsg(e));
    } finally {
      // fix #1 & #4: always unlock
      this.isSyncing = false;
    }
  }

  startAutoSync() {
    if (this.syncIntervalId !== null) {
      clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    this.fullTwoWaySync();
    // fix #9: minimum 1 second (was 10s)
    const ms = Math.max(1, this.settings.syncIntervalSeconds) * 1000;
    this.syncIntervalId = window.setInterval(() => {
      if (!this.isSyncing) this.fullTwoWaySync();
      else console.log("GDrive Sync: sync in progress, skipping tick");
    }, ms);
    this.setStatus("🔄 Auto-sync active");
    new Notice("✅ GDrive Auto-Sync started!");
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
    new Setting(containerEl).setName("Client ID").setDesc("Google Cloud Console → Credentials → OAuth 2.0 Client ID").addText(t => t.setPlaceholder("xxxx.apps.googleusercontent.com").setValue(this.plugin.settings.clientId).onChange(async v => { this.plugin.settings.clientId = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Client Secret").setDesc("Google Cloud Console → Credentials").addText(t => t.setPlaceholder("GOCSPX-...").setValue(this.plugin.settings.clientSecret).onChange(async v => { this.plugin.settings.clientSecret = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Refresh Token").setDesc("From OAuth Playground.").addText(t => t.setPlaceholder("1//0g...").setValue(this.plugin.settings.refreshToken).onChange(async v => { this.plugin.settings.refreshToken = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Drive Folder Name").addText(t => t.setValue(this.plugin.settings.driveFolderName).onChange(async v => { this.plugin.settings.driveFolderName = v.trim() || "ObsidianVaultSync"; this.plugin.driveFolderId = ""; await this.plugin.saveSettings(); }));
    // fix #9: slider minimum is now 1 second
    new Setting(containerEl).setName("Auto-sync interval (seconds)").addSlider(s => s.setLimits(1, 300, 1).setValue(this.plugin.settings.syncIntervalSeconds).setDynamicTooltip().onChange(async v => { this.plugin.settings.syncIntervalSeconds = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Auto-sync on Obsidian open").addToggle(t => t.setValue(this.plugin.settings.autoSyncOnStart).onChange(async v => { this.plugin.settings.autoSyncOnStart = v; await this.plugin.saveSettings(); }));
    containerEl.createEl("h3", { text: "Actions" });
    new Setting(containerEl).setName("Start auto-sync").addButton(b => b.setButtonText("▶ Start").setCta().onClick(() => this.plugin.startAutoSync()));
    new Setting(containerEl).setName("Stop auto-sync").addButton(b => b.setButtonText("⏸ Stop").onClick(() => this.plugin.stopAutoSync()));
    new Setting(containerEl).setName("Sync now").setDesc("Upload local changes and download Drive changes.").addButton(b => b.setButtonText("🔄 Two-Way Sync").onClick(() => this.plugin.fullTwoWaySync()));
    new Setting(containerEl).setName("Download from Drive").setDesc("Force download all files from Drive.").addButton(b => b.setButtonText("⬇ Download All").onClick(() => this.plugin.downloadAll()));
    new Setting(containerEl).setName("Check for update").setDesc("Manually check GitHub for a newer version.").addButton(b => b.setButtonText("🔄 Check Update").onClick(() => this.plugin.checkForUpdate()));
  }
}
