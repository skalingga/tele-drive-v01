import React, { useEffect, useState } from "react";
import { X, Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import type { FileItem } from "@teledrive/shared";
import { contentUrl as buildContentUrl } from "../../lib/api";
import { getFileCategory, formatBytes, formatDate } from "../../lib/file-utils";

interface PreviewModalProps {
  file: FileItem | null;
  onClose: () => void;
  onDownload: (file: FileItem) => void;
}

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

export const PreviewModal: React.FC<PreviewModalProps> = ({ file, onClose, onDownload }) => {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [isLoadingText, setIsLoadingText] = useState(false);

  useEffect(() => {
    if (!file) return;
    const cat = getFileCategory(file.mimeType, file.name);

    if (cat === "code") {
      if (file.sizeBytes > MAX_TEXT_PREVIEW_BYTES) {
        setTextContent("File terlalu besar untuk pratinjau teks. Silakan unduh.");
        return;
      }
      const ctrl = new AbortController();
      setIsLoadingText(true);
      fetch(buildContentUrl(file.id, { asText: true }), { signal: ctrl.signal })
        .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
        .then((text) => setTextContent(text))
        .catch((err) => {
          if (err.name !== "AbortError") setTextContent("Gagal memuat pratinjau teks.");
        })
        .finally(() => setIsLoadingText(false));
      return () => ctrl.abort();
    }
    setTextContent(null);
  }, [file]);

  useEffect(() => {
    if (!file) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [file, onClose]);

  if (!file) return null;

  const contentUrl = buildContentUrl(file.id);
  const category = getFileCategory(file.mimeType, file.name);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Pratinjau ${file.name}`}
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex flex-col items-center justify-center p-4 sm:p-6 animate-fade-in select-none"
    >
      {/* Header */}
      <div className="w-full max-w-5xl flex items-center justify-between py-3 px-4 rounded-2xl bg-slate-900/90 text-white mb-3 shadow-xl border border-slate-800">
        <div className="flex items-center space-x-3 overflow-hidden">
          <FileText className="w-5 h-5 text-blue-400 flex-shrink-0" />
          <div className="truncate">
            <h3 className="text-sm font-semibold truncate">{file.name}</h3>
            <p className="text-[11px] text-slate-400">
              {formatBytes(file.sizeBytes)} • {formatDate(file.createdAt)}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => onDownload(file)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download</span>
          </button>

          <a
            href={contentUrl}
            target="_blank"
            rel="noreferrer"
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
            title="Open in new tab"
          >
            <ExternalLink className="w-4 h-4" />
          </a>

          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
            title="Tutup (Esc)"
            aria-label="Tutup"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Content Preview Area */}
      <div className="w-full max-w-5xl flex-1 max-h-[82vh] rounded-2xl bg-slate-950 border border-slate-800/80 overflow-hidden flex items-center justify-center relative shadow-2xl">
        {category === "image" && (
          <img
            src={contentUrl}
            alt={file.name}
            className="max-w-full max-h-full object-contain"
          />
        )}

        {category === "video" && (
          <video
            controls
            autoPlay
            className="w-full max-h-full object-contain rounded-xl"
            src={contentUrl}
          >
            Your browser does not support video streaming.
          </video>
        )}

        {category === "audio" && (
          <div className="p-8 flex flex-col items-center gap-4 bg-slate-900 rounded-3xl border border-slate-800">
            <div className="w-20 h-20 rounded-2xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
              <FileText className="w-10 h-10" />
            </div>
            <p className="text-white font-medium">{file.name}</p>
            <audio controls autoPlay className="w-80" src={contentUrl}>
              Your browser does not support audio streaming.
            </audio>
          </div>
        )}

        {category === "pdf" && (
          <iframe
            src={contentUrl}
            title={file.name}
            className="w-full h-full border-none"
          />
        )}

        {category === "code" && (
          <div className="w-full h-full p-6 overflow-auto font-mono text-xs text-slate-200 bg-slate-900 selection:bg-blue-600">
            {isLoadingText ? (
              <div className="flex items-center justify-center h-full gap-2 text-slate-400">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Loading preview...</span>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap">{textContent}</pre>
            )}
          </div>
        )}

        {category === "archive" || category === "other" ? (
          <div className="text-center p-8">
            <FileText className="w-16 h-16 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-300 font-medium">No preview available for this file type</p>
            <p className="text-xs text-slate-500 mt-1 mb-4">You can download the file to inspect its contents</p>
            <button
              onClick={() => onDownload(file)}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-md transition"
            >
              Download File
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};
