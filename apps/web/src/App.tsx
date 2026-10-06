import React, { useState, useEffect, useRef, useCallback } from "react";
import type { User, Folder, FileItem, StorageAnalytics } from "@teledrive/shared";
import { api, contentUrl, AUTH_EXPIRED_EVENT } from "./lib/api";
import { Sidebar, type DriveTab } from "./components/layout/Sidebar";
import { Topbar } from "./components/layout/Topbar";
import { Breadcrumbs } from "./components/layout/Breadcrumbs";
import { FileGrid } from "./components/drive/FileGrid";
import { FileList } from "./components/drive/FileList";
import { UploadZone } from "./components/drive/UploadZone";
import { UploadQueue, type UploadQueueItem } from "./components/drive/UploadQueue";
import { PreviewModal } from "./components/preview/PreviewModal";
import { NewFolderDialog } from "./components/dialogs/NewFolderDialog";
import { RenameDialog } from "./components/dialogs/RenameDialog";
import { MoveModal } from "./components/drive/MoveModal";
import { AuthPage } from "./pages/AuthPage";
import { Loader2, AlertCircle, X, Trash2 } from "lucide-react";

const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 300;
const JOB_POLL_MS = 1000;

type Crumb = { id: string | null; name: string };

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);

  // Navigation & view
  const [currentTab, setCurrentTab] = useState<DriveTab>("all");
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Crumb[]>([{ id: null, name: "My Drive" }]);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortOrder, setSortOrder] = useState<string>("date_desc");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isDark, setIsDark] = useState(() => {
    try {
      return localStorage.getItem("teledrive_theme") !== "light";
    } catch {
      return true;
    }
  });

  // Data (paginated)
  const [folders, setFolders] = useState<Folder[]>([]);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [folderCursor, setFolderCursor] = useState<string | null>(null);
  const [fileCursor, setFileCursor] = useState<string | null>(null);
  const [totalFiles, setTotalFiles] = useState(0);
  const [storage, setStorage] = useState<StorageAnalytics | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebounced(searchQuery.trim(), SEARCH_DEBOUNCE_MS);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadAbort = useRef<AbortController | null>(null);

  // Uploads
  const [isDragging, setIsDragging] = useState(false);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const uploadHandles = useRef(new Map<string, { abort: () => void; jobId?: string }>());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dialogs
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [isNewFolderOpen, setIsNewFolderOpen] = useState(false);
  const [renamingItem, setRenamingItem] = useState<{ type: "folder" | "file"; id: string; name: string } | null>(null);
  const [movingItem, setMovingItem] = useState<{ type: "file" | "folder"; id: string; name: string } | null>(null);

  const showError = useCallback((err: unknown) => {
    if ((err as Error)?.name === "AbortError") return;
    setError(err instanceof Error ? err.message : "Terjadi kesalahan");
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    try {
      localStorage.setItem("teledrive_theme", isDark ? "dark" : "light");
    } catch {
      /* storage unavailable — theme just won't persist */
    }
  }, [isDark]);

  useEffect(() => {
    api.getMe()
      .then(({ data }) => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setIsInitializing(false));
    const onExpired = () => setUser(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  /** Loads the first page of the current view; aborts any older in-flight load (no stale results). */
  const loadDriveData = useCallback(async () => {
    if (!user) return;
    loadAbort.current?.abort();
    const ctrl = new AbortController();
    loadAbort.current = ctrl;
    setIsRefreshing(true);
    try {
      if (debouncedSearch) {
        const page = await api.search(debouncedSearch, { signal: ctrl.signal });
        setFolders([]);
        setFolderCursor(null);
        setFiles(page.items);
        setFileCursor(page.nextCursor);
        setTotalFiles(page.total);
      } else {
        const showFolders = currentTab === "all" || currentTab === "trash";
        const [folderPage, filePage, storageRes] = await Promise.all([
          showFolders
            ? api.listFolders({ parentId: currentTab === "all" ? currentFolderId : null, trash: currentTab === "trash", signal: ctrl.signal })
            : Promise.resolve(null),
          api.listFiles({ folderId: currentFolderId, filter: currentTab, sort: sortOrder, type: typeFilter, limit: PAGE_SIZE, signal: ctrl.signal }),
          api.getStorageAnalytics()
        ]);
        setFolders(folderPage?.items ?? []);
        setFolderCursor(folderPage?.nextCursor ?? null);
        if (folderPage && currentTab === "all") setBreadcrumbs(folderPage.breadcrumbs);
        setFiles(filePage.items);
        setFileCursor(filePage.nextCursor);
        setTotalFiles(filePage.total);
        setStorage(storageRes.data);
      }
    } catch (err) {
      showError(err);
    } finally {
      if (loadAbort.current === ctrl) setIsRefreshing(false);
    }
  }, [user, currentFolderId, currentTab, debouncedSearch, sortOrder, typeFilter, showError]);

  useEffect(() => {
    void loadDriveData();
  }, [loadDriveData]);

  const loadMore = async () => {
    setIsLoadingMore(true);
    try {
      if (folderCursor) {
        const page = await api.listFolders({ parentId: currentTab === "all" ? currentFolderId : null, trash: currentTab === "trash", cursor: folderCursor });
        setFolders(prev => [...prev, ...page.items]);
        setFolderCursor(page.nextCursor);
      } else if (fileCursor) {
        const page = debouncedSearch
          ? await api.search(debouncedSearch, { cursor: fileCursor })
          : await api.listFiles({ folderId: currentFolderId, filter: currentTab, sort: sortOrder, type: typeFilter, limit: PAGE_SIZE, cursor: fileCursor });
        setFiles(prev => [...prev, ...page.items]);
        setFileCursor(page.nextCursor);
      }
    } catch (err) {
      showError(err);
    } finally {
      setIsLoadingMore(false);
    }
  };

  // ─── Uploads: phase 1 = browser → server (XHR progress), phase 2 = server → Telegram (job polling) ───

  const updateQueueItem = (id: string, patch: Partial<UploadQueueItem>) =>
    setUploadQueue(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)));

  const pollJob = async (queueId: string, jobId: string): Promise<void> => {
    while (uploadHandles.current.has(queueId)) {
      try {
        const { data: job } = await api.getJob(jobId);
        const pct = job.totalBytes > 0 ? Math.round((job.progressBytes / job.totalBytes) * 100) : 100;
        if (job.status === "completed") {
          updateQueueItem(queueId, { status: "completed", progressPct: 100 });
          return;
        }
        if (job.status === "failed" || job.status === "cancelled") {
          updateQueueItem(queueId, { status: job.status === "failed" ? "failed" : "cancelled", error: job.errorCode ?? undefined });
          return;
        }
        updateQueueItem(queueId, { status: "transferring", progressPct: pct });
      } catch (err) {
        updateQueueItem(queueId, { status: "failed", error: (err as Error).message });
        return;
      }
      await new Promise(r => window.setTimeout(r, JOB_POLL_MS));
    }
  };

  const handleUploadFiles = async (fileList: FileList) => {
    const targetFolder = currentTab === "all" ? currentFolderId : null;
    const items: UploadQueueItem[] = Array.from(fileList).map(f => ({
      id: `queue_${crypto.randomUUID()}`,
      name: f.name,
      sizeBytes: f.size,
      progressPct: 0,
      status: "queued"
    }));
    setUploadQueue(prev => [...prev, ...items]);

    for (let i = 0; i < fileList.length; i++) {
      const queueId = items[i].id;
      const { promise, abort } = api.uploadFile(fileList[i], targetFolder, pct => updateQueueItem(queueId, { progressPct: pct }));
      uploadHandles.current.set(queueId, { abort });
      updateQueueItem(queueId, { status: "uploading" });
      try {
        const { job } = await promise;
        uploadHandles.current.set(queueId, { abort: () => undefined, jobId: job.id });
        updateQueueItem(queueId, { status: "transferring", progressPct: 0 });
        void pollJob(queueId, job.id).finally(() => {
          uploadHandles.current.delete(queueId);
          void loadDriveData();
        });
      } catch (err) {
        uploadHandles.current.delete(queueId);
        const aborted = (err as Error).name === "AbortError";
        updateQueueItem(queueId, { status: aborted ? "cancelled" : "failed", error: aborted ? undefined : (err as Error).message });
      }
    }
    void loadDriveData();
  };

  const cancelUpload = async (queueId: string) => {
    const handle = uploadHandles.current.get(queueId);
    if (!handle) {
      setUploadQueue(prev => prev.filter(i => i.id !== queueId));
      return;
    }
    if (handle.jobId) {
      try {
        await api.cancelJob(handle.jobId);
        uploadHandles.current.delete(queueId);
        updateQueueItem(queueId, { status: "cancelled" });
        void loadDriveData();
      } catch (err) {
        showError(err); // already transferring to Telegram — cannot be cancelled
      }
    } else {
      handle.abort();
    }
  };

  // ─── Actions ───

  const run = (action: () => Promise<unknown>) => async () => {
    try {
      await action();
      await loadDriveData();
    } catch (err) {
      showError(err);
    }
  };

  const handleMoveItem = async (type: "file" | "folder", id: string, targetFolderId: string | null) => {
    await run(() => (type === "file" ? api.moveFile(id, targetFolderId) : api.moveFolder(id, targetFolderId)))();
  };

  const handleDeleteForever = (item: { type: "file" | "folder"; id: string; name: string }) => {
    const what = item.type === "folder" ? `folder "${item.name}" beserta isinya` : `"${item.name}"`;
    if (!window.confirm(`Hapus permanen ${what}? File juga dihapus dari Telegram dan tidak bisa dikembalikan.`)) return;
    void run(() => api.deleteForever(item.id))();
  };

  const handleEmptyTrash = () => {
    if (!window.confirm("Kosongkan sampah? Semua item di sampah dihapus permanen dari Telegram.")) return;
    void run(() => api.emptyTrash())();
  };

  const downloadFile = (f: FileItem) => {
    window.location.assign(contentUrl(f.id, { download: true }));
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
    }
  };

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!user) {
    return <AuthPage onSuccess={u => setUser(u)} />;
  }

  const isTrash = currentTab === "trash";
  const hasMore = Boolean(folderCursor || fileCursor);
  const driveProps = {
    folders,
    files,
    isTrash,
    onOpenFolder: (fId: string) => {
      setCurrentTab("all");
      setCurrentFolderId(fId);
    },
    onPreviewFile: (f: FileItem) => setPreviewFile(f),
    onDownloadFile: downloadFile,
    onToggleStar: (f: FileItem) => void run(() => api.toggleFavorite(f.id))(),
    onRenameFolder: (fld: Folder) => setRenamingItem({ type: "folder", id: fld.id, name: fld.name }),
    onDeleteFolder: (fld: Folder) => void run(() => api.deleteFolder(fld.id))(),
    onRestoreFolder: (fld: Folder) => void run(() => api.restoreFolder(fld.id))(),
    onRenameFile: (f: FileItem) => setRenamingItem({ type: "file", id: f.id, name: f.name }),
    onDeleteFile: (f: FileItem) => void run(() => api.deleteFile(f.id))(),
    onRestoreFile: (f: FileItem) => void run(() => api.restoreFile(f.id))(),
    onDeleteForever: handleDeleteForever,
    onMoveItem: handleMoveItem,
    onMoveRequest: setMovingItem
  };

  return (
    <div onDragEnter={handleDragEnter} className="flex h-screen w-screen overflow-hidden bg-[var(--td-bg-canvas)] text-[var(--td-text-primary)]">
      <input
        type="file"
        ref={fileInputRef}
        multiple
        className="hidden"
        onChange={e => {
          if (e.target.files && e.target.files.length > 0) void handleUploadFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <Sidebar
        currentTab={currentTab}
        onSelectTab={tab => {
          setCurrentTab(tab);
          setCurrentFolderId(null);
          setBreadcrumbs([{ id: null, name: "My Drive" }]);
          setSearchQuery("");
        }}
        storage={storage}
        user={user}
        isCollapsed={isCollapsed}
        onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
        isDark={isDark}
        onToggleDark={() => setIsDark(!isDark)}
        onLogout={async () => {
          try {
            await api.logout();
          } finally {
            setUser(null);
          }
        }}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        <Topbar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onOpenNewFolder={() => setIsNewFolderOpen(true)}
          onTriggerUpload={() => fileInputRef.current?.click()}
          onRefresh={() => void loadDriveData()}
          viewMode={viewMode}
          onToggleViewMode={() => setViewMode(viewMode === "grid" ? "list" : "grid")}
          isRefreshing={isRefreshing}
          sortOrder={sortOrder}
          onSortOrderChange={setSortOrder}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
        />

        {currentTab === "all" && !debouncedSearch && (
          <Breadcrumbs
            items={breadcrumbs}
            onSelect={fId => {
              setCurrentFolderId(fId);
              setSearchQuery("");
            }}
            onMoveItem={handleMoveItem}
          />
        )}

        {error && (
          <div role="alert" className="mx-6 mt-3 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Tutup"><X className="w-4 h-4" /></button>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-6">
          {isTrash && (folders.length > 0 || files.length > 0) && (
            <div className="mb-4 flex items-center justify-between rounded-xl bg-slate-100 dark:bg-slate-800/60 px-4 py-3 text-sm">
              <span className="text-slate-600 dark:text-slate-300">Item di sampah bisa dipulihkan sampai Anda menghapusnya permanen.</span>
              <button onClick={handleEmptyTrash} className="flex items-center gap-1.5 font-semibold text-rose-600 hover:text-rose-700">
                <Trash2 className="w-4 h-4" /> Kosongkan sampah
              </button>
            </div>
          )}

          {viewMode === "grid" ? <FileGrid {...driveProps} /> : <FileList {...driveProps} />}

          {hasMore && (
            <div className="flex justify-center py-6">
              <button
                onClick={() => void loadMore()}
                disabled={isLoadingMore}
                className="px-5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isLoadingMore && <Loader2 className="w-4 h-4 animate-spin" />}
                Muat lebih banyak ({files.length} dari {totalFiles} file)
              </button>
            </div>
          )}
        </main>
      </div>

      <UploadZone
        isDragging={isDragging}
        onDragLeave={() => setIsDragging(false)}
        onDrop={dropped => {
          setIsDragging(false);
          void handleUploadFiles(dropped);
        }}
      />

      <UploadQueue
        items={uploadQueue}
        onCancel={id => void cancelUpload(id)}
        onClearCompleted={() => setUploadQueue(prev => prev.filter(i => !["completed", "cancelled"].includes(i.status)))}
      />

      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onDownload={downloadFile} />

      <NewFolderDialog
        isOpen={isNewFolderOpen}
        onClose={() => setIsNewFolderOpen(false)}
        onSubmit={async name => {
          await api.createFolder(name, currentTab === "all" ? currentFolderId : null);
          await loadDriveData();
        }}
      />

      <RenameDialog
        isOpen={!!renamingItem}
        initialName={renamingItem?.name ?? ""}
        onClose={() => setRenamingItem(null)}
        onSubmit={async newName => {
          if (!renamingItem) return;
          if (renamingItem.type === "folder") await api.renameFolder(renamingItem.id, newName);
          else await api.renameFile(renamingItem.id, newName);
          await loadDriveData();
        }}
      />

      {movingItem && (
        <MoveModal
          isOpen
          onClose={() => setMovingItem(null)}
          itemType={movingItem.type}
          itemId={movingItem.id}
          itemName={movingItem.name}
          onMove={async targetFolderId => {
            const action = movingItem.type === "file" ? api.moveFile(movingItem.id, targetFolderId) : api.moveFolder(movingItem.id, targetFolderId);
            await action;
            await loadDriveData();
          }}
        />
      )}
    </div>
  );
};
