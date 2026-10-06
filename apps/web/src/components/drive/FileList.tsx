import React from "react";
import { 
  Folder as FolderIcon, 
  MoreVertical, 
  Star, 
  Download, 
  Eye, 
  Trash2, 
  RotateCcw, 
  XCircle,
  Edit3,
  FolderOpen
} from "lucide-react";
import { Folder, FileItem } from "@teledrive/shared";
import { getFileIcon, formatBytes, formatDate } from "../../lib/file-utils";

interface FileListProps {
  folders: Folder[];
  files: FileItem[];
  isTrash: boolean;
  onOpenFolder: (folderId: string) => void;
  onPreviewFile: (file: FileItem) => void;
  onDownloadFile: (file: FileItem) => void;
  onToggleStar: (file: FileItem) => void;
  onRenameFolder: (folder: Folder) => void;
  onDeleteFolder: (folder: Folder) => void;
  onRestoreFolder: (folder: Folder) => void;
  onRenameFile: (file: FileItem) => void;
  onDeleteFile: (file: FileItem) => void;
  onRestoreFile: (file: FileItem) => void;
  onDeleteForever: (item: { type: "file" | "folder"; id: string; name: string }) => void;
  onMoveItem?: (type: "file" | "folder", id: string, targetFolderId: string | null) => void;
  onMoveRequest: (item: { type: "file" | "folder", id: string, name: string }) => void;
}

export const FileList: React.FC<FileListProps> = ({
  folders,
  files,
  isTrash,
  onOpenFolder,
  onPreviewFile,
  onDownloadFile,
  onToggleStar,
  onRenameFolder,
  onDeleteFolder,
  onRestoreFolder,
  onRenameFile,
  onDeleteFile,
  onRestoreFile,
  onDeleteForever,
  onMoveItem,
  onMoveRequest
}) => {
  const [activeMenuId, setActiveMenuId] = React.useState<string | null>(null);
  const [dragTargetId, setDragTargetId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const handleClickOutside = () => setActiveMenuId(null);
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const folderColors = ["folder-color-orange", "folder-color-red", "folder-color-purple", "folder-color-blue", "folder-color-green"];
  const getFolderColor = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return folderColors[Math.abs(hash) % folderColors.length];
  };

  return (
    <div className="select-none space-y-4">
      {folders.length > 0 && (
        <div className="mb-8">
          <h3 className="text-[14px] font-bold text-slate-800 dark:text-slate-100 mb-4 px-1">
            Folders
          </h3>
          <div className="file-list-header file-list-row px-6">
            <div>Name</div>
            <div>Size</div>
            <div>Modified</div>
            <div className="text-center"></div>
          </div>
          <div className="flex flex-col">
            {folders.map((folder) => {
              const colorClass = getFolderColor(folder.name);
              
              return (
                <div
                  key={folder.id}
                  draggable={!isTrash}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("itemId", folder.id);
                    e.dataTransfer.setData("itemType", "folder");
                  }}
                  onDragEnter={(e) => {
                    if (!isTrash && onMoveItem) {
                      e.preventDefault();
                      setDragTargetId(folder.id);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (dragTargetId === folder.id) {
                      setDragTargetId(null);
                    }
                  }}
                  onDragOver={(e) => {
                    if (!isTrash) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragTargetId(null);
                    if (isTrash || !onMoveItem) return;
                    const itemId = e.dataTransfer.getData("itemId");
                    const itemType = e.dataTransfer.getData("itemType") as "file" | "folder";
                    if (itemId && itemId !== folder.id) {
                      onMoveItem(itemType, itemId, folder.id);
                    }
                  }}
                  onDoubleClick={() => !isTrash && onOpenFolder(folder.id)}
                  className={`file-list-row px-6 group cursor-pointer ${dragTargetId === folder.id ? "is-drag-target" : ""}`}
                >
                  <div className="flex items-center space-x-4">
                    <div className={`td-file-list-icon ${colorClass}`}>
                      <FolderIcon className="w-5 h-5 fill-current" />
                    </div>
                    <span className="font-semibold text-[14px] text-slate-800 dark:text-white">
                      {folder.name}
                    </span>
                  </div>
                  <div className="text-[var(--td-text-secondary)] text-[13px] font-medium">—</div>
                  <div className="text-[var(--td-text-secondary)] text-[13px] font-medium font-variant-numeric tabular-nums">{formatDate(folder.updatedAt)}</div>
                  <div className="relative flex justify-end">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveMenuId(activeMenuId === folder.id ? null : folder.id);
                      }}
                      className="td-context-trigger"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

              {activeMenuId === folder.id && (
                <div 
                  onClick={(e) => e.stopPropagation()}
                  className="td-context-menu"
                  style={{ right: '0', top: '100%', marginTop: '4px' }}
                >
                  {!isTrash ? (
                    <>
                      <button onClick={() => { setActiveMenuId(null); onRenameFolder(folder); }} className="td-context-item">
                        <span><Edit3 className="w-3.5 h-3.5 inline mr-2" /> Rename</span>
                      </button>
                      <button onClick={() => { setActiveMenuId(null); onMoveRequest({ type: "folder", id: folder.id, name: folder.name }); }} className="td-context-item">
                        <span><FolderOpen className="w-3.5 h-3.5 inline mr-2" /> Move</span>
                      </button>
                      <button onClick={() => { setActiveMenuId(null); onDeleteFolder(folder); }} className="td-context-item is-danger">
                        <span><Trash2 className="w-3.5 h-3.5 inline mr-2" /> Trash</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setActiveMenuId(null); onRestoreFolder(folder); }} className="td-context-item">
                        <span><RotateCcw className="w-3.5 h-3.5 inline mr-2" /> Restore</span>
                      </button>
                      <button onClick={() => { setActiveMenuId(null); onDeleteForever({ type: "folder", id: folder.id, name: folder.name }); }} className="td-context-item is-danger">
                        <span><XCircle className="w-3.5 h-3.5 inline mr-2" /> Hapus permanen</span>
                      </button>
                    </>
                  )}
                </div>
              )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div>
          <h3 className="text-[14px] font-bold text-slate-800 dark:text-slate-100 mb-4 px-1 mt-6">
            Files
          </h3>
          {folders.length === 0 && (
            <div className="file-list-header file-list-row px-6">
              <div>Name</div>
              <div>Size</div>
              <div>Modified</div>
              <div className="text-center"></div>
            </div>
          )}
          <div className="flex flex-col">
            {files.map((file) => {
              const { icon: Icon, typeClass } = getFileIcon(file.mimeType, file.name) as any;

              return (
                <div
                  key={file.id}
                  draggable={!isTrash}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("itemId", file.id);
                    e.dataTransfer.setData("itemType", "file");
                  }}
                  onDoubleClick={() => !isTrash && file.status === "ready" && onPreviewFile(file)}
                  className="file-list-row px-6 group cursor-pointer"
                >
                  <div className="flex items-center space-x-4">
                    <div className={`td-file-list-icon ${typeClass}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <span className="font-semibold text-[14px] text-slate-800 dark:text-white truncate max-w-xs sm:max-w-md">
                      {file.name}
                    </span>
                    {file.status === "failed" && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-500">Upload gagal</span>
                    )}
                    {(file.status === "pending" || file.status === "uploading") && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-500">Mengunggah ke Telegram…</span>
                    )}
              </div>
              <div className="text-[var(--td-text-secondary)] text-xs font-variant-numeric tabular-nums">
                {formatBytes(file.sizeBytes)}
              </div>
              <div className="text-[var(--td-text-secondary)] text-xs font-variant-numeric tabular-nums">
                {formatDate(file.createdAt)}
              </div>
              <div className="relative flex items-center justify-end space-x-1">
                {!isTrash && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleStar(file);
                    }}
                    className={`td-context-trigger ${file.isFavorite ? "text-amber-400 opacity-100" : ""}`}
                  >
                    <Star className={`w-4 h-4 ${file.isFavorite ? "fill-current" : ""}`} />
                  </button>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveMenuId(activeMenuId === file.id ? null : file.id);
                  }}
                  className="td-context-trigger"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>

                {activeMenuId === file.id && (
                  <div 
                    onClick={(e) => e.stopPropagation()}
                    className="td-context-menu"
                    style={{ right: '0', top: '100%', marginTop: '4px' }}
                  >
                    {!isTrash ? (
                      <>
                        {file.status === "ready" && (
                          <>
                            <button onClick={() => { setActiveMenuId(null); onPreviewFile(file); }} className="td-context-item">
                              <span><Eye className="w-3.5 h-3.5 inline mr-2" /> Preview</span>
                            </button>
                            <button onClick={() => { setActiveMenuId(null); onDownloadFile(file); }} className="td-context-item">
                              <span><Download className="w-3.5 h-3.5 inline mr-2" /> Download</span>
                            </button>
                          </>
                        )}
                        <button onClick={() => { setActiveMenuId(null); onRenameFile(file); }} className="td-context-item">
                          <span><Edit3 className="w-3.5 h-3.5 inline mr-2" /> Rename</span>
                        </button>
                        <button onClick={() => { setActiveMenuId(null); onMoveRequest({ type: "file", id: file.id, name: file.name }); }} className="td-context-item">
                          <span><FolderOpen className="w-3.5 h-3.5 inline mr-2" /> Move</span>
                        </button>
                        <button onClick={() => { setActiveMenuId(null); onDeleteFile(file); }} className="td-context-item is-danger">
                          <span><Trash2 className="w-3.5 h-3.5 inline mr-2" /> Trash</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => { setActiveMenuId(null); onRestoreFile(file); }} className="td-context-item">
                          <span><RotateCcw className="w-3.5 h-3.5 inline mr-2" /> Restore</span>
                        </button>
                        <button onClick={() => { setActiveMenuId(null); onDeleteForever({ type: "file", id: file.id, name: file.name }); }} className="td-context-item is-danger">
                          <span><XCircle className="w-3.5 h-3.5 inline mr-2" /> Hapus permanen</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
        </div>
      )}
    </div>
  );
};

