import React from "react";
import { 
  X, 
  ChevronUp, 
  ChevronDown, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  FileText 
} from "lucide-react";
import { formatBytes } from "../../lib/file-utils";

export interface UploadQueueItem {
  id: string;
  name: string;
  sizeBytes: number;
  progressPct: number;
  /** uploading = browser → server, transferring = server → Telegram */
  status: "queued" | "uploading" | "transferring" | "completed" | "failed" | "cancelled";
  error?: string;
}

const STATUS_LABEL: Record<UploadQueueItem["status"], string> = {
  queued: "Menunggu",
  uploading: "Mengunggah ke server",
  transferring: "Mengirim ke Telegram",
  completed: "Selesai",
  failed: "Gagal",
  cancelled: "Dibatalkan"
};

interface UploadQueueProps {
  items: UploadQueueItem[];
  onCancel: (id: string) => void;
  onClearCompleted: () => void;
}

export const UploadQueue: React.FC<UploadQueueProps> = ({ items, onCancel, onClearCompleted }) => {
  const [isMinimized, setIsMinimized] = React.useState(false);

  if (items.length === 0) return null;

  const activeCount = items.filter(i => i.status === "uploading" || i.status === "queued" || i.status === "transferring").length;
  const completedCount = items.filter(i => i.status === "completed").length;

  return (
    <div className="upload-queue overflow-hidden transition-all duration-200">
      {/* Drawer Header */}
      <div 
        onClick={() => setIsMinimized(!isMinimized)}
        className="px-4 py-3 bg-slate-900 dark:bg-slate-950 text-white flex items-center justify-between cursor-pointer select-none"
      >
        <div className="flex items-center space-x-2">
          {activeCount > 0 ? (
            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          )}
          <span className="text-sm font-semibold">
            {activeCount > 0 ? `Uploading ${activeCount} file${activeCount > 1 ? "s" : ""}...` : "Transfers completed"}
          </span>
        </div>

        <div className="flex items-center space-x-1">
          {completedCount > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClearCompleted();
              }}
              className="text-[11px] text-slate-300 hover:text-white px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700"
            >
              Clear
            </button>
          )}
          <button className="p-1 text-slate-400 hover:text-white">
            {isMinimized ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Items List */}
      {!isMinimized && (
        <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 p-2">
          {items.map((item) => (
            <div key={item.id} className="p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center space-x-2 overflow-hidden flex-1 pr-2">
                  <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  <span className="font-medium text-slate-800 dark:text-slate-200 truncate">{item.name}</span>
                </div>

                <div className="flex items-center space-x-1.5 flex-shrink-0">
                  {item.status === "completed" && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                  {item.status === "failed" && <AlertCircle className="w-4 h-4 text-rose-500" />}
                  {(item.status === "uploading" || item.status === "transferring") && (
                    <span className="text-blue-600 dark:text-blue-400 font-semibold">{item.progressPct}%</span>
                  )}
                  {(item.status === "queued" || item.status === "uploading" || item.status === "transferring") && (
                    <button
                      onClick={() => onCancel(item.id)}
                      className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      title="Cancel"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-300 rounded-full ${
                    item.status === "completed" 
                      ? "bg-emerald-500" 
                      : item.status === "failed" 
                      ? "bg-rose-500" 
                      : "bg-blue-600 animate-pulse"
                  }`}
                  style={{ width: `${item.progressPct}%` }}
                />
              </div>

              <div className="flex justify-between text-[10px] text-slate-400">
                <span>{formatBytes(item.sizeBytes)}</span>
                <span title={item.error}>{STATUS_LABEL[item.status]}{item.status === "failed" && item.error ? ` — ${item.error}` : ""}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
