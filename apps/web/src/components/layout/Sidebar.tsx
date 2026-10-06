import React from "react";
import { Folder, Clock, Star, Trash2, Moon, Sun, LogOut, Cloud, HardDrive } from "lucide-react";
import type { StorageAnalytics, User } from "@teledrive/shared";

export type DriveTab = "all" | "recent" | "favorites" | "trash";

interface SidebarProps {
  currentTab: DriveTab;
  onSelectTab: (tab: DriveTab) => void;
  storage: StorageAnalytics | null;
  user: User | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isDark: boolean;
  onToggleDark: () => void;
  onLogout: () => void;
}

const NAV_ITEMS: { id: DriveTab; label: string; icon: typeof Folder }[] = [
  { id: "all", label: "My Drive", icon: Folder },
  { id: "recent", label: "Terbaru", icon: Clock },
  { id: "favorites", label: "Favorit", icon: Star },
  { id: "trash", label: "Sampah", icon: Trash2 }
];

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  storage,
  user,
  isCollapsed,
  isDark,
  onToggleDark,
  onLogout
}) => {
  return (
    <aside
      className={`h-screen flex flex-col bg-white dark:bg-slate-900 transition-all duration-300 select-none z-30 ${
        isCollapsed ? "w-16 md:w-24" : "w-[280px]"
      }`}
    >
      <div className="h-[100px] flex items-center px-8">
        <div className="flex items-center space-x-3 overflow-hidden">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white flex-shrink-0">
            <Cloud className="w-5 h-5" />
          </div>
          {!isCollapsed && (
            <span className="font-extrabold text-[16px] text-slate-900 dark:text-white tracking-wide">TeleDrive</span>
          )}
        </div>
      </div>

      <nav className="flex-1 py-4 space-y-2 overflow-y-auto">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <div key={item.id} className="relative flex items-center">
              {isActive && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1.5 h-8 bg-black dark:bg-white rounded-r-full" />}
              <button
                onClick={() => onSelectTab(item.id)}
                aria-current={isActive ? "page" : undefined}
                className={`w-full flex items-center space-x-4 px-8 py-3.5 transition-colors ${
                  isActive ? "text-black dark:text-white font-bold" : "text-slate-400 hover:text-slate-600 font-medium"
                }`}
              >
                <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? "text-black dark:text-white" : "text-slate-300"}`} />
                {!isCollapsed && <span className="text-[14px] truncate">{item.label}</span>}
              </button>
            </div>
          );
        })}
      </nav>

      {!isCollapsed && storage && (
        <div className="mx-6 mb-6 p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-slate-700 dark:text-slate-200">
            <HardDrive className="w-4 h-4" /> {storage.formattedUsed} terpakai
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {storage.totalFiles} file · {storage.totalFolders} folder — disimpan di channel "TeleDrive Storage" pada akun Telegram Anda.
          </p>
        </div>
      )}

      <div className="p-6 border-t border-slate-100 dark:border-slate-800 space-y-3">
        {!isCollapsed && user && (
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate">{user.displayName}</p>
            {user.username && <p className="text-[11px] text-slate-500 truncate">@{user.username}</p>}
          </div>
        )}
        <div className="flex items-center justify-between">
          <button onClick={onLogout} className="flex items-center space-x-3 text-slate-400 hover:text-slate-900 dark:hover:text-white transition">
            <LogOut className="w-5 h-5" />
            {!isCollapsed && <span className="font-semibold text-[14px]">Keluar</span>}
          </button>
          <button
            onClick={onToggleDark}
            className="p-2 rounded-lg text-slate-400 hover:text-slate-900 dark:hover:text-white transition"
            title={isDark ? "Mode terang" : "Mode gelap"}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </aside>
  );
};
