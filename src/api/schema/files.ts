/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type FileCreateRequest = { "path": string; "kind": ("file") | ("directory"); };

export type FileDeleted = { "deleted": { "path": string; "kind": FileEntryKind; }; };

export type FileEntry = { "name": string; "path": string; "kind": FileEntryKind; "size": number; "symlink"?: true; };

export type FileEntryKind = ("directory") | ("file") | ("symlink") | ("other");

export type FileEntryResponse = { "entry": FileEntry; };

export type FileError = { "error": string; "code"?: string; "current"?: FileRead; };

export type FileLocation = { "path": string; "kind": ("file") | ("directory"); };

export type FilePreviewKind = ("text") | ("image") | ("pdf") | ("binary") | ("too-large");

export type FileRead = { "path": string; "name": string; "size": number; "mtime": string; "etag": string; "writable": boolean; "kind": FilePreviewKind; "mimeType": string; "content"?: string; };

export type FileSaveRequest = { "content": string; };

export type FileSaved = { "path": string; "etag": string; "size": number; "mtime": string; };

export type FilesInfo = ({ "available": true; "root": string; "name": string; }) | ({ "available": false; "reason": string; });

export type FilesListing = { "path": string; "entries": Array<FileEntry>; "truncated": boolean; };

export type FilesResolve = { "entries": Array<(FileLocation) | (null)>; };

export type FilesResolveRequest = { "paths": Array<string>; };

export type FilesSearch = { "query": string; "entries": Array<FileEntry>; "truncated": boolean; "source": ("git") | ("walk"); };
