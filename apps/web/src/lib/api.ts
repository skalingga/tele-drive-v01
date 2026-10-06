import type {
  User,
  Folder,
  FileItem,
  StorageAnalytics,
  TransferJob,
  ApiResponse,
  QrLoginState
} from "@teledrive/shared";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Fired when any request comes back 401 so the app can drop to the login screen. */
export const AUTH_EXPIRED_EVENT = "teledrive:auth-expired";

interface RequestOptions extends RequestInit {
  /** Don't broadcast AUTH_EXPIRED for 401s (used by the initial /me probe). */
  quiet401?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<{ data: T; meta: ApiResponse<T>["meta"] }> {
  const { quiet401, ...init } = options;
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (init.body !== undefined && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "Tidak dapat terhubung ke server. Periksa koneksi Anda.");
  }

  let json: ApiResponse<T> | null = null;
  if (res.headers.get("content-type")?.includes("application/json")) {
    json = (await res.json()) as ApiResponse<T>;
  }
  if (!res.ok || !json || json.error) {
    if (res.status === 401 && !quiet401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    throw new ApiError(res.status, json?.error?.code ?? "HTTP_ERROR", json?.error?.message ?? `Permintaan gagal (${res.status})`);
  }
  return { data: json.data as T, meta: json.meta };
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  const s = search.toString();
  return s ? `?${s}` : "";
}

export interface QrPollResult {
  state: QrLoginState;
  qrSvg: string | null;
  user: User | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

function toPage<T>(r: { data: T[]; meta: ApiResponse<T[]>["meta"] }): Page<T> {
  return { items: r.data, nextCursor: r.meta.next_cursor ?? null, total: r.meta.total ?? r.data.length };
}

export function contentUrl(fileId: string, options: { download?: boolean; asText?: boolean } = {}): string {
  return `/api/files/${encodeURIComponent(fileId)}/content${query({ disposition: options.download ? "attachment" : undefined, as: options.asText ? "text" : undefined })}`;
}

export const api = {
  // ─── Auth (Telegram QR) ───
  startQrLogin: () => request<{ started: boolean }>("/api/auth/qr", { method: "POST" }),
  pollQrLogin: () => request<QrPollResult>("/api/auth/qr", { quiet401: true }),
  submitQrPassword: (password: string) => request<{ submitted: boolean }>("/api/auth/qr/password", { method: "POST", body: JSON.stringify({ password }) }),
  cancelQrLogin: () => request<{ cancelled: boolean }>("/api/auth/qr", { method: "DELETE" }),
  logout: () => request<{ loggedOut: boolean }>("/api/auth/logout", { method: "POST" }),
  getMe: () => request<User>("/api/me", { quiet401: true }),

  // ─── Folders ───
  async listFolders(options: { parentId?: string | null; trash?: boolean; cursor?: string | null; limit?: number; signal?: AbortSignal } = {}) {
    const r = await request<Folder[]>(
      `/api/folders${query({ parent_id: options.parentId, filter: options.trash ? "trash" : undefined, cursor: options.cursor, limit: options.limit })}`,
      { signal: options.signal }
    );
    return { ...toPage(r), breadcrumbs: (r.meta.breadcrumbs as { id: string | null; name: string }[] | undefined) ?? [] };
  },
  createFolder: (name: string, parentId: string | null) =>
    request<Folder>("/api/folders", { method: "POST", body: JSON.stringify({ name, parent_id: parentId }) }),
  renameFolder: (id: string, name: string) =>
    request<Folder>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  moveFolder: (id: string, parentId: string | null) =>
    request<Folder>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify({ parent_id: parentId }) }),
  deleteFolder: (id: string) => request<{ trashed: boolean }>(`/api/folders/${id}`, { method: "DELETE" }),
  restoreFolder: (id: string) => request<Folder>(`/api/folders/${id}/restore`, { method: "POST" }),

  // ─── Files ───
  async listFiles(options: { folderId?: string | null; cursor?: string | null; limit?: number; filter?: string; sort?: string; type?: string; signal?: AbortSignal } = {}) {
    return toPage(await request<FileItem[]>(
      `/api/files${query({ folder_id: options.folderId, cursor: options.cursor, limit: options.limit, filter: options.filter, sort: options.sort, type: options.type })}`,
      { signal: options.signal }
    ));
  },
  async search(q: string, options: { cursor?: string | null; signal?: AbortSignal } = {}) {
    return toPage(await request<FileItem[]>(`/api/search${query({ q, cursor: options.cursor })}`, { signal: options.signal }));
  },
  renameFile: (id: string, name: string) => request<FileItem>(`/api/files/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  moveFile: (id: string, folderId: string | null) =>
    request<FileItem>(`/api/files/${id}`, { method: "PATCH", body: JSON.stringify({ folder_id: folderId }) }),
  deleteFile: (id: string) => request<{ trashed: boolean }>(`/api/files/${id}`, { method: "DELETE" }),
  restoreFile: (id: string) => request<FileItem>(`/api/files/${id}/restore`, { method: "POST" }),
  toggleFavorite: (id: string) => request<{ isFavorite: boolean }>(`/api/files/${id}/favorite`, { method: "POST" }),

  // ─── Trash ───
  deleteForever: (id: string) => request<{ files: number; folders: number }>(`/api/trash/${id}`, { method: "DELETE" }),
  emptyTrash: () => request<{ files: number; folders: number }>("/api/trash", { method: "DELETE" }),

  // ─── Uploads ───
  /** Sends the file to the server (phase 1). Returns an abort handle plus the eventual result. */
  uploadFile(file: File, folderId: string | null, onProgress: (pct: number) => void) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<{ file: FileItem; job: TransferJob }>((resolve, reject) => {
      const form = new FormData();
      if (folderId) form.append("folder_id", folderId);
      form.append("file", file);
      xhr.open("POST", "/api/files/upload");
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let json: ApiResponse<{ file: FileItem; job: TransferJob }> | null = null;
        try {
          json = JSON.parse(xhr.responseText);
        } catch {
          json = null;
        }
        if (xhr.status >= 200 && xhr.status < 300 && json?.data) resolve(json.data);
        else {
          if (xhr.status === 401) window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
          reject(new ApiError(xhr.status, json?.error?.code ?? "UPLOAD_FAILED", json?.error?.message ?? "Upload gagal"));
        }
      };
      xhr.onerror = () => reject(new ApiError(0, "NETWORK", "Koneksi terputus saat upload"));
      xhr.onabort = () => reject(new DOMException("Upload dibatalkan", "AbortError"));
      xhr.send(form);
    });
    return { promise, abort: () => xhr.abort() };
  },
  getJob: (id: string) => request<TransferJob>(`/api/uploads/${id}`),
  cancelJob: (id: string) => request<{ cancelled: boolean }>(`/api/uploads/${id}`, { method: "DELETE" }),

  getStorageAnalytics: () => request<StorageAnalytics>("/api/storage")
};
