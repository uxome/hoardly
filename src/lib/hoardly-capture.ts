import {
  hoardlyCards,
  hoardlyMaintenanceIssues,
  hoardlyProjects,
  hoardlyTags,
} from "./hoardly-seed";
import { extractSocialMeta, isLoginWallRisk } from "./platform-adapters";
import { generateTags, cardToTaggerInput } from "./hoardly-tagger";
import type {
  HoardlyCard,
  HoardlyCardType,
  HoardlyMaintenanceIssue,
  HoardlyParseFailReason,
  HoardlyProject,
  HoardlyTag,
  LocalizedText,
} from "../types/hoardly";
import type { BookmarkMetadata } from "../types/bookmark";

export const HOARDLY_LIBRARY_STORAGE_KEY = "hoardly:web-library:v2";

export type HoardlyCaptureSource = "web" | "extension" | "manual" | "clipboard" | "import";

export type HoardlyCaptureInput = {
  includeThread?: boolean;
  /** Override parse fail reason (e.g. when extension detects a login wall) */
  parseFailReason?: HoardlyParseFailReason;
  projectIds?: string[];
  source: HoardlyCaptureSource;
  text?: string;
  title?: string;
  url?: string;
};

export type HoardlyLibraryState = {
  cards: HoardlyCard[];
  maintenanceIssues: HoardlyMaintenanceIssue[];
  projects: HoardlyProject[];
  tags: HoardlyTag[];
};

export type CaptureResult =
  | { card: HoardlyCard; library: HoardlyLibraryState; status: "created" }
  | { card: HoardlyCard; library: HoardlyLibraryState; status: "duplicate" }
  | { card: HoardlyCard; library: HoardlyLibraryState; status: "restored" };

export type BookmarkImportResult = {
  created: number;
  duplicates: number;
  failed: number;
  library: HoardlyLibraryState;
  restored: number;
  total: number;
};

export function createInitialHoardlyLibrary(): HoardlyLibraryState {
  return cloneLibrary({
    cards: hoardlyCards,
    maintenanceIssues: hoardlyMaintenanceIssues,
    projects: hoardlyProjects,
    tags: hoardlyTags,
  });
}

function migrateCard(card: HoardlyCard): HoardlyCard {
  const migrated = { ...card };
  if (!migrated.captureMode) {
    migrated.captureMode = migrated.url ? "bookmark" : "upload";
  }
  if (!Array.isArray(migrated.attachments)) {
    migrated.attachments = [];
  }
  return migrated;
}

export function loadHoardlyLibrary(): HoardlyLibraryState {
  if (typeof window === "undefined") return createInitialHoardlyLibrary();

  const raw = window.localStorage.getItem(HOARDLY_LIBRARY_STORAGE_KEY);
  if (!raw) return createInitialHoardlyLibrary();

  try {
    const parsed = JSON.parse(raw) as Partial<HoardlyLibraryState>;
    const cards = Array.isArray(parsed.cards) ? parsed.cards.map(migrateCard) : hoardlyCards;
    return {
      cards,
      maintenanceIssues: Array.isArray(parsed.maintenanceIssues)
        ? parsed.maintenanceIssues
        : hoardlyMaintenanceIssues,
      projects: Array.isArray(parsed.projects) ? parsed.projects : hoardlyProjects,
      tags: Array.isArray(parsed.tags) ? parsed.tags : hoardlyTags,
    };
  } catch {
    return createInitialHoardlyLibrary();
  }
}

export function saveHoardlyLibrary(library: HoardlyLibraryState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(HOARDLY_LIBRARY_STORAGE_KEY, JSON.stringify(library));
}

export function createCardFromCapture(input: HoardlyCaptureInput): HoardlyCard {
  const url = input.url?.trim();
  const text = input.text?.trim();
  const isUrl = Boolean(url && /^https?:\/\//i.test(url));
  const createdAt = new Date().toISOString();
  const type = inferCardType(url, text);
  const title = input.title?.trim() || (url ? getHostname(url) : text?.slice(0, 80)) || "Untitled";

  // Extract social metadata from URL
  const socialMeta = isUrl && url ? extractSocialMeta(url, type) : {};

  // If caller didn't supply a fail reason but the platform is a known login-wall
  // risk, we leave it undefined here (the real parse attempt will set it later).
  const parseFailReason = input.parseFailReason;

  const captureMode: HoardlyCard["captureMode"] = isUrl ? "bookmark" : "upload";

  return {
    id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    url: isUrl ? url : undefined,
    titleOriginal: title,
    titleI18n: {
      en: title,
      "zh-CN": title,
    },
    summary: createInitialSummary({ isUrl, text, url }),
    tagIds: inferInitialTagIds(type, input.source, url),
    sourcePlatform: inferSourcePlatform(url, input.source),
    authorHandle: socialMeta.authorHandle,
    subreddit: socialMeta.subreddit,
    parseFailReason,
    projectIds: input.projectIds ?? [],
    captureMode,
    contentMarkdown: isUrl ? undefined : text,
    attachments: [],
    parseStatus: isUrl ? "pending" : "ready",
    storageLocation: "cloud",
    starred: false,
    createdAt,
    highlights: [],
    noteMarkdown: isUrl ? undefined : text,
  };
}

/** Convenience: mark a card as failed with a specific reason */
export function markCardParseFailed(
  library: HoardlyLibraryState,
  cardId: string,
  reason: HoardlyParseFailReason,
): HoardlyLibraryState {
  return {
    ...library,
    cards: library.cards.map((card) =>
      card.id === cardId
        ? { ...card, parseStatus: "failed", parseFailReason: reason }
        : card,
    ),
  };
}

/** Convenience: tell whether the card's platform is a known login-wall risk */
export function cardHasLoginWallRisk(card: { type: HoardlyCardType }): boolean {
  return isLoginWallRisk(card.type);
}

export function upsertCapturedCard(
  library: HoardlyLibraryState,
  input: HoardlyCaptureInput,
): CaptureResult {
  const url = input.url?.trim();
  const normalizedUrl = url ? normalizeUrlForDedup(url) : "";
  const existingCard = normalizedUrl
    ? library.cards.find((card) => card.url && normalizeUrlForDedup(card.url) === normalizedUrl)
    : undefined;

  if (existingCard) {
    const restoredCard = existingCard.deletedAt
      ? { ...existingCard, deletedAt: undefined }
      : existingCard;
    const libraryWithExisting = {
      ...library,
      cards: library.cards.map((card) =>
        card.id === restoredCard.id ? mergeCaptureContext(restoredCard, input) : card,
      ),
      projects: applyProjectMemberships(library.projects, restoredCard.id, input.projectIds ?? []),
    };
    return {
      card: mergeCaptureContext(restoredCard, input),
      library: libraryWithExisting,
      status: existingCard.deletedAt ? "restored" : "duplicate",
    };
  }

  const card = createCardFromCapture(input);
  const nextLibrary = {
    ...library,
    cards: [card, ...library.cards],
    projects: applyProjectMemberships(library.projects, card.id, card.projectIds),
  };
  return {
    card,
    library: nextLibrary,
    status: "created",
  };
}

export function updateProjectMembership(
  library: HoardlyLibraryState,
  cardId: string,
  projectId: string,
  selected: boolean,
): HoardlyLibraryState {
  return {
    ...library,
    cards: library.cards.map((card) => {
      if (card.id !== cardId) return card;
      const projectIds = selected
        ? Array.from(new Set([...card.projectIds, projectId]))
        : card.projectIds.filter((id) => id !== projectId);
      return { ...card, projectIds };
    }),
    projects: library.projects.map((project) => {
      if (project.id !== projectId) return project;
      const cardIds = selected
        ? Array.from(new Set([...project.cardIds, cardId]))
        : project.cardIds.filter((id) => id !== cardId);
      return { ...project, cardIds };
    }),
  };
}

export function importBookmarksToLibrary(
  library: HoardlyLibraryState,
  bookmarks: BookmarkMetadata[],
): BookmarkImportResult {
  let nextLibrary = library;
  let created = 0;
  let duplicates = 0;
  let failed = 0;
  let restored = 0;
  const importIssues: HoardlyMaintenanceIssue[] = [];

  for (const bookmark of bookmarks) {
    if (!/^https?:\/\//i.test(bookmark.url)) {
      failed += 1;
      importIssues.push(createImportIssue(bookmark, "非 http(s) 链接，已跳过。"));
      continue;
    }

    try {
      const result = upsertCapturedCard(nextLibrary, {
        source: "import",
        title: bookmark.title,
        url: bookmark.url,
      });
      const importedCard = enrichImportedCard(result.card, bookmark);
      nextLibrary = {
        ...result.library,
        cards: result.library.cards.map((card) =>
          card.id === importedCard.id ? importedCard : card,
        ),
      };

      if (result.status === "created") created += 1;
      if (result.status === "duplicate") duplicates += 1;
      if (result.status === "restored") restored += 1;
    } catch (error) {
      failed += 1;
      importIssues.push(
        createImportIssue(
          bookmark,
          error instanceof Error ? error.message : "导入失败。",
        ),
      );
    }
  }

  if (importIssues.length > 0) {
    nextLibrary = {
      ...nextLibrary,
      maintenanceIssues: [...importIssues, ...nextLibrary.maintenanceIssues],
    };
  }

  return {
    created,
    duplicates,
    failed,
    library: nextLibrary,
    restored,
    total: bookmarks.length,
  };
}

export type ImportFileFormat = "html" | "csv" | "json" | "markdown";

export interface ParsedImportEntry {
  title: string;
  url: string;
}

export function detectImportFormat(file: File): ImportFileFormat | null {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv") return "csv";
  if (ext === "json") return "json";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (file.type === "text/html") return "html";
  if (file.type === "text/csv") return "csv";
  if (file.type === "application/json") return "json";
  return null;
}

export async function parseImportFile(file: File): Promise<ParsedImportEntry[]> {
  const format = detectImportFormat(file);
  if (!format) throw new Error(`不支持的文件格式：${file.name}`);

  const text = await file.text();

  switch (format) {
    case "html":
      return parseHtmlBookmarks(text);
    case "csv":
      return parseCsvBookmarks(text);
    case "json":
      return parseJsonBookmarks(text);
    case "markdown":
      return parseMarkdownBookmarks(text);
  }
}

function parseHtmlBookmarks(html: string): ParsedImportEntry[] {
  const entries: ParsedImportEntry[] = [];
  const regex = /<a\s[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const url = match[1].trim();
    const title = match[2].trim() || url;
    if (/^https?:\/\//i.test(url)) {
      entries.push({ title, url });
    }
  }
  return entries;
}

function parseCsvBookmarks(csv: string): ParsedImportEntry[] {
  const entries: ParsedImportEntry[] = [];
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const firstLine = lines[0]?.toLowerCase() ?? "";
  const hasHeader = firstLine.includes("url") || firstLine.includes("title") || firstLine.includes("link");
  const startIdx = hasHeader ? 1 : 0;

  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const urlCol = cols.find((c) => /^https?:\/\//i.test(c));
    if (urlCol) {
      const title = cols.find((c) => c !== urlCol && c.length > 0) ?? getHostname(urlCol);
      entries.push({ title, url: urlCol });
    }
  }
  return entries;
}

function parseJsonBookmarks(json: string): ParsedImportEntry[] {
  const entries: ParsedImportEntry[] = [];
  const data = JSON.parse(json);
  const items: unknown[] = Array.isArray(data) ? data : data.bookmarks ?? data.items ?? data.links ?? [];
  for (const item of items) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const url = (obj.url ?? obj.link ?? obj.href ?? "") as string;
      const title = (obj.title ?? obj.name ?? obj.description ?? "") as string;
      if (/^https?:\/\//i.test(url)) {
        entries.push({ title: title || getHostname(url), url });
      }
    }
  }
  return entries;
}

function parseMarkdownBookmarks(md: string): ParsedImportEntry[] {
  const entries: ParsedImportEntry[] = [];
  const linkRegex = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(md)) !== null) {
    entries.push({ title: match[1].trim() || match[2], url: match[2].trim() });
  }
  const bareUrlRegex = /(?:^|\s)(https?:\/\/\S+)/gm;
  while ((match = bareUrlRegex.exec(md)) !== null) {
    const url = match[1].trim();
    if (!entries.some((e) => e.url === url)) {
      entries.push({ title: getHostname(url), url });
    }
  }
  return entries;
}

/**
 * 覆盖式导入：用解析出的书签完全替换现有卡片库。
 * 保留 projects、tags、maintenanceIssues 结构，仅替换 cards。
 */
export function replaceLibraryWithImport(
  library: HoardlyLibraryState,
  entries: ParsedImportEntry[],
): BookmarkImportResult {
  let created = 0;
  let failed = 0;
  const cards: HoardlyCard[] = [];
  const importIssues: HoardlyMaintenanceIssue[] = [];

  for (const entry of entries) {
    try {
      const card = createCardFromCapture({
        source: "import",
        title: entry.title,
        url: entry.url,
      });
      cards.push(card);
      created += 1;
    } catch (error) {
      failed += 1;
      importIssues.push({
        description: error instanceof Error ? error.message : "解析失败",
        id: `issue-import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        severity: "medium",
        title: `导入失败：${entry.title || entry.url}`,
        type: "import_failed",
      });
    }
  }

  return {
    created,
    duplicates: 0,
    failed,
    library: {
      ...library,
      cards,
      maintenanceIssues: [...importIssues, ...library.maintenanceIssues],
    },
    restored: 0,
    total: entries.length,
  };
}

export function normalizeUrlForDedup(url: string) {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    return parsed.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function getHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function slugify(value: string) {
  const ascii = value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `project-${Date.now()}`;
}

function enrichImportedCard(card: HoardlyCard, bookmark: BookmarkMetadata): HoardlyCard {
  const importedSummary = bookmark.description?.trim();
  return {
    ...card,
    parseStatus: bookmark.status === "invalid" ? "invalid" : bookmark.status === "active" ? "ready" : card.parseStatus,
    sourcePlatform: bookmark.sourcePlatform || getHostname(bookmark.url),
    summary: importedSummary
      ? {
          ...card.summary,
          en: importedSummary,
          "zh-CN": importedSummary,
        }
      : card.summary,
    thumbnailUrl: bookmark.thumbnailUrl ?? card.thumbnailUrl,
  };
}

function createImportIssue(bookmark: BookmarkMetadata, reason: string): HoardlyMaintenanceIssue {
  return {
    id: `issue-import-${bookmark.bookmarkId}-${Date.now()}`,
    type: "import_failed",
    title: `导入失败：${bookmark.title || bookmark.url}`,
    description: `${reason} · ${bookmark.url}`,
    severity: "medium",
  };
}

function applyProjectMemberships(
  projects: HoardlyProject[],
  cardId: string,
  projectIds: string[],
) {
  if (projectIds.length === 0) return projects;
  return projects.map((project) => {
    if (!projectIds.includes(project.id)) return project;
    return {
      ...project,
      cardIds: Array.from(new Set([cardId, ...project.cardIds])),
    };
  });
}

function mergeCaptureContext(card: HoardlyCard, input: HoardlyCaptureInput): HoardlyCard {
  return {
    ...card,
    deletedAt: undefined,
    projectIds: Array.from(new Set([...card.projectIds, ...(input.projectIds ?? [])])),
  };
}

function inferCardType(url?: string, text?: string): HoardlyCardType {
  if (!url || !/^https?:\/\//i.test(url)) return text ? "note" : "web";

  const hostname = getHostname(url).toLowerCase();
  if (hostname.includes("reddit.com") || hostname === "redd.it") return "reddit";
  if (hostname.includes("x.com") || hostname.includes("twitter.com")) return "tweet";
  if (hostname.includes("instagram.com")) return "instagram";
  if (hostname.includes("facebook.com") || hostname.includes("fb.watch")) return "facebook";
  if (hostname.includes("threads.net")) return "threads";
  if (hostname.includes("linkedin.com")) return "linkedin";
  if (hostname.includes("xiaohongshu.com") || hostname.includes("xhslink.com")) return "xhs";
  if (hostname.includes("douyin.com")) return "douyin";
  if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "youtube";
  if (hostname.includes("tiktok.com")) return "tiktok";
  if (hostname.includes("bilibili.com")) return "bilibili";
  if (hostname.includes("medium.com") || hostname.includes("substack.com")) return "medium";
  if (hostname.includes("pinterest.com") || hostname === "pin.it") return "pinterest";
  if (hostname.includes("mp.weixin.qq.com")) return "wechat";
  return "web";
}

function inferSourcePlatform(url: string | undefined, source: HoardlyCaptureSource) {
  if (!url || !/^https?:\/\//i.test(url)) return source === "extension" ? "extension" : "manual";
  return getHostname(url);
}

function inferInitialTagIds(type: HoardlyCardType, source: HoardlyCaptureSource, url?: string) {
  if (type === "note") return ["tag-project-hoardly"];

  const tags: string[] = [];

  if (url) {
    const host = getHostname(url).toLowerCase().replace(/^www\./, "");
    const domainTag = `tag-domain-${slugify(host)}`;
    tags.push(domainTag);
  }

  if (type === "youtube" || type === "bilibili" || type === "video") {
    tags.push("tag-video-summary");
  } else if (type === "xhs" || type === "douyin" || type === "wechat") {
    tags.push("tag-chinese-platforms", "tag-product-research");
  } else if (type === "reddit" || type === "tweet" || type === "instagram" || type === "facebook") {
    tags.push("tag-product-research");
  } else {
    tags.push("tag-product-research");
  }

  return tags;
}

function createInitialSummary({
  isUrl,
  text,
  url,
}: {
  isUrl: boolean;
  text?: string;
  url?: string;
}): LocalizedText {
  if (!isUrl) {
    return {
      en: "Manual note created locally. AI summary will be generated later.",
      "zh-CN": "已创建本地手动笔记，后续接入 AI 摘要。",
    };
  }

  return {
    en: `Pending parser and AI tagging for ${url ? getHostname(url) : "this URL"}.`,
    "zh-CN": "等待解析与 AI 打标。现在已经可以加入项目、星标或添加笔记。",
  };
}

/**
 * Run the multi-dimension AI tagger on a card and merge results into the library.
 * This is async and should be called after the card is already created.
 * Returns the updated library state with new tags and updated card tagIds.
 */
export async function runAiTagger(
  library: HoardlyLibraryState,
  cardId: string,
): Promise<HoardlyLibraryState> {
  const card = library.cards.find((c) => c.id === cardId);
  if (!card) return library;

  const input = cardToTaggerInput(card);
  const result = await generateTags(input, library.tags, library.cards);

  const mergedTags = [...library.tags];
  for (const newTag of result.newTags) {
    if (!mergedTags.some((t) => t.id === newTag.id)) {
      mergedTags.push(newTag);
    }
  }

  const allTagIds = Array.from(new Set([...card.tagIds, ...result.tagIds]));

  return {
    ...library,
    tags: mergedTags,
    cards: library.cards.map((c) =>
      c.id === cardId
        ? { ...c, tagIds: allTagIds, parseStatus: "ready" as const }
        : c,
    ),
  };
}

function cloneLibrary(library: HoardlyLibraryState): HoardlyLibraryState {
  return JSON.parse(JSON.stringify(library)) as HoardlyLibraryState;
}
