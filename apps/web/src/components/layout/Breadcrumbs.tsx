import React from "react";
import { ChevronRight, Home, Folder } from "lucide-react";

interface BreadcrumbItem {
  id: string | null;
  name: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
  onSelect: (folderId: string | null) => void;
  onMoveItem?: (type: "file" | "folder", id: string, targetFolderId: string | null) => void;
}

export const Breadcrumbs: React.FC<BreadcrumbsProps> = ({ items, onSelect, onMoveItem }) => {
  return (
    <nav className="flex items-center space-x-1.5 text-sm py-3 px-6 overflow-x-auto select-none border-b border-slate-100 dark:border-slate-800/60">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        const isRoot = item.id === null;

        return (
          <div key={item.id || "root"} className="flex items-center space-x-1.5 flex-shrink-0">
            {index > 0 && <span className="text-[var(--td-text-muted)] text-lg px-1 leading-none font-light">›</span>}
            <button
              onClick={() => onSelect(item.id)}
              onDragOver={(e) => {
                if (!isLast && onMoveItem) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (isLast || !onMoveItem) return;
                const itemId = e.dataTransfer.getData("itemId");
                const itemType = e.dataTransfer.getData("itemType") as "file" | "folder";
                if (itemId && itemId !== item.id) {
                  onMoveItem(itemType, itemId, item.id);
                }
              }}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg ${
                isLast
                  ? "breadcrumb-current cursor-default"
                  : "breadcrumb-parent cursor-pointer"
              }`}
            >
              {isRoot ? <Home className="w-3.5 h-3.5 opacity-70" /> : <Folder className="w-3.5 h-3.5 opacity-70" />}
              <span>{item.name}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
};
