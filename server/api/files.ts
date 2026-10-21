/** Public Files view payloads for working-directory entries, previews, saves and path resolution. */
import { Type, type Static } from "typebox";

export const FileEntryKind = Type.Union([Type.Literal("directory"), Type.Literal("file"), Type.Literal("symlink"), Type.Literal("other")], { $id: "FileEntryKind" });
export type FileEntryKind = Static<typeof FileEntryKind>;

export const FileEntry = Type.Object({
  name: Type.String(), path: Type.String(), kind: FileEntryKind, size: Type.Number(), symlink: Type.Optional(Type.Literal(true)),
}, { $id: "FileEntry" });
export type FileEntry = Static<typeof FileEntry>;

export const FilesInfo = Type.Union([
  Type.Object({ available: Type.Literal(true), root: Type.String(), name: Type.String() }),
  Type.Object({ available: Type.Literal(false), reason: Type.String() }),
], { $id: "FilesInfo" });
export type FilesInfo = Static<typeof FilesInfo>;

export const FilesListing = Type.Object({ path: Type.String(), entries: Type.Array(FileEntry), truncated: Type.Boolean() }, { $id: "FilesListing" });
export type FilesListing = Static<typeof FilesListing>;

export const FilesSearch = Type.Object({
  query: Type.String(), entries: Type.Array(FileEntry), truncated: Type.Boolean(), source: Type.Union([Type.Literal("git"), Type.Literal("walk")]),
}, { $id: "FilesSearch" });
export type FilesSearch = Static<typeof FilesSearch>;

export const FilePreviewKind = Type.Union([
  Type.Literal("text"), Type.Literal("image"), Type.Literal("pdf"), Type.Literal("binary"), Type.Literal("too-large"),
], { $id: "FilePreviewKind" });
export type FilePreviewKind = Static<typeof FilePreviewKind>;

export const FileRead = Type.Object({
  path: Type.String(), name: Type.String(), size: Type.Number(), mtime: Type.String(), etag: Type.String(), writable: Type.Boolean(),
  kind: FilePreviewKind, mimeType: Type.String(), content: Type.Optional(Type.String()),
}, { $id: "FileRead" });
export type FileRead = Static<typeof FileRead>;

export const FileLocation = Type.Object({ path: Type.String(), kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]) }, { $id: "FileLocation" });
export type FileLocation = Static<typeof FileLocation>;

export const FilesResolve = Type.Object({ entries: Type.Array(Type.Union([FileLocation, Type.Null()])) }, { $id: "FilesResolve" });
export type FilesResolve = Static<typeof FilesResolve>;

export const FileSaved = Type.Object({ path: Type.String(), etag: Type.String(), size: Type.Number(), mtime: Type.String() }, { $id: "FileSaved" });
export type FileSaved = Static<typeof FileSaved>;

export const FileSaveRequest = Type.Object({ content: Type.String() }, { $id: "FileSaveRequest" });
export type FileSaveRequest = Static<typeof FileSaveRequest>;

export const FileCreateRequest = Type.Object({ path: Type.String(), kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]) }, { $id: "FileCreateRequest" });
export type FileCreateRequest = Static<typeof FileCreateRequest>;

export const FilesResolveRequest = Type.Object({ paths: Type.Array(Type.String()) }, { $id: "FilesResolveRequest" });
export type FilesResolveRequest = Static<typeof FilesResolveRequest>;

export const FileEntryResponse = Type.Object({ entry: FileEntry }, { $id: "FileEntryResponse" });
export type FileEntryResponse = Static<typeof FileEntryResponse>;

export const FileDeleted = Type.Object({ deleted: Type.Object({ path: Type.String(), kind: FileEntryKind }) }, { $id: "FileDeleted" });
export type FileDeleted = Static<typeof FileDeleted>;

export const FileError = Type.Object({ error: Type.String(), code: Type.Optional(Type.String()), current: Type.Optional(FileRead) }, { $id: "FileError" });
export type FileError = Static<typeof FileError>;

export const routeSchemas = [
  { method: "GET", path: "/__hui/sessions/:id/files", response: FilesInfo },
  { method: "GET", path: "/__hui/sessions/:id/files/list", response: FilesListing },
  { method: "GET", path: "/__hui/sessions/:id/files/search", response: FilesSearch },
  { method: "GET", path: "/__hui/sessions/:id/files/file", response: FileRead },
  { method: "PUT", path: "/__hui/sessions/:id/files/file", request: FileSaveRequest, response: FileSaved },
  { method: "POST", path: "/__hui/sessions/:id/files/entry", request: FileCreateRequest, response: FileEntryResponse },
  { method: "DELETE", path: "/__hui/sessions/:id/files/entry", response: FileDeleted },
  { method: "POST", path: "/__hui/sessions/:id/files/upload", response: FileEntryResponse },
  { method: "POST", path: "/__hui/sessions/:id/files/resolve", request: FilesResolveRequest, response: FilesResolve },
];
