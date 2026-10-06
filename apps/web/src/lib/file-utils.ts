import { 
  FileImage, 
  FileVideo, 
  FileAudio, 
  FileText, 
  FileCode, 
  FileArchive, 
  File as FileDefault 
} from "lucide-react";

export function getFileCategory(mimeType: string, name: string): "image" | "video" | "audio" | "pdf" | "code" | "archive" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() || "";

  // SVG can carry scripts, so it is never rendered as an image — it is previewed as text.
  if (mimeType === "image/svg+xml" || ext === "svg") {
    return "code";
  }
  if (mimeType.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp"].includes(ext)) {
    return "image";
  }
  if (mimeType.startsWith("video/") || ["mp4", "mkv", "webm", "mov"].includes(ext)) {
    return "video";
  }
  if (mimeType.startsWith("audio/") || ["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) {
    return "audio";
  }
  if (mimeType === "application/pdf" || ext === "pdf") {
    return "pdf";
  }
  if (mimeType.startsWith("text/") || ["js", "ts", "jsx", "tsx", "json", "html", "css", "py", "rs", "go", "md", "txt", "csv", "log", "xml", "yml", "yaml", "sh", "sql", "ini", "toml"].includes(ext)) {
    return "code";
  }
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) {
    return "archive";
  }
  return "other";
}

export function getFileIcon(mimeType: string, name: string) {
  const cat = getFileCategory(mimeType, name);
  switch (cat) {
    case "image": return { icon: FileImage, typeClass: "image" };
    case "video": return { icon: FileVideo, typeClass: "document" };
    case "audio": return { icon: FileAudio, typeClass: "document" };
    case "pdf": return { icon: FileText, typeClass: "pdf" };
    case "code": return { icon: FileCode, typeClass: "document" };
    case "archive": return { icon: FileArchive, typeClass: "archive" };
    default: return { icon: FileDefault, typeClass: "generic" };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
  } catch {
    return isoString;
  }
}
