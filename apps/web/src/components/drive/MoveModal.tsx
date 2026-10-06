import React, { useState, useEffect } from "react";
import { X, Folder as FolderIcon, ChevronRight, Home, Loader2 } from "lucide-react";
import type { Folder } from "@teledrive/shared";
import { api } from "../../lib/api";

interface MoveModalProps {
  isOpen: boolean;
  onClose: () => void;
  onMove: (targetFolderId: string | null) => Promise<void>;
  itemType: "file" | "folder";
  itemId: string;
  itemName: string;
}

export const MoveModal: React.FC<MoveModalProps> = ({ isOpen, onClose, onMove, itemType, itemId, itemName }) => {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: "My Drive" }
  ]);
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadFolders(null);
    }
  }, [isOpen]);

  const loadFolders = async (folderId: string | null) => {
    setIsLoading(true);
    try {
      const all: Folder[] = [];
      let cursor: string | null = null;
      let crumbs: { id: string | null; name: string }[] = [];
      do {
        const page = await api.listFolders({ parentId: folderId, cursor, limit: 200 });
        all.push(...page.items);
        crumbs = page.breadcrumbs;
        cursor = page.nextCursor;
      } while (cursor);
      // A folder can't be moved into itself or its subfolders: hide it so it can't be entered.
      setFolders(itemType === "folder" ? all.filter(f => f.id !== itemId) : all);
      setBreadcrumbs(crumbs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleNavigate = (folderId: string | null) => {
    setCurrentFolderId(folderId);
    loadFolders(folderId);
  };

  const handleMove = async () => {
    setIsMoving(true);
    setError(null);
    try {
      await onMove(currentFolderId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsMoving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-md overflow-hidden border border-slate-200 dark:border-slate-800">
        <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-semibold text-slate-800 dark:text-slate-200">Move {itemType}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 bg-slate-50 dark:bg-slate-950/50 text-sm text-slate-600 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800">
          Moving: <span className="font-medium text-slate-900 dark:text-slate-200">{itemName}</span>
        </div>

        {/* Breadcrumbs */}
        <div className="px-4 py-2 flex items-center overflow-x-auto whitespace-nowrap text-sm border-b border-slate-100 dark:border-slate-800">
          {breadcrumbs.map((b, idx) => (
            <React.Fragment key={b.id || "root"}>
              {idx > 0 && <ChevronRight className="w-4 h-4 mx-1 text-slate-400 shrink-0" />}
              <button 
                onClick={() => handleNavigate(b.id)}
                className={`hover:text-blue-500 transition flex items-center gap-1 ${
                  idx === breadcrumbs.length - 1 ? "font-medium text-slate-800 dark:text-slate-200" : "text-slate-500"
                }`}
              >
                {b.id === null ? <Home className="w-3.5 h-3.5" /> : null}
                {b.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {error && (
          <div className="mx-4 mt-3 p-2.5 text-xs rounded-xl bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900">
            {error}
          </div>
        )}

        {/* Folder List */}
        <div className="h-64 overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex justify-center items-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : folders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <FolderIcon className="w-8 h-8 mb-2 opacity-20" />
              <p className="text-sm">Empty folder</p>
            </div>
          ) : (
            folders.map(f => (
              <button
                key={f.id}
                onClick={() => handleNavigate(f.id)}
                className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition text-sm text-slate-700 dark:text-slate-200"
              >
                <div className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-500">
                  <FolderIcon className="w-4 h-4 fill-current" />
                </div>
                <span className="truncate">{f.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-3 bg-slate-50 dark:bg-slate-950/50">
          <button 
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl transition"
          >
            Cancel
          </button>
          <button 
            onClick={handleMove}
            disabled={isMoving}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition flex items-center gap-2 disabled:opacity-50"
          >
            {isMoving && <Loader2 className="w-4 h-4 animate-spin" />}
            Move Here
          </button>
        </div>
      </div>
    </div>
  );
};
