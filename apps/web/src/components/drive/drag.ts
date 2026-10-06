import React, { useState } from "react";

const FOLDER_COLORS = ["folder-color-orange", "folder-color-red", "folder-color-purple", "folder-color-blue", "folder-color-green"];

/** Stable colour per folder name. */
export function folderColorClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return FOLDER_COLORS[Math.abs(hash) % FOLDER_COLORS.length];
}

export const startItemDrag = (type: "file" | "folder", id: string) => (e: React.DragEvent) => {
  e.dataTransfer.setData("itemId", id);
  e.dataTransfer.setData("itemType", type);
  e.dataTransfer.effectAllowed = "move";
};

/** Folders accept dropped files/folders (moves them inside). */
export function useFolderDropTarget(
  isTrash: boolean,
  onMoveItem: (type: "file" | "folder", id: string, targetFolderId: string | null) => void
) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const handlersFor = (folderId: string) => ({
    onDragEnter: (e: React.DragEvent) => {
      if (isTrash || !e.dataTransfer.types.includes("itemid")) return;
      e.preventDefault();
      setTargetId(folderId);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isTrash && e.dataTransfer.types.includes("itemid")) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTargetId(t => (t === folderId ? null : t));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setTargetId(null);
      if (isTrash) return;
      const itemId = e.dataTransfer.getData("itemId");
      const itemType = e.dataTransfer.getData("itemType") as "file" | "folder";
      if (itemId && itemId !== folderId) onMoveItem(itemType, itemId, folderId);
    }
  });
  return { targetId, handlersFor };
}
