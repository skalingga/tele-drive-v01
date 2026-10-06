import { z } from "zod";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const FileIdSchema = z.string().regex(new RegExp(`^fil_${uuid}$`), "Invalid file id");
export const FolderIdSchema = z.string().regex(new RegExp(`^fld_${uuid}$`), "Invalid folder id");
export const JobIdSchema = z.string().regex(new RegExp(`^job_${uuid}$`), "Invalid job id");
export const QrAttemptIdSchema = z.string().regex(/^qr_[A-Za-z0-9_-]{16,64}$/, "Invalid login attempt id");

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(255)
  .regex(/^[^<>:"/\\|?*\u0000-\u001f\u007f]+$/, "Name contains illegal characters")
  .refine(n => !/^\.+$/.test(n), "Name cannot consist of dots only");

const cursorSchema = z.string().max(512).optional();
const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

export const FileListQuerySchema = z.object({
  cursor: cursorSchema,
  limit: limitSchema,
  folder_id: FolderIdSchema.optional(),
  filter: z.enum(["all", "favorites", "trash", "recent"]).default("all"),
  sort: z.enum(["name_asc", "name_desc", "size_asc", "size_desc", "date_asc", "date_desc"]).default("date_desc"),
  type: z.enum(["all", "image", "video", "audio", "document", "archive", "other"]).default("all")
});
/** @deprecated kept for backwards compatibility — use FileListQuerySchema */
export const PaginationQuerySchema = FileListQuerySchema;

export const FolderListQuerySchema = z.object({
  cursor: cursorSchema,
  limit: limitSchema,
  parent_id: FolderIdSchema.optional(),
  filter: z.enum(["all", "trash"]).default("all")
});

export const SearchQuerySchema = z.object({
  q: z.string().trim().min(1, "Search term cannot be empty").max(255),
  cursor: cursorSchema,
  limit: limitSchema
});

export const CreateFolderSchema = z.object({
  name: nameSchema,
  parent_id: FolderIdSchema.nullable().optional()
});

export const UpdateFolderSchema = z
  .object({
    name: nameSchema.optional(),
    parent_id: FolderIdSchema.nullable().optional()
  })
  .refine(v => v.name !== undefined || v.parent_id !== undefined, "Nothing to update");

export const UpdateFileSchema = z
  .object({
    name: nameSchema.optional(),
    folder_id: FolderIdSchema.nullable().optional()
  })
  .refine(v => v.name !== undefined || v.folder_id !== undefined, "Nothing to update");

export const UploadBodySchema = z.object({
  folder_id: FolderIdSchema.optional().or(z.literal("").transform(() => undefined))
});

export const ContentQuerySchema = z.object({
  disposition: z.enum(["inline", "attachment"]).default("inline"),
  as: z.enum(["text"]).optional()
});

export const QrPasswordSchema = z.object({
  password: z.string().min(1, "Password is required").max(256)
});
