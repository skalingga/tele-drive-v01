import React from "react";
import { 
  Search, 
  Upload, 
  FolderPlus, 
  RotateCw, 
  LayoutGrid, 
  List, 
  X } from "lucide-react";

interface TopbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onOpenNewFolder: () => void;
  onTriggerUpload: () => void;
  onRefresh: () => void;
  viewMode: "grid" | "list";
  onToggleViewMode: () => void;
  isRefreshing: boolean;
  sortOrder: string;
  onSortOrderChange: (val: string) => void;
  typeFilter: string;
  onTypeFilterChange: (val: string) => void;
}

export const Topbar: React.FC<TopbarProps> = ({
  searchQuery,
  onSearchChange,
  onOpenNewFolder,
  onTriggerUpload,
  onRefresh,
  viewMode,
  onToggleViewMode,
  isRefreshing,
  sortOrder,
  onSortOrderChange,
  typeFilter,
  onTypeFilterChange
}) => {
  return (
    <header className="h-[76px] md:h-[100px] px-4 md:px-10 flex items-center justify-between gap-3 md:gap-6 sticky top-0 z-20 bg-[var(--td-bg-canvas)]">
      {/* Search Bar */}
      <div className="flex-1 min-w-0 max-w-xl relative">
        <Search className="w-5 h-5 text-slate-400 absolute left-5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Type to search..."
          className="w-full pl-14 pr-10 py-3.5 rounded-[18px] bg-white dark:bg-slate-800 focus:outline-none text-[14px] text-slate-900 dark:text-slate-100 placeholder:text-slate-400 font-medium"
        />
        {searchQuery && (
          <button 
            onClick={() => onSearchChange("")}
            className="absolute right-5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-900"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 md:gap-3 shrink-0">
        <button
          onClick={onToggleViewMode}
          className="w-10 h-10 md:w-12 md:h-12 flex items-center justify-center rounded-[14px] bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-900 dark:hover:text-white transition"
          aria-label={viewMode === "grid" ? "Tampilan daftar" : "Tampilan grid"}
          title={viewMode === "grid" ? "Switch to List View" : "Switch to Grid View"}
        >
          {viewMode === "grid" ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
        </button>
        
        <button
          onClick={onRefresh}
          className={`hidden md:flex w-10 h-10 md:w-12 md:h-12 items-center justify-center rounded-[14px] bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-900 dark:hover:text-white transition ${
            isRefreshing ? "text-slate-900 dark:text-white" : ""
          }`}
          title="Muat ulang"
          aria-label="Muat ulang"
        >
          <RotateCw className={`w-5 h-5 ${isRefreshing ? "animate-spin" : ""}`} />
        </button>

        <button
          onClick={onOpenNewFolder}
          className="flex items-center gap-2 px-3 md:px-6 h-10 md:h-12 rounded-[14px] bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white font-semibold text-[14px] transition"
          title="Buat folder baru"
        >
          <FolderPlus className="w-5 h-5" />
          <span className="hidden md:inline">Folder baru</span>
        </button>

        <button
          onClick={onTriggerUpload}
          title="Upload file"
          className="flex items-center gap-2 px-3 md:px-6 h-10 md:h-12 rounded-[14px] bg-black dark:bg-white text-white dark:text-black font-semibold text-[14px] transition shadow-lg shadow-black/10 hover:-translate-y-0.5"
        >
          <Upload className="w-4 h-4" />
          <span className="hidden md:inline">Upload</span>
        </button>
      </div>
    </header>
  );
};
