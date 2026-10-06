import React from "react";
import { 
  Search, 
  Upload, 
  FolderPlus, 
  RotateCw, 
  LayoutGrid, 
  List, 
  X 
} from "lucide-react";

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
    <header className="h-[100px] px-10 flex items-center justify-between gap-6 sticky top-0 z-20 bg-[var(--td-bg-canvas)]">
      {/* Search Bar */}
      <div className="flex-1 max-w-xl relative">
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
      <div className="flex items-center space-x-3">
        <button
          onClick={onToggleViewMode}
          className="w-12 h-12 flex items-center justify-center rounded-[14px] bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-900 transition"
          title={viewMode === "grid" ? "Switch to List View" : "Switch to Grid View"}
        >
          {viewMode === "grid" ? <List className="w-5 h-5" /> : <LayoutGrid className="w-5 h-5" />}
        </button>
        
        <button
          onClick={onRefresh}
          className={`w-12 h-12 flex items-center justify-center rounded-[14px] bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-900 transition ${
            isRefreshing ? "animate-spin text-slate-900" : ""
          }`}
          title="Refresh Drive"
        >
          <RotateCw className="w-5 h-5" />
        </button>

        <button
          onClick={onOpenNewFolder}
          className="flex items-center gap-2 px-6 h-12 rounded-[14px] bg-white dark:bg-slate-800 text-slate-500 hover:text-slate-900 font-semibold text-[14px] transition ml-2"
        >
          <div className="w-5 h-5 rounded-full border-2 border-current flex items-center justify-center opacity-70">
            <span className="text-[12px] leading-none">+</span>
          </div>
          <span>Create</span>
        </button>

        <button
          onClick={onTriggerUpload}
          className="flex items-center gap-2 px-6 h-12 rounded-[14px] bg-black dark:bg-white text-white dark:text-black font-semibold text-[14px] transition shadow-lg shadow-black/10 hover:-translate-y-0.5 ml-2"
        >
          <Upload className="w-4 h-4" />
          <span>Upload</span>
        </button>
      </div>
    </header>
  );
};
