import React from "react";
import { UploadCloud } from "lucide-react";

interface UploadZoneProps {
  isDragging: boolean;
  onDrop: (files: FileList) => void;
  onDragLeave: () => void;
}

export const UploadZone: React.FC<UploadZoneProps> = ({ isDragging, onDrop, onDragLeave }) => {
  if (!isDragging) return null;

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          onDrop(e.dataTransfer.files);
        }
        onDragLeave();
      }}
      className="drop-overlay"
    >
      <div className="drop-zone-card pointer-events-none">
        <UploadCloud className="w-12 h-12 drop-icon" />
        <h3 className="text-xl font-semibold text-[var(--td-text)] mb-2">Drop files anywhere</h3>
        <p className="text-[var(--td-text-secondary)]">
          Release to upload to My Drive
        </p>
      </div>
    </div>
  );
};
