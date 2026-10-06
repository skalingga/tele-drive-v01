import React from "react";
import { Folder as FolderIcon, MoreVertical, Star, Loader2 } from "lucide-react";
import { getFileIcon, formatBytes, formatDate } from "../../lib/file-utils";
import { anchorFromElement, itemKeyHandler, type DriveItem, type DriveViewProps } from "./ItemMenu";
import { folderColorClass, useFolderDropTarget, startItemDrag } from "./drag";

export const FileGrid: React.FC<DriveViewProps> = ({
  folders,
  files,
  isTrash,
  onActivate,
  onOpenMenu,
  onDelete,
  onToggleStar,
  onMoveItem
}) => {
  const drop = useFolderDropTarget(isTrash, onMoveItem);
  const keys = (item: DriveItem) => itemKeyHandler(item, { onActivate, onOpenMenu, onDelete });
  const contextMenu = (item: DriveItem) => (e: React.MouseEvent) => {
    e.preventDefault();
    onOpenMenu(item, { x: e.clientX, y: e.clientY, align: "start" });
  };

  return (
    <div className="space-y-10 select-none">
      {folders.length > 0 && (
        <div>
          <h3 className="text-[14px] font-bold text-slate-800 dark:text-slate-100 mb-4 px-1">Folders</h3>
          <div className="td-folder-grid">
            {folders.map(folder => {
              const item: DriveItem = { type: "folder", folder };
              return (
                <div
                  key={folder.id}
                  tabIndex={0}
                  aria-label={`Folder ${folder.name}`}
                  draggable={!isTrash}
                  onDragStart={startItemDrag("folder", folder.id)}
                  {...drop.handlersFor(folder.id)}
                  onDoubleClick={() => onActivate(item)}
                  onContextMenu={contextMenu(item)}
                  onKeyDown={keys(item)}
                  className={`td-folder-card ${drop.targetId === folder.id ? "is-drag-target" : ""}`}
                >
                  {drop.targetId === folder.id && <div className="td-drag-target-badge">Lepas ke folder</div>}

                  <div className={`td-folder-icon-box ${folderColorClass(folder.name)}`}>
                    <FolderIcon className="w-6 h-6 fill-current" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <h4 className="text-[15px] font-bold text-slate-900 dark:text-white truncate mb-0.5" title={folder.name}>{folder.name}</h4>
                    <p className="text-[12px] text-slate-500 font-medium">{formatDate(folder.updatedAt)}</p>
                  </div>

                  <button
                    type="button"
                    aria-label={`Aksi untuk ${folder.name}`}
                    aria-haspopup="menu"
                    onClick={e => {
                      e.stopPropagation();
                      onOpenMenu(item, anchorFromElement(e.currentTarget));
                    }}
                    onDoubleClick={e => e.stopPropagation()}
                    className="td-context-trigger"
                  >
                    <MoreVertical className="w-5 h-5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <h3 className="text-[14px] font-bold text-slate-800 dark:text-slate-100 mb-4 px-1">Files</h3>

        {files.length === 0 && folders.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center">
            <div className="w-24 h-24 mb-6 rounded-full bg-[var(--td-primary-soft)] flex items-center justify-center">
              <FolderIcon className="w-10 h-10 text-[var(--td-primary)] opacity-60" />
            </div>
            <h3 className="text-lg font-semibold text-[var(--td-text-primary)] mb-2">{isTrash ? "Sampah kosong" : "Nothing here yet"}</h3>
            <p className="text-[var(--td-text-secondary)] text-sm max-w-sm mb-6">
              {isTrash ? "Item yang Anda hapus akan muncul di sini." : "Upload files or create a new folder to start organizing your Drive."}
            </p>
            {!isTrash && (
              <div className="text-xs text-[var(--td-text-muted)] border border-[var(--td-border)] rounded-full px-4 py-1.5 bg-[var(--td-surface)] shadow-sm">
                Drag & Drop is supported
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col">
            {files.length > 0 && (
              <div className="file-list-header file-list-row px-3 md:px-6">
                <div>Name</div>
                <div>Size</div>
                <div>Modified</div>
                <div />
              </div>
            )}
            {files.map(file => {
              const item: DriveItem = { type: "file", file };
              const { icon: Icon, typeClass } = getFileIcon(file.mimeType, file.name);
              const isUploading = file.status === "uploading" || file.status === "pending";

              return (
                <div
                  key={file.id}
                  tabIndex={0}
                  aria-label={file.name}
                  draggable={!isTrash}
                  onDragStart={startItemDrag("file", file.id)}
                  onDoubleClick={() => onActivate(item)}
                  onContextMenu={contextMenu(item)}
                  onKeyDown={keys(item)}
                  className="file-list-row px-3 md:px-6 group cursor-pointer"
                >
                  <div className="flex items-center space-x-3 md:space-x-4 min-w-0">
                    <div className={`td-file-list-icon shrink-0 ${typeClass}`}>
                      {isUploading ? <Loader2 className="w-5 h-5 animate-spin text-[var(--td-primary)]" /> : <Icon className="w-5 h-5" />}
                    </div>
                    <span className="font-semibold text-[14px] text-slate-800 dark:text-white truncate" title={file.name}>
                      {file.name}
                    </span>
                    <StatusBadge status={file.status} />
                  </div>
                  <div className="text-[var(--td-text-secondary)] text-xs tabular-nums">{formatBytes(file.sizeBytes)}</div>
                  <div className="text-[var(--td-text-secondary)] text-xs tabular-nums">{formatDate(file.createdAt)}</div>
                  <RowActions item={item} isTrash={isTrash} onToggleStar={onToggleStar} onOpenMenu={onOpenMenu} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  if (status === "failed") {
    return <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-500">Upload gagal</span>;
  }
  if (status === "pending" || status === "uploading") {
    return <span className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-500">Mengunggah ke Telegram…</span>;
  }
  return null;
};

/** Star + ⋮ at the end of a file row (shared by grid and list views). */
export const RowActions: React.FC<{
  item: Extract<DriveItem, { type: "file" }>;
  isTrash: boolean;
  onToggleStar: DriveViewProps["onToggleStar"];
  onOpenMenu: DriveViewProps["onOpenMenu"];
}> = ({ item, isTrash, onToggleStar, onOpenMenu }) => {
  const { file } = item;
  return (
    <div className="flex items-center justify-end gap-1" onDoubleClick={e => e.stopPropagation()}>
      {!isTrash && (
        <button
          type="button"
          aria-label={file.isFavorite ? "Hapus dari favorit" : "Tambah ke favorit"}
          aria-pressed={file.isFavorite}
          onClick={e => {
            e.stopPropagation();
            onToggleStar(file);
          }}
          className={`td-context-trigger ${file.isFavorite ? "is-on" : ""}`}
        >
          <Star className={`w-4 h-4 ${file.isFavorite ? "fill-current" : ""}`} />
        </button>
      )}
      <button
        type="button"
        aria-label={`Aksi untuk ${file.name}`}
        aria-haspopup="menu"
        onClick={e => {
          e.stopPropagation();
          onOpenMenu(item, anchorFromElement(e.currentTarget));
        }}
        className="td-context-trigger"
      >
        <MoreVertical className="w-4 h-4" />
      </button>
    </div>
  );
};
