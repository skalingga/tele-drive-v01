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
import { ItemMenu, driveItemName, type DriveItem, type MenuAnchor, type MenuAction } from "./components/drive/ItemMenu";
import { Loader2, AlertCircle, X, Trash2, Eye, Download, Edit3, FolderOpen, RotateCcw, XCircle, Star } from "lucide-react";

const PAGE_SIZE = 60;
const SEARCH_DEBOUNCE_MS = 300;
const JOB_POLL_MS = 1000;
const TOAST_MS = 6000;

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
  const [isCollapsed, setIsCollapsed] = useState(() => window.matchMedia("(max-width: 767px)").matches);
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
  const [menu, setMenu] = useState<{ item: DriveItem; anchor: MenuAnchor } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [toast, setToast] = useState<{ id: number; message: string; undo?: () => void } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(cur => (cur?.id === toast.id ? null : cur)), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

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
    // A link click (not navigation) so the page never unloads; the server answers with Content-Disposition: attachment.
    const a = document.createElement("a");
    a.href = contentUrl(f.id, { download: true });
    a.download = f.name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const trashItem = (item: DriveItem) => {
    const name = driveItemName(item);
    void (async () => {
      try {
        if (item.type === "file") await api.deleteFile(item.file.id);
        else await api.deleteFolder(item.folder.id);
        await loadDriveData();
        setToast({
          id: Date.now(),
          message: `"${name}" dipindahkan ke sampah`,
          undo: () => void run(() => (item.type === "file" ? api.restoreFile(item.file.id) : api.restoreFolder(item.folder.id)))()
        });
      } catch (err) {
        showError(err);
      }
    })();
  };

  const restoreItem = (item: DriveItem) =>
    void run(async () => {
      if (item.type === "file") await api.restoreFile(item.file.id);
      else await api.restoreFolder(item.folder.id);
      setToast({ id: Date.now(), message: `"${driveItemName(item)}" dipulihkan` });
    })();

  const activateItem = (item: DriveItem) => {
    if (item.type === "folder") {
      if (currentTab === "trash") return;
      setCurrentTab("all");
      setCurrentFolderId(item.folder.id);
      setSearchQuery("");
    } else if (currentTab !== "trash" && item.file.status === "ready") {
      setPreviewFile(item.file);
    }
  };

  const actionsFor = (item: DriveItem): MenuAction[] => {
    const id = item.type === "file" ? item.file.id : item.folder.id;
    const name = driveItemName(item);
    if (currentTab === "trash") {
      return [
        { key: "restore", label: "Pulihkan", icon: RotateCcw, onSelect: () => restoreItem(item) },
        { key: "purge", label: "Hapus permanen", icon: XCircle, danger: true, onSelect: () => handleDeleteForever({ type: item.type, id, name }) }
      ];
    }
    const actions: MenuAction[] = [];
    if (item.type === "folder") {
      actions.push({ key: "open", label: "Buka", icon: FolderOpen, onSelect: () => activateItem(item) });
    } else if (item.file.status === "ready") {
      const file = item.file;
      actions.push(
        { key: "preview", label: "Pratinjau", icon: Eye, onSelect: () => setPreviewFile(file) },
        { key: "download", label: "Unduh", icon: Download, onSelect: () => downloadFile(file) },
        {
          key: "star",
          label: file.isFavorite ? "Hapus dari favorit" : "Tambah ke favorit",
          icon: Star,
          onSelect: () => void run(() => api.toggleFavorite(file.id))()
        }
      );
    }
    actions.push(
      { key: "rename", label: "Ganti nama", icon: Edit3, onSelect: () => setRenamingItem({ type: item.type, id, name }) },
      { key: "move", label: "Pindahkan…", icon: FolderOpen, onSelect: () => setMovingItem({ type: item.type, id, name }) },
      { key: "trash", label: "Pindahkan ke sampah", icon: Trash2, danger: true, onSelect: () => trashItem(item) }
    );
    return actions;
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
    onActivate: activateItem,
    onOpenMenu: (item: DriveItem, anchor: MenuAnchor) => setMenu({ item, anchor }),
    onDelete: (item: DriveItem) => {
      if (!isTrash) trashItem(item);
    },
    onToggleStar: (f: FileItem) => void run(() => api.toggleFavorite(f.id))(),
    onMoveItem: handleMoveItem
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
          <div role="alert" className="mx-4 md:mx-6 mt-3 flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-300">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Tutup"><X className="w-4 h-4" /></button>
          </div>
        )}

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
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

      {menu && <ItemMenu anchor={menu.anchor} actions={actionsFor(menu.item)} onClose={closeMenu} />}

      {toast && (
        <div role="status" className="td-toast">
          <span className="truncate">{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              className="td-toast-action"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Urungkan
            </button>
          )}
          <button type="button" aria-label="Tutup" onClick={() => setToast(null)} className="opacity-70 hover:opacity-100">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} onDownload={downloadFile} />

      <NewFolderDialog
        isOpen={isNewFolderOpen}
        onClose={() => setIsNewFolderOpen(false)}
        onSubmit={async name => {
          await api.createFolder(name, currentTab === "all" ? currentFolderId : null);
          await loadDriveData();
        }}
      />

      {renamingItem && (
        <RenameDialog
          key={renamingItem.id}
          isOpen
          initialName={renamingItem.name}
          onClose={() => setRenamingItem(null)}
          onSubmit={async newName => {
            if (renamingItem.type === "folder") await api.renameFolder(renamingItem.id, newName);
            else await api.renameFile(renamingItem.id, newName);
            await loadDriveData();
          }}
        />
      )}

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
