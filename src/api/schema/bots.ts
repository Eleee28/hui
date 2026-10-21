/** Generated from docs/api.schema.json by scripts/api-schema.ts. Do not edit. */

export type BotAccessRequest = { "id": string; "sessionId": string; "title": string; "message": string; };

export type BotAvatar = { "emoji"?: string; "color"?: string; "shape"?: BotFaceShape; "ears"?: BotFaceEars; };

export type BotAvatarPatch = { "emoji"?: string; "color"?: string; "shape"?: (BotFaceShape) | (""); "ears"?: (BotFaceEars) | (""); };

export type BotCatalog = { "tools": Array<BotCatalogTool>; "skills": Array<BotCatalogSkill>; "alwaysOn": Array<{ "name": string; "description": string; }>; "disabledTools": Array<string>; "disabledSkills": Array<BotSkillRef>; "live": boolean; "request"?: BotAccessRequest; };

export type BotCatalogSkill = { "name": string; "path": string; "description": string; "source": string; "enabled": boolean; };

export type BotCatalogTool = { "name": string; "label": string; "description": string; "group": BotToolGroup; "source": string; "powerful": boolean; "enabled": boolean; };

export type BotDeleteResponse = (BotResponse) | (BotDeleted);

export type BotDeleted = { "ok": true; "queued"?: true; };

export type BotDelivery = { "status": "sent" | "queued"; };

export type BotFaceEars = "cat" | "bear" | "bunny" | "antenna" | "sprout" | "horns";

export type BotFaceShape = "blob" | "round" | "triangle" | "heart" | "cookie" | "star" | "flower" | "cloud" | "drop" | "ghost" | "pill" | "block" | "hexagon";

export type BotFact = { "id": string; "kind": BotFactKind; "text": string; "pinned": boolean; "source": string; "createdAt": string; "updatedAt": string; "revision": number; };

export type BotFactInput = { "kind": BotFactKind; "text": string; "source"?: string; "pinned"?: boolean; };

export type BotFactKind = ("fact") | ("preference") | ("decision");

export type BotFactPatch = { "kind"?: BotFactKind; "text"?: string; "pinned"?: boolean; "revision": number; };

export type BotFactsResponse = { "facts": Array<BotFact>; };

export type BotInput = { "name"?: string; "handle"?: string; "title"?: string; "description"?: string; "tagging"?: BotTagging; "cwd"?: string; "model"?: string; "thinking"?: string; "memoryModel"?: string; "memoryThinking"?: string; "hidden"?: boolean; "disabledTools"?: Array<string>; "disabledSkills"?: Array<BotSkillSelector>; "soul"?: string; "worker"?: string; "avatar"?: BotAvatar; "voice"?: BotVoice; };

export type BotLastMessage = { "role": ("user") | ("assistant"); "text": string; "at": string; };

export type BotMemoryResponse = { "status": BotMemoryStatus; "view": string; };

export type BotMemoryStatus = { "messages": number; "built": number; "pending": number; "viewBytes": number; "viewLines": number; "waiting"?: boolean; "failing"?: { "node": string; "error": string; "since": string; }; "usage": BotMemoryUsage; };

export type BotMemoryUsage = { "calls": number; "input": number; "output": number; "cacheRead": number; "cacheWrite": number; "cost": number; };

export type BotMemoryZoom = { "text": string; };

export type BotMessageRequest = { "text"?: string; "attachments"?: Array<unknown>; "wait"?: boolean; "timeoutSeconds"?: number; };

export type BotMessageResult = (BotDelivery) | (BotReply);

export type BotPatch = { "name"?: string; "handle"?: string; "title"?: string; "description"?: string; "tagging"?: BotTagging; "cwd"?: string; "model"?: string; "thinking"?: string; "memoryModel"?: string; "memoryThinking"?: string; "hidden"?: boolean; "disabledTools"?: Array<string>; "disabledSkills"?: Array<BotSkillSelector>; "avatar"?: (BotAvatarPatch) | (null); "voice"?: (BotVoicePatch) | (null); };

export type BotQuestion = { "id": string; "method": "select" | "confirm" | "input" | "editor" | "secret" | "questionnaire"; "title": string; "message"?: string; "options"?: Array<string>; "placeholder"?: string; "prefill"?: string; };

export type BotReply = { "status": "answered" | "failed" | "needs-input" | "timeout"; "reply"?: string; "error"?: string; "questions"?: Array<BotQuestion>; };

export type BotResponse = { "bot": BotView; };

export type BotSessionStatus = "idle" | "running" | "waiting" | "starting" | "error" | "reconnecting" | "disconnected";

export type BotSkillRef = { "name": string; "path": string; };

export type BotSkillSelector = (string) | (BotSkillRef);

export type BotSoul = { "soul": (string) | (null); };

export type BotSoulRequest = { "soul": string; };

export type BotTagging = "anyone" | "mention" | "nobody";

export type BotToolGroup = "files" | "shell" | "hui" | "extension" | "bots";

export type BotView = { "id": string; "handle": string; "name": string; "title"?: string; "description"?: string; "tagging"?: "mention" | "nobody"; "cwd": string; "model"?: string; "thinking"?: string; "memoryModel"?: string; "memoryThinking"?: string; "avatar"?: BotAvatar; "voice"?: BotVoice; "hidden"?: boolean; "archived"?: boolean; "disabledTools"?: Array<string>; "disabledSkills"?: Array<BotSkillRef>; "sessionId": string; "createdAt": string; "updatedAt": string; "worker"?: { "id": string; "name": string; }; "status": BotSessionStatus; "soul": boolean; "lastMessage"?: BotLastMessage; "unread": boolean; "memory"?: BotMemoryStatus; "routines": number; };

export type BotVoice = { "language"?: VoiceLanguage; "live"?: GptLiveVoice; };

export type BotVoicePatch = { "language"?: (VoiceLanguage) | (""); "live"?: (GptLiveVoice) | (""); };

export type BotsResponse = { "bots": Array<BotView>; };

export type BotsStreamFrame = { "event": "bots"; "data": BotsUpdate; };

export type BotsUpdate = { "revision": number; "ids"?: Array<string>; "upserts": Array<BotView>; };

export type GptLiveVoice = "cove" | "arbor" | "breeze" | "ember" | "juniper" | "maple" | "sol" | "spruce" | "vale";

export type VoiceLanguage = "en" | "zh" | "de" | "es" | "ru" | "ko" | "fr" | "ja" | "pt" | "tr" | "pl" | "ca" | "nl" | "ar" | "sv" | "it" | "id" | "hi" | "fi" | "vi" | "he" | "uk" | "el" | "ms" | "cs" | "ro" | "da" | "hu" | "ta" | "no" | "th" | "ur" | "hr" | "bg" | "lt" | "la" | "mi" | "ml" | "cy" | "sk" | "te" | "fa" | "lv" | "bn" | "sr" | "az" | "sl" | "kn" | "et" | "mk" | "br" | "eu" | "is" | "hy" | "ne" | "mn" | "bs" | "kk" | "sq" | "sw" | "gl" | "mr" | "pa" | "si" | "km" | "sn" | "yo" | "so" | "af" | "oc" | "ka" | "be" | "tg" | "sd" | "gu" | "am" | "yi" | "lo" | "uz" | "fo" | "ht" | "ps" | "tk" | "nn" | "mt" | "sa" | "lb" | "my" | "bo" | "tl" | "mg" | "as" | "tt" | "haw" | "ln" | "ha" | "ba" | "jw" | "su" | "yue";
