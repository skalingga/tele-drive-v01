import React from "react";
import { Folder as FolderIcon, MoreVertical } from "lucide-react";
import { getFileIcon, formatBytes, formatDate } from "../../lib/file-utils";
import { anchorFromElement, itemKeyHandler, type DriveItem, type DriveViewProps } from "./ItemMenu";
import { folderColorClass, useFolderDropTarget, startItemDrag } from "./drag";
import { RowActions, StatusBadge } from "./FileGrid";

export const FileList: React.FC<DriveViewProps> = ({
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

  if (folders.length === 0 && files.length === 0) {
    return <p className="py-20 text-center text-sm text-[var(--td-text-secondary)]">{isTrash ? "Sampah kosong." : "Belum ada file di sini."}</p>;
  }

  return (
    <div className="select-none">
      <div className="file-list-header file-list-row px-3 md:px-6">
        <div>Name</div>
        <div>Size</div>
        <div>Modified</div>
        <div />
      </div>

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
            className={`file-list-row px-3 md:px-6 group cursor-pointer ${drop.targetId === folder.id ? "is-drag-target" : ""}`}
          >
            <div className="flex items-center space-x-3 md:space-x-4 min-w-0">
              <div className={`td-file-list-icon shrink-0 ${folderColorClass(folder.name)}`}>
                <FolderIcon className="w-5 h-5 fill-current" />
              </div>
              <span className="font-semibold text-[14px] text-slate-800 dark:text-white truncate" title={folder.name}>{folder.name}</span>
            </div>
            <div className="text-[var(--td-text-secondary)] text-xs">—</div>
            <div className="text-[var(--td-text-secondary)] text-xs tabular-nums">{formatDate(folder.updatedAt)}</div>
            <div className="flex justify-end" onDoubleClick={e => e.stopPropagation()}>
              <button
                type="button"
                aria-label={`Aksi untuk ${folder.name}`}
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
          </div>
        );
      })}

      {files.map(file => {
        const item: DriveItem = { type: "file", file };
        const { icon: Icon, typeClass } = getFileIcon(file.mimeType, file.name);
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
                <Icon className="w-5 h-5" />
              </div>
              <span className="font-semibold text-[14px] text-slate-800 dark:text-white truncate" title={file.name}>{file.name}</span>
              <StatusBadge status={file.status} />
            </div>
            <div className="text-[var(--td-text-secondary)] text-xs tabular-nums">{formatBytes(file.sizeBytes)}</div>
            <div className="text-[var(--td-text-secondary)] text-xs tabular-nums">{formatDate(file.createdAt)}</div>
            <RowActions item={item} isTrash={isTrash} onToggleStar={onToggleStar} onOpenMenu={onOpenMenu} />
          </div>
        );
      })}
    </div>
  );
};
