import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Database,
  FolderPlus,
  FileText,
  FileUp,
  FolderKanban,
  Globe2,
  Grid2X2,
  Image,
  Inbox,
  Languages,
  Link2,
  List,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  Tags,
  Trash2,
  Upload,
  Video,
  Wrench,
  X,
} from "lucide-react";
import "../../src/styles/globals.css";
import { Avatar, AvatarFallback, AvatarImage } from "../../src/components/ui/avatar";
import { Button } from "../../src/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../src/components/ui/card";
import { Input } from "../../src/components/ui/input";
import { Separator } from "../../src/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "../../src/components/ui/tabs";
import { Textarea } from "../../src/components/ui/textarea";
import {
  defaultHoardlyLocale,
} from "../../src/lib/hoardly-seed";
import { generateLocalTags, cardToTaggerInput } from "../../src/lib/hoardly-tagger";
import {
  detectImportFormat,
  getHostname,
  importBookmarksToLibrary,
  loadHoardlyLibrary,
  parseImportFile,
  replaceLibraryWithImport,
  runAiTagger,
  saveHoardlyLibrary,
  slugify,
  updateProjectMembership,
  upsertCapturedCard,
} from "../../src/lib/hoardly-capture";
import {
  getPlatformColor,
  PARSE_FAIL_HINTS,
  PARSE_FAIL_LABELS,
  socialMetaLine,
} from "../../src/lib/platform-adapters";
import type { BookmarkMetadata } from "../../src/types/bookmark";
import type {
  HoardlyCard,
  HoardlyCardType,
  HoardlyLocale,
  HoardlyMaintenanceIssue,
  HoardlyProject,
  HoardlySortMode,
  HoardlyTag,
  HoardlyTagDimension,
  HoardlyViewMode,
} from "../../src/types/hoardly";
import { TAG_DIMENSION_LABELS, TAG_DIMENSION_PRIORITY } from "../../src/types/hoardly";
import { SiteBookmarkThumbnail } from "../../src/components/site-bookmark-thumbnail";

type AppSection = "all" | "projects" | "tags" | "ai" | "maintenance" | "trash" | "settings";
type NoticeState = {
  actionLabel?: string;
  message: string;
  onAction?: () => void;
};
type ImportStatus = {
  message: string;
  state: "idle" | "importing" | "done" | "error";
};
type AiCitation = {
  card: HoardlyCard;
  matchedFields: string[];
  score: number;
  snippet: string;
};
type SelectionPointerEvent = Pick<
  React.MouseEvent,
  "ctrlKey" | "metaKey" | "shiftKey"
>;
type DissolveSnapshot = {
  cards: HoardlyCard[];
  projects: HoardlyProject[];
};

const navItems: Array<{ id: AppSection; label: string; icon: typeof Inbox }> = [
  { id: "all", label: "全部流", icon: Inbox },
  { id: "projects", label: "进行中项目", icon: FolderKanban },
  { id: "tags", label: "标签云", icon: Tags },
  { id: "ai", label: "AI 搜索", icon: Bot },
  { id: "maintenance", label: "维护中心", icon: Wrench },
  { id: "trash", label: "回收站", icon: Trash2 },
  { id: "settings", label: "设置", icon: Settings },
];

const cardTypeLabels: Record<HoardlyCardType, string> = {
  web: "网页",
  tweet: "X",
  reddit: "Reddit",
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  linkedin: "LinkedIn",
  xhs: "小红书",
  douyin: "抖音",
  youtube: "YouTube",
  tiktok: "TikTok",
  bilibili: "B站",
  medium: "Medium",
  pinterest: "Pinterest",
  wechat: "公众号",
  video: "视频",
  image: "图片",
  note: "笔记",
  pdf: "PDF",
  doc: "文档",
  voice_note: "语音",
};

function hasChromeExtensionRuntime() {
  const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
  return Boolean(runtime?.id && runtime?.sendMessage);
}

const demoChromeBookmarks: BookmarkMetadata[] = [
  {
    bookmarkId: "demo-chrome-bookmark-1",
    confidence: 0.72,
    description: "示例导入：Hoardly 会把 Chrome 书签转成独立卡片，并按 URL 去重。",
    folderSuggestion: "Product Research",
    status: "active",
    tags: ["product", "research", "import"],
    title: "Hoardly import sample",
    url: "https://example.com/hoardly-import-sample",
  },
  {
    bookmarkId: "demo-chrome-bookmark-2",
    confidence: 0.66,
    description: "示例导入：导入后默认进入全部流，不创建永久文件夹或项目。",
    folderSuggestion: "Reading",
    status: "pending_review",
    tags: ["reading", "queue"],
    title: "Zero-organization collecting",
    url: "https://example.com/zero-organization-collecting",
  },
];

function HoardlyWebApp() {
  const [library, setLibrary] = useState(() => loadHoardlyLibrary());
  const [activeSection, setActiveSection] = useState<AppSection>("all");
  const { cards, maintenanceIssues, projects, tags } = library;
  const [locale, setLocale] = useState<HoardlyLocale>(defaultHoardlyLocale);
  const [sortMode, setSortMode] = useState<HoardlySortMode>(() =>
    readStoredSortMode(),
  );
  const [viewMode, setViewMode] = useState<HoardlyViewMode>("grid");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedType, setSelectedType] = useState<HoardlyCardType | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [newCardValue, setNewCardValue] = useState("");
  const [drawerCardId, setDrawerCardId] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDescription, setNewProjectDescription] = useState("");
  const [newProjectColor, setNewProjectColor] = useState("#6366f1");
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [lastSelectedCardId, setLastSelectedCardId] = useState<string | null>(null);
  const [batchProjectId, setBatchProjectId] = useState("");
  const [batchTagId, setBatchTagId] = useState("");
  const [importStatus, setImportStatus] = useState<ImportStatus>({
    message: "尚未导入 Chrome 书签。",
    state: "idle",
  });
  const dissolveTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [mcpEnabled, setMcpEnabled] = useState(() => {
    return window.localStorage.getItem("hoardly:mcp-enabled") === "true";
  });

  useEffect(() => {
    window.localStorage.setItem("hoardly:sort-mode", sortMode);
  }, [sortMode]);

  useEffect(() => {
    saveHoardlyLibrary(library);
  }, [library]);

  // Startup: re-enrich cards that are stuck in pending, have numeric titles, or empty tags
  const startupEnrichRanRef = useRef(false);
  useEffect(() => {
    if (startupEnrichRanRef.current) return;
    startupEnrichRanRef.current = true;

    const brokenCards = library.cards.filter((card) => {
      if (card.deletedAt || !card.url) return false;
      const isPending = card.parseStatus === "pending";
      const isNumericTitle = /^\d+$/.test(card.titleOriginal);
      const hasNoTags = card.tagIds.length === 0;
      const hasOnlyDomainTag = card.tagIds.length <= 2 && card.tagIds.every((id) => id.startsWith("tag-domain-") || id === "tag-product-research");
      return isPending || isNumericTitle || hasNoTags || hasOnlyDomainTag;
    });

    if (brokenCards.length === 0) return;

    const enrichSequentially = async () => {
      for (const card of brokenCards) {
        if (card.url) {
          await fetchAndEnrichCard(card.id, card.url);
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    };
    void enrichSequentially();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MCP sync: push library snapshot to local dev server whenever it changes
  useEffect(() => {
    if (!mcpEnabled) return;
    window.localStorage.setItem("hoardly:mcp-enabled", "true");
    fetch("/api/mcp/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(library),
    }).catch(() => {});
  }, [library, mcpEnabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActiveSection("ai");
        searchInputRef.current?.focus();
        return;
      }
      // `/` → focus main search bar
      if (event.key === "/" && !inInput && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setActiveSection("all");
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    return () => {
      if (dissolveTimerRef.current !== null) window.clearTimeout(dissolveTimerRef.current);
    };
  }, []);

  const visibleCards = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    const filtered = cards.filter((card) => {
      if (card.deletedAt) return false;
      if (selectedProjectId && !card.projectIds.includes(selectedProjectId)) return false;
      if (selectedTagIds.length > 0 && !selectedTagIds.every((tid) => card.tagIds.includes(tid))) return false;
      if (selectedType !== "all" && card.type !== selectedType) return false;
      if (!normalizedQuery) return true;

      const haystack = [
        localized(card.titleI18n, locale, card.titleOriginal),
        card.titleOriginal,
        localized(card.summary, locale),
        card.sourcePlatform,
        card.authorName,
        ...card.tagIds.map((tagId) => localized(findTag(tags, tagId)?.labels, locale)),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });

    return sortCards(filtered, sortMode);
  }, [cards, locale, searchQuery, selectedProjectId, selectedTagIds, selectedType, sortMode, tags]);

  const activeProjects = projects.filter((project) => project.status === "active");
  const visibleCardIds = useMemo(() => visibleCards.map((card) => card.id), [visibleCards]);
  const selectedCardSet = useMemo(() => new Set(selectedCardIds), [selectedCardIds]);
  const drawerCard = drawerCardId ? cards.find((card) => card.id === drawerCardId) : null;
  const activeCards = cards.filter((card) => !card.deletedAt);
  const trashedCards = cards.filter((card) => card.deletedAt);
  const readyCount = activeCards.filter((card) => card.parseStatus === "ready").length;
  const pendingCount = activeCards.filter((card) => card.parseStatus === "pending").length;
  const activeFilterCount = [selectedProjectId, selectedTagIds.length > 0 ? "tags" : null, selectedType !== "all" ? selectedType : null].filter(
    Boolean,
  ).length;

  useEffect(() => {
    if (activeSection !== "all") {
      if (selectedCardIds.length > 0) setSelectedCardIds([]);
      setLastSelectedCardId(null);
      return;
    }

    setSelectedCardIds((current) => {
      const next = current.filter((cardId) => visibleCardIds.includes(cardId));
      if (next.length === current.length) return current;
      if (next.length === 0) setLastSelectedCardId(null);
      return next;
    });
  }, [activeSection, selectedCardIds.length, visibleCardIds]);

  const createCard = () => {
    let value = newCardValue.trim();
    if (!value) return;

    const looksLikeUrl = /^https?:\/\//i.test(value)
      || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z]{2,})+(\/.*)?\s*$/i.test(value);

    if (looksLikeUrl && !/^https?:\/\//i.test(value)) {
      value = `https://${value}`;
    }

    const isUrl = /^https?:\/\//i.test(value);
    const result = upsertCapturedCard(library, {
      projectIds: selectedProjectId ? [selectedProjectId] : [],
      source: "web",
      text: isUrl ? undefined : value,
      title: isUrl ? getHostname(value) : value.slice(0, 80),
      url: isUrl ? value : undefined,
    });

    if (result.status !== "created") {
      setLibrary(result.library);
      setDrawerCardId(result.card.id);
      setNewCardValue("");
      setNotice({
        message: result.status === "duplicate"
          ? "该链接已在库中，已打开已有卡片。"
          : "该链接已在回收站，已恢复已有卡片。",
      });
      return;
    }

    setLibrary(result.library);
    setDrawerCardId(result.card.id);
    setNewCardValue("");

    if (isUrl) {
      setNotice({ message: "正在解析网页…" });
      void fetchAndEnrichCard(result.card.id, value);
    } else {
      setNotice({ message: "已创建笔记卡片。" });
    }
  };

  const fetchAndEnrichCard = async (cardId: string, url: string) => {
    type MicrolinkData = {
      title?: string;
      description?: string;
      image?: { url?: string } | null;
      logo?: { url?: string } | null;
    };

    let meta: MicrolinkData | null = null;

    try {
      const apiUrl = `https://api.microlink.io/?url=${encodeURIComponent(url)}&meta=true`;
      const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const json = await resp.json() as { status: string; data?: MicrolinkData };
        if (json.status === "success" && json.data) {
          meta = json.data;
        }
      }
    } catch { /* timeout or network error */ }

    setLibrary((prev) => {
      const card = prev.cards.find((c) => c.id === cardId);
      if (!card) return prev;

      const title = meta?.title || card.titleOriginal;
      const description = meta?.description;
      const ogImage = meta?.image?.url || meta?.logo?.url;

      const enrichedInput = cardToTaggerInput({
        ...card,
        titleOriginal: title,
        summary: description ? { en: description, "zh-CN": description } : card.summary,
      });
      const tagResult = generateLocalTags(enrichedInput, prev.tags);

      const mergedTags = [...prev.tags];
      for (const t of tagResult.newTags) {
        if (!mergedTags.some((et) => et.id === t.id)) mergedTags.push(t);
      }
      const allTagIds = Array.from(new Set([...card.tagIds, ...tagResult.tagIds]));

      return {
        ...prev,
        tags: mergedTags,
        cards: prev.cards.map((c) =>
          c.id === cardId
            ? {
                ...c,
                titleOriginal: title,
                titleI18n: { en: title, "zh-CN": title },
                summary: description
                  ? { en: description, "zh-CN": description }
                  : c.summary,
                thumbnailUrl: ogImage || c.thumbnailUrl,
                tagIds: allTagIds,
                parseStatus: "ready" as const,
              }
            : c,
        ),
      };
    });

    setNotice({ message: meta?.title ? `已解析：${meta.title}` : "解析完成。" });
  };

  const createProject = () => {
    const name = newProjectName.trim();
    if (!name) {
      setNotice({ message: "项目名不能为空。" });
      return;
    }
    const slug = slugify(name);
    if (projects.some((project) => project.slug === slug && project.status === "active")) {
      setNotice({ message: "已有同名进行中项目。" });
      return;
    }
    const project: HoardlyProject = {
      id: `project-${Date.now()}`,
      name,
      slug,
      color: newProjectColor,
      status: "active",
      description: newProjectDescription.trim() || undefined,
      cardIds: [],
    };
    setLibrary((current) => ({
      ...current,
      projects: [project, ...current.projects],
    }));
    setNewProjectName("");
    setNewProjectDescription("");
    setNewProjectColor("#6366f1");
    setSelectedProjectId(project.id);
    setActiveSection("all");
    setNotice({ message: `项目「${project.name}」已创建。` });
  };

  const updateCard = (cardId: string, patch: Partial<HoardlyCard>) => {
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card)),
    }));
  };

  const toggleStar = (cardId: string) => {
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        card.id === cardId ? { ...card, starred: !card.starred } : card,
      ),
    }));
  };

  const softDeleteCard = (cardId: string) => {
    const deletedAt = new Date().toISOString();
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) => (card.id === cardId ? { ...card, deletedAt } : card)),
    }));
    setDrawerCardId(null);
    setNotice({ message: "卡片已移入回收站，30 天后可永久删除。" });
  };

  const restoreCard = (cardId: string) => {
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        card.id === cardId ? { ...card, deletedAt: undefined } : card,
      ),
    }));
    setNotice({ message: "卡片已恢复。" });
  };

  const permanentlyDeleteCard = (cardId: string) => {
    setLibrary((current) => ({
      ...current,
      cards: current.cards.filter((card) => card.id !== cardId),
      projects: current.projects.map((project) => ({
        ...project,
        cardIds: project.cardIds.filter((id) => id !== cardId),
      })),
    }));
    setDrawerCardId(null);
    setNotice({ message: "卡片已永久删除。" });
  };

  const retryParseCard = (cardId: string) => {
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        card.id === cardId
          ? {
              ...card,
              parseStatus: "pending",
              summary: {
                ...card.summary,
                "zh-CN": "正在重新解析。当前为前端占位，后续会调用 PlatformAdapter 与 AI 打标。",
                en: "Retrying parser. This is a front-end placeholder before PlatformAdapter and AI workers are connected.",
              },
            }
          : card,
      ),
    }));
    setNotice({ message: "已加入重新解析队列。" });
  };

  const setCardProjectMembership = (cardId: string, projectId: string, selected: boolean) => {
    setLibrary((current) => updateProjectMembership(current, cardId, projectId, selected));
  };

  const selectCard = (cardId: string, event: SelectionPointerEvent) => {
    setSelectedCardIds((current) => {
      if (event.shiftKey && lastSelectedCardId) {
        const from = visibleCardIds.indexOf(lastSelectedCardId);
        const to = visibleCardIds.indexOf(cardId);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          return Array.from(new Set([...current, ...visibleCardIds.slice(start, end + 1)]));
        }
      }

      if (current.includes(cardId)) return current.filter((id) => id !== cardId);
      return [...current, cardId];
    });
    setLastSelectedCardId(cardId);
  };

  const selectAllVisibleCards = () => {
    setSelectedCardIds(visibleCardIds);
    setLastSelectedCardId(visibleCardIds.at(-1) ?? null);
  };

  const clearCardSelection = () => {
    setSelectedCardIds([]);
    setLastSelectedCardId(null);
  };

  const addBatchTag = () => {
    if (!batchTagId) {
      setNotice({ message: "请先选择要批量添加的标签。" });
      return;
    }
    const selectedIds = new Set(selectedCardIds);
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        selectedIds.has(card.id)
          ? { ...card, tagIds: Array.from(new Set([...card.tagIds, batchTagId])) }
          : card,
      ),
    }));
    setNotice({ message: `已为 ${selectedCardIds.length} 张卡片添加标签。` });
  };

  const removeBatchTag = () => {
    if (!batchTagId) {
      setNotice({ message: "请先选择要批量移除的标签。" });
      return;
    }
    const selectedIds = new Set(selectedCardIds);
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        selectedIds.has(card.id)
          ? { ...card, tagIds: card.tagIds.filter((tagId) => tagId !== batchTagId) }
          : card,
      ),
    }));
    setNotice({ message: `已从 ${selectedCardIds.length} 张卡片移除标签。` });
  };

  const setBatchProjectMembership = (selected: boolean) => {
    if (!batchProjectId) {
      setNotice({ message: "请先选择目标项目。" });
      return;
    }
    const selectedIds = new Set(selectedCardIds);
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) => {
        if (!selectedIds.has(card.id)) return card;
        return {
          ...card,
          projectIds: selected
            ? Array.from(new Set([...card.projectIds, batchProjectId]))
            : card.projectIds.filter((projectId) => projectId !== batchProjectId),
        };
      }),
      projects: current.projects.map((project) => {
        if (project.id !== batchProjectId) return project;
        return {
          ...project,
          cardIds: selected
            ? Array.from(new Set([...selectedCardIds, ...project.cardIds]))
            : project.cardIds.filter((cardId) => !selectedIds.has(cardId)),
        };
      }),
    }));
    setNotice({
      message: selected
        ? `已将 ${selectedCardIds.length} 张卡片加入项目。`
        : `已将 ${selectedCardIds.length} 张卡片移出项目。`,
    });
  };

  const setBatchStarred = (starred: boolean) => {
    const selectedIds = new Set(selectedCardIds);
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        selectedIds.has(card.id) ? { ...card, starred } : card,
      ),
    }));
    setNotice({ message: starred ? "已批量标星。" : "已批量取消星标。" });
  };

  const softDeleteSelectedCards = () => {
    const selectedIds = new Set(selectedCardIds);
    const deletedAt = new Date().toISOString();
    setLibrary((current) => ({
      ...current,
      cards: current.cards.map((card) =>
        selectedIds.has(card.id) ? { ...card, deletedAt } : card,
      ),
    }));
    setNotice({ message: `已将 ${selectedCardIds.length} 张卡片移入回收站。` });
    clearCardSelection();
  };

  const exportSelectedSkill = () => {
    setNotice({
      message: `已创建 ${selectedCardIds.length} 张卡片的 Skill 导出任务占位，后续接入 Markdown/Skill 生成。`,
    });
  };

  const importFileInputRef = useRef<HTMLInputElement>(null);

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (importFileInputRef.current) importFileInputRef.current.value = "";

    const format = detectImportFormat(file);
    if (!format) {
      setImportStatus({ message: `不支持的文件格式：${file.name}。请上传 HTML、CSV、JSON 或 Markdown 文件。`, state: "error" });
      setNotice({ message: `不支持的文件格式：${file.name}` });
      return;
    }

    const currentCount = library.cards.filter((c) => !c.deletedAt).length;
    const confirmed = window.confirm(
      `⚠️ 导入将完全覆盖当前收藏库\n\n` +
      `当前库中有 ${currentCount} 张卡片，导入后将被全部替换为文件中的书签。\n` +
      `此操作不可撤销。\n\n` +
      `确定要继续吗？`,
    );
    if (!confirmed) {
      setImportStatus({ message: "已取消导入。", state: "done" });
      return;
    }

    setImportStatus({ message: `正在解析 ${file.name}（${format.toUpperCase()} 格式）...`, state: "importing" });

    try {
      const entries = await parseImportFile(file);
      if (entries.length === 0) {
        setImportStatus({ message: "文件中没有找到可导入的书签链接。", state: "done" });
        setNotice({ message: "文件中没有找到可导入的书签链接。" });
        return;
      }

      const result = replaceLibraryWithImport(library, entries);
      setLibrary(result.library);
      setImportStatus({
        message: `完成：从 ${file.name} 导入 ${result.created} 条书签${result.failed > 0 ? `，${result.failed} 条失败` : ""}。原有 ${currentCount} 条已替换。`,
        state: result.failed > 0 ? "error" : "done",
      });
      setNotice({
        message: `已导入 ${result.created} 条书签，原有 ${currentCount} 条已替换。`,
      });
      setActiveSection("all");
      clearCardSelection();
    } catch (error) {
      const message = error instanceof Error ? error.message : "文件导入失败。";
      setImportStatus({ message, state: "error" });
      setNotice({ message });
    }
  };

  const importChromeBookmarks = async () => {
    const canReadChromeBookmarks = hasChromeExtensionRuntime();
    setImportStatus({
      message: canReadChromeBookmarks
        ? "正在读取 Chrome bookmarks API..."
        : "当前不是扩展环境，正在导入 H5 示例书签。",
      state: "importing",
    });

    try {
      const bookmarks = canReadChromeBookmarks
        ? await import("../../src/lib/bookmark-service").then((module) => module.listAppBookmarks())
        : demoChromeBookmarks;
      if (bookmarks.length === 0) {
        setImportStatus({ message: "没有找到可导入的 Chrome 书签。", state: "done" });
        setNotice({ message: "没有找到可导入的 Chrome 书签。" });
        return;
      }

      const currentCount = library.cards.filter((c) => !c.deletedAt).length;
      const confirmed = window.confirm(
        `⚠️ 导入将完全覆盖当前收藏库\n\n` +
        `当前库中有 ${currentCount} 张卡片，导入后将被全部替换为 Chrome 书签。\n` +
        `此操作不可撤销。\n\n` +
        `确定要继续吗？`,
      );
      if (!confirmed) {
        setImportStatus({ message: "已取消导入。", state: "done" });
        return;
      }

      const entries = bookmarks.map((b) => ({ title: b.title, url: b.url }));
      const result = replaceLibraryWithImport(library, entries);
      setLibrary(result.library);
      setImportStatus({
        message: `完成：导入 ${result.created} 条 Chrome 书签${result.failed > 0 ? `，${result.failed} 条失败` : ""}。原有 ${currentCount} 条已替换。`,
        state: result.failed > 0 ? "error" : "done",
      });
      setNotice({
        message: `已导入 ${result.created} 条 Chrome 书签，原有 ${currentCount} 条已替换。`,
      });
      setActiveSection("all");
      clearCardSelection();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Chrome 书签导入失败。";
      setImportStatus({ message, state: "error" });
      setNotice({ message });
    }
  };

  const clearFilters = () => {
    setSelectedProjectId(null);
    setSelectedTagIds([]);
    setSelectedType("all");
  };

  const toggleTagFilter = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    );
  };

  const dissolveProject = (project: HoardlyProject) => {
    const snapshot: DissolveSnapshot = {
      cards,
      projects,
    };
    const projectTagId = `tag-project-${project.slug}`;
    const projectTagExists = tags.some((tag) => tag.id === projectTagId);
    setLibrary((current) => ({
      ...current,
      projects: current.projects.map((item) =>
        item.id === project.id ? { ...item, status: "archived", cardIds: [] } : item,
      ),
      cards: current.cards.map((card) => {
        if (!card.projectIds.includes(project.id)) return card;
        return {
          ...card,
          projectIds: card.projectIds.filter((id) => id !== project.id),
          tagIds: projectTagExists || card.tagIds.includes("tag-project-hoardly")
            ? Array.from(new Set([...card.tagIds, "tag-project-hoardly"]))
            : card.tagIds,
        };
      }),
    }));
    setSelectedProjectId(null);
    if (dissolveTimerRef.current !== null) window.clearTimeout(dissolveTimerRef.current);
    const undo = () => {
      if (dissolveTimerRef.current !== null) window.clearTimeout(dissolveTimerRef.current);
      dissolveTimerRef.current = null;
      setLibrary((current) => ({
        ...current,
        cards: snapshot.cards,
        projects: snapshot.projects,
      }));
      setNotice({ message: `已撤销解散「${project.name}」。` });
    };
    setNotice({
      actionLabel: "撤销",
      message: `项目「${project.name}」已解散，10 秒内可撤销。`,
      onAction: undo,
    });
    dissolveTimerRef.current = window.setTimeout(() => {
      dissolveTimerRef.current = null;
      setNotice((current) => (current?.onAction === undo ? null : current));
    }, 10000);
  };

  const dismissIssue = (issueId: string) => {
    setLibrary((current) => ({
      ...current,
      maintenanceIssues: current.maintenanceIssues.filter((issue) => issue.id !== issueId),
    }));
  };

  return (
    <main className="dark flex min-h-screen bg-background text-foreground">
      <aside className="hidden w-64 shrink-0 border-r border-border bg-card/30 p-4 lg:block">
        <div className="mb-6 flex items-center gap-3">
          <img alt="Hoardly" className="size-10 rounded-xl" src="/hoardly-logo.png" />
          <div>
            <p className="text-base font-semibold">Hoardly</p>
            <p className="text-xs text-muted-foreground">个人知识资产库</p>
          </div>
        </div>

        <nav className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Button
                key={item.id}
                variant={activeSection === item.id ? "secondary" : "ghost"}
                className="w-full justify-start gap-2"
                onClick={() => setActiveSection(item.id)}
              >
                <Icon className="size-4" />
                {item.label}
              </Button>
            );
          })}
        </nav>

        <Separator className="my-5" />

        <div className="space-y-3">
          <SidebarLabel label="进行中项目" />
          {activeProjects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent ${
                selectedProjectId === project.id ? "bg-accent text-accent-foreground" : ""
              }`}
              onClick={() => {
                setActiveSection("all");
                setSelectedProjectId(project.id);
              }}
            >
              <span
                className="size-2.5 rounded-full"
                style={{ backgroundColor: project.color }}
              />
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="text-xs text-muted-foreground">{project.cardIds.length}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur md:px-6">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-semibold">{sectionTitle(activeSection)}</h1>
              <p className="text-sm text-muted-foreground">
                {cards.length} 张卡片 · {readyCount} 已完成 · {pendingCount} 分析中
              </p>
            </div>

            <div className="relative min-w-[260px] flex-1 md:max-w-md">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                className="h-10 pl-9"
                placeholder="/ 聚焦 · 搜索卡片 · Cmd+K 问 AI"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>

            <Avatar className="size-9">
              <AvatarImage src="/avril-avatar.png" />
              <AvatarFallback>H</AvatarFallback>
            </Avatar>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto lg:hidden">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Button
                  key={item.id}
                  size="sm"
                  variant={activeSection === item.id ? "secondary" : "ghost"}
                  className="gap-1.5"
                  onClick={() => setActiveSection(item.id)}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Button>
              );
            })}
          </div>
        </header>

        {notice ? (
          <div className="border-b border-border bg-accent px-4 py-2 text-sm md:px-6">
            <div className="flex items-center justify-between gap-3">
              <span>{notice.message}</span>
              <div className="flex items-center gap-2">
                {notice.onAction && notice.actionLabel ? (
                  <Button size="sm" variant="secondary" onClick={notice.onAction}>
                    {notice.actionLabel}
                  </Button>
                ) : null}
                <Button size="icon-sm" variant="ghost" aria-label="关闭提示" onClick={() => setNotice(null)}>
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          {activeSection === "all" ? (
            <AllCardsView
              activeFilterCount={activeFilterCount}
              cards={visibleCards}
              locale={locale}
              onClearFilters={clearFilters}
              onCreateCard={createCard}
              onOpenDrawer={setDrawerCardId}
              onRetryParse={retryParseCard}
              onSelectCard={selectCard}
              onSoftDelete={softDeleteCard}
              onToggleStar={toggleStar}
              newCardValue={newCardValue}
              projects={projects}
              selectedCardIds={selectedCardIds}
              selectedCardSet={selectedCardSet}
              selectedProjectId={selectedProjectId}
              selectedTagIds={selectedTagIds}
              selectedType={selectedType}
              searchQuery={searchQuery}
              setNewCardValue={setNewCardValue}
              setSearchQuery={setSearchQuery}
              setSelectedProjectId={setSelectedProjectId}
              setSelectedTagIds={setSelectedTagIds}
              setSelectedType={setSelectedType}
              setSortMode={setSortMode}
              setViewMode={setViewMode}
              sortMode={sortMode}
              tags={tags}
              viewMode={viewMode}
            />
          ) : null}

          {activeSection === "projects" ? (
            <ProjectsView
              cards={cards}
              locale={locale}
              newProjectColor={newProjectColor}
              newProjectDescription={newProjectDescription}
              newProjectName={newProjectName}
              onCreateProject={createProject}
              onDissolveProject={dissolveProject}
              onSelectProject={(projectId) => {
                setSelectedProjectId(projectId);
                setActiveSection("all");
              }}
              projects={activeProjects}
              setNewProjectColor={setNewProjectColor}
              setNewProjectDescription={setNewProjectDescription}
              setNewProjectName={setNewProjectName}
              tags={tags}
            />
          ) : null}

          {activeSection === "tags" ? (
            <TagsView
              cards={cards}
              locale={locale}
              selectedTagIds={selectedTagIds}
              onToggleTag={(tagId) => {
                toggleTagFilter(tagId);
                setActiveSection("all");
              }}
              tags={tags}
            />
          ) : null}

          {activeSection === "ai" ? (
            <AiSearchView
              cards={visibleCards}
              locale={locale}
              onOpenDrawer={setDrawerCardId}
              query={searchQuery}
              setQuery={setSearchQuery}
              tags={tags}
            />
          ) : null}

          {activeSection === "maintenance" ? (
            <MaintenanceView
              allCards={cards}
              issues={maintenanceIssues}
              onDismissIssue={dismissIssue}
              onEmptyTrash={() =>
                setLibrary((lib) => ({
                  ...lib,
                  cards: lib.cards.filter((c) => !c.deletedAt),
                }))
              }
              onMergeDuplicates={(keepId, removeId) =>
                setLibrary((lib) => ({
                  ...lib,
                  cards: lib.cards.filter((c) => c.id !== removeId),
                  projects: lib.projects.map((p) => ({
                    ...p,
                    cardIds: p.cardIds.filter((id) => id !== removeId),
                  })),
                }))
              }
              onRetryParse={retryParseCard}
              tags={tags}
              trashedCards={trashedCards}
            />
          ) : null}

          {activeSection === "trash" ? (
            <TrashView
              cards={trashedCards}
              locale={locale}
              onPermanentlyDelete={permanentlyDeleteCard}
              onRestore={restoreCard}
              tags={tags}
            />
          ) : null}

          {activeSection === "settings" ? (
            <SettingsView
              importFileInputRef={importFileInputRef}
              importStatus={importStatus}
              locale={locale}
              mcpEnabled={mcpEnabled}
              onImportChromeBookmarks={() => void importChromeBookmarks()}
              onImportFile={handleImportFile}
              setLocale={setLocale}
              setMcpEnabled={setMcpEnabled}
            />
          ) : null}
        </div>
      </section>

      {drawerCard ? (
        <CardDrawer
          card={drawerCard}
          locale={locale}
          onAiRetag={(cardId) => {
            void runAiTagger(library, cardId).then((updated) => {
              setLibrary(updated);
              setNotice({ message: "AI 重新打标完成" });
            }).catch(() => {
              setNotice({ message: "AI 打标失败（请检查 .env 中的 API Key）" });
            });
          }}
          onClose={() => setDrawerCardId(null)}
          onCreateTag={(slug, displayName, cardId) => {
            const newTag: HoardlyTag = {
              id: `tag-${slug}`,
              slug,
              labels: { en: displayName, "zh-CN": displayName },
              origin: "user",
              usageCount: 0,
            };
            setLibrary((lib) => ({
              ...lib,
              tags: [...lib.tags, newTag],
              cards: lib.cards.map((c) =>
                c.id === cardId
                  ? { ...c, tagIds: Array.from(new Set([...c.tagIds, newTag.id])) }
                  : c,
              ),
            }));
          }}
          onPermanentlyDelete={permanentlyDeleteCard}
          onRetryParse={retryParseCard}
          onSoftDelete={softDeleteCard}
          onToggleStar={toggleStar}
          onUpdateCard={updateCard}
          onSetProjectMembership={setCardProjectMembership}
          projects={projects}
          tags={tags}
        />
      ) : null}

      {activeSection === "all" && selectedCardIds.length > 0 ? (
        <BatchActionsBar
          activeProjects={activeProjects}
          batchProjectId={batchProjectId}
          batchTagId={batchTagId}
          locale={locale}
          onAddProject={() => setBatchProjectMembership(true)}
          onAddTag={addBatchTag}
          onCancel={clearCardSelection}
          onDelete={softDeleteSelectedCards}
          onExportSkill={exportSelectedSkill}
          onRemoveProject={() => setBatchProjectMembership(false)}
          onRemoveTag={removeBatchTag}
          onSelectAllVisible={selectAllVisibleCards}
          onSetBatchProjectId={setBatchProjectId}
          onSetBatchTagId={setBatchTagId}
          onSetStarred={setBatchStarred}
          selectedCount={selectedCardIds.length}
          tags={tags}
          visibleCount={visibleCardIds.length}
        />
      ) : null}
    </main>
  );
}

function AllCardsView({
  activeFilterCount,
  cards,
  locale,
  newCardValue,
  onClearFilters,
  onCreateCard,
  onOpenDrawer,
  onRetryParse,
  onSelectCard,
  onSoftDelete,
  onToggleStar,
  projects,
  selectedCardIds,
  selectedCardSet,
  selectedProjectId,
  searchQuery,
  selectedTagIds,
  selectedType,
  setNewCardValue,
  setSearchQuery,
  setSelectedProjectId,
  setSelectedTagIds,
  setSelectedType,
  setSortMode,
  setViewMode,
  sortMode,
  tags,
  viewMode,
}: {
  activeFilterCount: number;
  cards: HoardlyCard[];
  locale: HoardlyLocale;
  newCardValue: string;
  onClearFilters: () => void;
  onCreateCard: () => void;
  onOpenDrawer: (cardId: string) => void;
  onRetryParse: (cardId: string) => void;
  onSelectCard: (cardId: string, event: SelectionPointerEvent) => void;
  onSoftDelete: (cardId: string) => void;
  onToggleStar: (cardId: string) => void;
  projects: HoardlyProject[];
  searchQuery: string;
  selectedCardIds: string[];
  selectedCardSet: Set<string>;
  selectedProjectId: string | null;
  selectedTagIds: string[];
  selectedType: HoardlyCardType | "all";
  setNewCardValue: (value: string) => void;
  setSearchQuery: (value: string) => void;
  setSelectedProjectId: (projectId: string | null) => void;
  setSelectedTagIds: React.Dispatch<React.SetStateAction<string[]>>;
  setSelectedType: (type: HoardlyCardType | "all") => void;
  setSortMode: (mode: HoardlySortMode) => void;
  setViewMode: (mode: HoardlyViewMode) => void;
  sortMode: HoardlySortMode;
  tags: HoardlyTag[];
  viewMode: HoardlyViewMode;
}) {
  const platformChipTypes: Array<HoardlyCardType | "all"> = [
    "all", "web", "reddit", "tweet", "instagram", "threads", "linkedin",
    "facebook", "youtube", "bilibili", "xhs", "douyin", "tiktok",
    "wechat", "medium", "pinterest", "note", "pdf",
  ];

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">粘贴即收藏 / 手动新建</p>
            <p className="text-xs text-muted-foreground">
              输入 URL 会创建 pending 卡片；输入文字会创建 note 卡片。
            </p>
          </div>
          <div className="flex min-w-0 flex-1 gap-2">
            <Input
              className="h-10"
              placeholder="https://... 或一条笔记"
              value={newCardValue}
              onChange={(event) => setNewCardValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCreateCard();
              }}
            />
            <Button className="gap-1.5" onClick={onCreateCard}>
              <Plus className="size-4" />
              新建
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 平台类型 chip 横排 */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {platformChipTypes.map((type) => {
          const isAll = type === "all";
          const active = isAll ? selectedType === "all" : selectedType === type;
          const color = isAll ? "#6b7280" : getPlatformColor(type);
          return (
            <button
              key={type}
              type="button"
              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                active
                  ? "border-transparent text-white"
                  : "border-border bg-background text-muted-foreground hover:bg-accent"
              }`}
              style={active ? { backgroundColor: color } : undefined}
              onClick={() => setSelectedType(isAll ? "all" : (type as HoardlyCardType))}
            >
              {!isAll && (
                <span className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: active ? "white" : color }} />
              )}
              {isAll ? "全部" : cardTypeLabels[type]}
            </button>
          );
        })}
      </div>

      {/* 标签多选 chip + 项目筛选 + 排序 + 视图切换 */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="项目"
            value={selectedProjectId ?? "all"}
            options={[
              { label: "全部项目", value: "all" },
              ...projects
                .filter((project) => project.status === "active")
                .map((project) => ({ label: project.name, value: project.id })),
            ]}
            onChange={(value) => setSelectedProjectId(value === "all" ? null : value)}
          />
          {/* 已激活的标签 chip，可逐个移除 */}
          {selectedTagIds.map((tagId) => {
            const tag = tags.find((t) => t.id === tagId);
            if (!tag) return null;
            return (
              <button
                key={tagId}
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs text-primary"
                onClick={() =>
                  setSelectedTagIds((prev) => prev.filter((id) => id !== tagId))
                }
              >
                #{localized(tag.labels, locale, tag.slug)}
                <X className="size-3" />
              </button>
            );
          })}
          {/* 添加更多标签下拉 */}
          {tags.filter((t) => !selectedTagIds.includes(t.id)).length > 0 && (
            <FilterSelect
              label={selectedTagIds.length > 0 ? "+ 标签" : "标签"}
              value="__placeholder__"
              options={[
                { label: "选择标签...", value: "__placeholder__" },
                ...tags
                  .filter((t) => !selectedTagIds.includes(t.id))
                  .map((tag) => ({
                    label: `#${localized(tag.labels, locale, tag.slug)}`,
                    value: tag.id,
                  })),
              ]}
              onChange={(value) => {
                if (value && value !== "__placeholder__") {
                  setSelectedTagIds((prev) => [...prev, value]);
                }
              }}
            />
          )}
          {activeFilterCount > 0 ? (
            <Button size="sm" variant="ghost" onClick={onClearFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Tabs value={sortMode} onValueChange={(value) => setSortMode(value as HoardlySortMode)}>
            <TabsList>
              <TabsTrigger value="recent">最新</TabsTrigger>
              <TabsTrigger value="lastViewed">最近访问</TabsTrigger>
              <TabsTrigger value="smart">智能</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            size="icon"
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            aria-label="网格视图"
            onClick={() => setViewMode("grid")}
          >
            <Grid2X2 className="size-4" />
          </Button>
          <Button
            size="icon"
            variant={viewMode === "list" ? "secondary" : "ghost"}
            aria-label="列表视图"
            onClick={() => setViewMode("list")}
          >
            <List className="size-4" />
          </Button>
        </div>
      </div>

      {cards.length === 0 ? (
        activeFilterCount > 0 ? (
          <div className="rounded-2xl border border-border bg-card p-8 text-center">
            <Search className="mx-auto mb-3 size-10 text-muted-foreground" />
            <h2 className="text-base font-semibold">没有匹配的卡片</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              试试减少筛选条件，或切换平台类型
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button size="sm" variant="outline" onClick={onClearFilters}>
                清除所有筛选
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSearchQuery("")}>
                清空搜索词
              </Button>
            </div>
          </div>
        ) : (
          <EmptyState
            title="还没有卡片"
            description="粘贴链接或输入笔记即可创建卡片，也可以从 Chrome 书签一键导入。"
            actionLabel="前往设置导入"
            onAction={() => {}}
          />
        )
      ) : (
        <div
          className={
            viewMode === "grid"
              ? "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
              : "space-y-3"
          }
        >
          {cards.map((card) => (
            <KnowledgeCard
              key={card.id}
              card={card}
              locale={locale}
              onOpenDrawer={onOpenDrawer}
              onRetryParse={onRetryParse}
              onSelectCard={onSelectCard}
              onSoftDelete={onSoftDelete}
              onToggleStar={onToggleStar}
              projects={projects}
              searchQuery={searchQuery.trim()}
              selected={selectedCardSet.has(card.id)}
              selectionActive={selectedCardIds.length > 0}
              tags={tags}
              viewMode={viewMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CardTagRow({ tags, locale }: { tags: HoardlyTag[]; locale: HoardlyLocale }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const children = Array.from(el.children) as HTMLElement[];
      if (children.length === 0) return;
      const rowTop = children[0].offsetTop;
      let count = 0;
      for (const child of children) {
        if (child.dataset.overflow) continue;
        if (child.offsetTop > rowTop) break;
        count++;
      }
      setVisibleCount(count || 1);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tags]);

  const overflow = tags.length - visibleCount;

  return (
    <div ref={containerRef} className="mt-auto flex flex-wrap gap-1.5 max-h-[26px] overflow-hidden">
      {tags.slice(0, visibleCount).map((tag) => (
        <TagPill key={tag.id} origin={tag.origin}>
          #{localized(tag.labels, locale, tag.slug)}
        </TagPill>
      ))}
      {overflow > 0 ? <TagPill origin="system" data-overflow="1">+{overflow}</TagPill> : null}
    </div>
  );
}

function KnowledgeCard({
  card,
  locale,
  onOpenDrawer,
  onRetryParse,
  onSelectCard,
  onSoftDelete,
  onToggleStar,
  projects,
  searchQuery,
  selected,
  selectionActive,
  tags,
  viewMode,
}: {
  card: HoardlyCard;
  locale: HoardlyLocale;
  onOpenDrawer: (cardId: string) => void;
  onRetryParse: (cardId: string) => void;
  onSelectCard: (cardId: string, event: SelectionPointerEvent) => void;
  onSoftDelete: (cardId: string) => void;
  onToggleStar: (cardId: string) => void;
  projects: HoardlyProject[];
  searchQuery?: string;
  selected: boolean;
  selectionActive: boolean;
  tags: HoardlyTag[];
  viewMode: HoardlyViewMode;
}) {
  const cardTags = card.tagIds
    .map((tagId) => findTag(tags, tagId))
    .filter((tag): tag is HoardlyTag => Boolean(tag))
    .sort((a, b) => (TAG_DIMENSION_PRIORITY[a.dimension ?? "domain"] ?? 9) - (TAG_DIMENSION_PRIORITY[b.dimension ?? "domain"] ?? 9));
  const cardProjects = card.projectIds
    .map((projectId) => projects.find((project) => project.id === projectId))
    .filter((project): project is HoardlyProject => Boolean(project));
  const title = localized(card.titleI18n, locale, card.titleOriginal);
  const summary = localized(card.summary, locale);
  const Icon = iconForType(card.type);

  const openPrimary = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || selectionActive) {
      event.preventDefault();
      onSelectCard(card.id, event);
      return;
    }
    if (card.type === "note" || !card.url) {
      onOpenDrawer(card.id);
      return;
    }
    window.open(card.url, "_blank", "noopener,noreferrer");
  };

  return (
    <Card
      className={`relative h-full transition-colors hover:bg-accent/40 ${
        viewMode === "list" ? "py-4" : ""
      } ${selected ? "ring-2 ring-primary bg-accent/30" : ""}`}
    >
      {cardProjects.length > 0 ? (
        <div className="absolute inset-x-0 top-0 flex h-1 overflow-hidden rounded-t-2xl">
          {cardProjects.map((project) => (
            <span
              key={project.id}
              className="flex-1"
              style={{ backgroundColor: project.color }}
            />
          ))}
        </div>
      ) : null}

      <button
        type="button"
        className={`flex h-full w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          viewMode === "list" ? "items-center gap-4 px-4" : "flex-col"
        }`}
        onClick={openPrimary}
      >
        <div
          className={`relative shrink-0 overflow-hidden ${
            viewMode === "list" ? "size-20 rounded-xl" : "aspect-video w-full rounded-t-2xl"
          }`}
          style={{ borderBottom: viewMode !== "list" ? `2px solid ${getPlatformColor(card.type)}22` : undefined }}
        >
          {card.url ? (
            <SiteBookmarkThumbnail
              url={card.url}
              ogImageUrl={card.thumbnailUrl}
              variant={viewMode === "list" ? "tile" : "card"}
            />
          ) : (
            <div className="flex size-full items-center justify-center bg-muted">
              <Icon className="size-8 text-muted-foreground" />
            </div>
          )}
          <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-background/90 px-1.5 py-0.5 text-[11px]">
            <span
              className="size-2 rounded-full shrink-0"
              style={{ backgroundColor: getPlatformColor(card.type) }}
            />
            {cardTypeLabels[card.type]}
          </span>
        </div>

        <CardContent className={viewMode === "list" ? "min-w-0 flex-1 p-0" : "flex flex-1 flex-col p-4"}>
          <div className="mb-2 flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="line-clamp-2 text-sm font-semibold">
                {searchQuery ? highlightText(title, searchQuery) : title}
              </h2>
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                {summary && searchQuery ? highlightText(summary, searchQuery) : summary}
              </p>
            </div>
            {card.starred ? <Star className="size-4 fill-current text-primary" /> : null}
          </div>

          <CardTagRow tags={cardTags} locale={locale} />

          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex items-center gap-1.5 truncate">
              <span className={`inline-flex shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none ${
                card.captureMode === "capture" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : card.captureMode === "upload" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400"
                : "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"
              }`}>
                {card.captureMode === "capture" ? "采集" : card.captureMode === "upload" ? "上传" : "收藏"}
              </span>
              {relativeTime(card.createdAt)}
              {socialMetaLine(card) ? (
                <>
                  {" · "}
                  <span style={{ color: getPlatformColor(card.type) }}>
                    {socialMetaLine(card)}
                  </span>
                </>
              ) : (
                <> · {card.sourcePlatform}</>
              )}
            </span>
            <StatusPill
              failReason={card.parseFailReason}
              status={card.parseStatus}
              storage={card.storageLocation}
            />
          </div>
        </CardContent>
      </button>

      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute right-3 top-3 bg-background/80"
        aria-label="打开详情"
        onClick={() => onOpenDrawer(card.id)}
      >
        <MoreHorizontal className="size-4" />
      </Button>

      <div className="absolute left-3 top-3 flex gap-1">
        <input
          aria-label={selected ? "取消选择卡片" : "选择卡片"}
          checked={selected}
          className="size-8 rounded-md border border-border bg-background/80 accent-primary"
          readOnly
          type="checkbox"
          onClick={(event) => {
            event.stopPropagation();
            onSelectCard(card.id, event);
          }}
        />
        <Button
          size="icon-sm"
          variant={card.starred ? "secondary" : "ghost"}
          className="bg-background/80"
          aria-label={card.starred ? "取消星标" : "星标"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar(card.id);
          }}
        >
          <Star className={`size-4 ${card.starred ? "fill-current" : ""}`} />
        </Button>
        {card.parseStatus === "failed" ? (
          <Button
            size="icon-sm"
            variant="ghost"
            className="bg-background/80 text-destructive"
            aria-label="重试解析"
            onClick={(event) => {
              event.stopPropagation();
              onRetryParse(card.id);
            }}
          >
            <Wrench className="size-4" />
          </Button>
        ) : null}
        <Button
          size="icon-sm"
          variant="ghost"
          className="bg-background/80"
          aria-label="移入回收站"
          onClick={(event) => {
            event.stopPropagation();
            onSoftDelete(card.id);
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </Card>
  );
}

function ProjectsView({
  cards,
  locale,
  newProjectColor,
  newProjectDescription,
  newProjectName,
  onCreateProject,
  onDissolveProject,
  onSelectProject,
  projects,
  setNewProjectColor,
  setNewProjectDescription,
  setNewProjectName,
  tags,
}: {
  cards: HoardlyCard[];
  locale: HoardlyLocale;
  newProjectColor: string;
  newProjectDescription: string;
  newProjectName: string;
  onCreateProject: () => void;
  onDissolveProject: (project: HoardlyProject) => void;
  onSelectProject: (projectId: string) => void;
  projects: HoardlyProject[];
  setNewProjectColor: (value: string) => void;
  setNewProjectDescription: (value: string) => void;
  setNewProjectName: (value: string) => void;
  tags: HoardlyTag[];
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderPlus className="size-5" />
            新建项目
          </CardTitle>
          <CardDescription>
            项目是临时工作区；解散后卡片会保留项目历史标签。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-[1fr_1.4fr_auto_auto] lg:items-center">
          <Input
            placeholder="项目名"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCreateProject();
            }}
          />
          <Input
            placeholder="描述，用于后续智能排序和项目唤醒"
            value={newProjectDescription}
            onChange={(event) => setNewProjectDescription(event.target.value)}
          />
          <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
            <span className="text-xs text-muted-foreground">颜色</span>
            <input
              aria-label="项目颜色"
              className="size-7 rounded border border-border bg-transparent"
              type="color"
              value={newProjectColor}
              onChange={(event) => setNewProjectColor(event.target.value)}
            />
          </label>
          <Button className="gap-1.5" onClick={onCreateProject}>
            <Plus className="size-4" />
            创建
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        {projects.map((project) => {
          const projectCards = cards.filter((card) => card.projectIds.includes(project.id));
          const projectTags = summarizeTags(projectCards, tags, locale).slice(0, 5);
          return (
            <Card key={project.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <span className="size-2.5 rounded-full" style={{ backgroundColor: project.color }} />
                      {project.name}
                    </CardTitle>
                    <CardDescription>{project.description || "暂无描述"}</CardDescription>
                  </div>
                  <span className="rounded-md bg-secondary px-2 py-1 text-xs">
                    {projectCards.length} 张
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-1.5">
                  {projectTags.length > 0 ? (
                    projectTags.map((item) => (
                      <TagPill key={item.label} origin="ai">
                        #{item.label} · {item.count}
                      </TagPill>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">还没有卡片加入这个项目。</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button className="gap-1.5" onClick={() => onSelectProject(project.id)}>
                    查看项目
                    <ChevronRight className="size-4" />
                  </Button>
                  <Button variant="outline" onClick={() => onDissolveProject(project)}>
                    解散
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function TagsView({
  cards,
  locale,
  onToggleTag,
  selectedTagIds,
  tags,
}: {
  cards: HoardlyCard[];
  locale: HoardlyLocale;
  onToggleTag: (tagId: string) => void;
  selectedTagIds: string[];
  tags: HoardlyTag[];
}) {
  const [dimFilter, setDimFilter] = useState<HoardlyTagDimension | "all">("all");

  const TOP_N = 30;
  const tagCounts = tags
    .filter((tag) => dimFilter === "all" || tag.dimension === dimFilter)
    .map((tag) => ({
      tag,
      count: cards.filter((card) => !card.deletedAt && card.tagIds.includes(tag.id)).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  const maxCount = tagCounts[0]?.count ?? 1;
  const minCount = tagCounts[tagCounts.length - 1]?.count ?? 0;
  const countRange = Math.max(1, maxCount - minCount);

  function tagFontSize(count: number) {
    const ratio = (count - minCount) / countRange;
    return `${(0.85 + ratio * 0.95).toFixed(2)}rem`;
  }

  const dimOptions: Array<{ id: HoardlyTagDimension | "all"; label: string }> = [
    { id: "all", label: "全部" },
    { id: "topic", label: "主题" },
    { id: "entity", label: "实体" },
    { id: "method", label: "方法" },
    { id: "useCase", label: "用途" },
    { id: "domain", label: "领域" },
  ];

  return (
    <div className="space-y-6">
      {/* Dimension filter chips */}
      <div className="flex flex-wrap gap-2">
        {dimOptions.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              dimFilter === opt.id
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-accent"
            }`}
            onClick={() => setDimFilter(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-border bg-card p-6">
        <p className="mb-5 text-xs text-muted-foreground">
          点击标签可叠加筛选（AND 逻辑）· 已选 {selectedTagIds.length} 个
          {selectedTagIds.length > 0 && (
            <button
              type="button"
              className="ml-2 text-primary underline-offset-2 hover:underline"
              onClick={() => selectedTagIds.forEach((id) => onToggleTag(id))}
            >
              全部清除
            </button>
          )}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-3 leading-relaxed">
          {tagCounts.map(({ tag, count }) => {
            const label = localized(tag.labels, locale, tag.slug);
            const active = selectedTagIds.includes(tag.id);
            return (
              <button
                key={tag.id}
                type="button"
                style={{ fontSize: tagFontSize(count) }}
                className={`inline-flex items-baseline gap-1 rounded-lg px-2 py-0.5 font-medium transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/80 hover:bg-accent hover:text-foreground"
                }`}
                onClick={() => onToggleTag(tag.id)}
              >
                #{label}
                <span className="text-[0.65rem] opacity-60">{count}</span>
              </button>
            );
          })}
          {tagCounts.length === 0 && (
            <p className="text-sm text-muted-foreground">此维度下暂无标签。</p>
          )}
        </div>
      </div>

      {/* tag detail list grouped by dimension */}
      {(() => {
        const dimOrder: Array<HoardlyTagDimension | "other"> = ["topic", "entity", "method", "useCase", "domain", "other"];
        const groups = new Map<string, typeof tagCounts>();
        for (const item of tagCounts) {
          const dim = item.tag.dimension ?? "other";
          if (!groups.has(dim)) groups.set(dim, []);
          groups.get(dim)!.push(item);
        }
        return dimOrder.filter((d) => groups.has(d)).map((dim) => (
          <div key={dim}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {dim === "other" ? "其他" : TAG_DIMENSION_LABELS[dim]?.zh ?? dim}
            </h3>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {groups.get(dim)!.map(({ tag, count }) => {
                const label = localized(tag.labels, locale, tag.slug);
                const active = selectedTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-colors ${
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card hover:bg-accent"
                    }`}
                    onClick={() => onToggleTag(tag.id)}
                  >
                    <span className="font-medium">#{label}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded-md bg-secondary px-1.5 py-0.5">{count}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ));
      })()}
    </div>
  );
}

function AiSearchView({
  cards,
  locale,
  onOpenDrawer,
  query,
  setQuery,
  tags,
}: {
  cards: HoardlyCard[];
  locale: HoardlyLocale;
  onOpenDrawer: (cardId: string) => void;
  query: string;
  setQuery: (value: string) => void;
  tags: HoardlyTag[];
}) {
  const citations = useMemo(
    () => buildAiCitations(cards, tags, locale, query).slice(0, 5),
    [cards, locale, query, tags],
  );
  const hasQuery = query.trim().length > 0;
  const answer = hasQuery
    ? citations.length > 0
      ? "基于下方引用，当前库内最相关的线索集中在卡片标题、摘要和标签命中处。正式 Agentic RAG 接入后，会先混合检索，再围绕这些来源生成可追溯答案。"
      : "没有在当前筛选范围内找到足够来源。以下内容若继续生成，应标注为模型常识，而不是你的收藏证据。"
    : "输入问题后，这里会展示带来源引用的 AI 回答。";

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            问 Hoardly
          </CardTitle>
          <CardDescription>
            当前为前端占位：先用本地卡片模拟“回答必须带引用来源”的体验。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            className="h-12"
            placeholder="例如：根据我收藏的资料，Hoardly 的 P0 应该先做什么？"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="rounded-xl border border-border bg-background p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-secondary px-2 py-1 text-xs">检索：本地关键词</span>
              <span className="rounded-md bg-secondary px-2 py-1 text-xs">融合：RRF 占位</span>
              <span className="rounded-md bg-secondary px-2 py-1 text-xs">生成：RAG 待接入</span>
              <span className="rounded-md bg-secondary px-2 py-1 text-xs">
                引用：{citations.length} 个来源
              </span>
            </div>
            <p className="mt-4 text-sm leading-relaxed">{answer}</p>
            {hasQuery && citations.length === 0 ? (
              <p className="mt-3 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                来自模型常识，非你的收藏：正式接入模型后，任何无出处推断都会以这种方式标明。
              </p>
            ) : null}
            <Separator className="my-4" />
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-muted-foreground">引用卡片</p>
              <p className="text-xs text-muted-foreground">点击来源打开详情 Drawer</p>
            </div>
            <div className="space-y-2">
              {citations.length > 0 ? (
                citations.map((citation) => (
                  <button
                    key={citation.card.id}
                    type="button"
                    className="w-full rounded-lg border border-border bg-muted px-3 py-3 text-left transition-colors hover:bg-accent"
                    onClick={() => onOpenDrawer(citation.card.id)}
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <p className="line-clamp-1 text-sm font-medium">
                          {localized(citation.card.titleI18n, locale, citation.card.titleOriginal)}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                          {citation.snippet}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-md bg-background px-2 py-1 text-xs">
                        score {citation.score}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {citation.matchedFields.map((field) => (
                        <TagPill key={field} origin="system">
                          {field}
                        </TagPill>
                      ))}
                      {citation.card.tagIds
                        .map((tagId) => findTag(tags, tagId))
                        .filter((tag): tag is HoardlyTag => Boolean(tag))
                        .slice(0, 3)
                        .map((tag) => (
                          <TagPill key={tag.id} origin={tag.origin}>
                            #{localized(tag.labels, locale, tag.slug)}
                          </TagPill>
                        ))}
                    </div>
                  </button>
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-border bg-muted px-3 py-6 text-center text-sm text-muted-foreground">
                  暂无引用来源。换个关键词，或清除筛选后再问。
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MaintenanceView({
  allCards,
  issues,
  onDismissIssue,
  onEmptyTrash,
  onMergeDuplicates,
  onRetryParse,
  tags,
  trashedCards,
}: {
  allCards: HoardlyCard[];
  issues: HoardlyMaintenanceIssue[];
  onDismissIssue: (issueId: string) => void;
  onEmptyTrash: () => void;
  onMergeDuplicates: (keepId: string, removeId: string) => void;
  onRetryParse: (cardId: string) => void;
  tags: HoardlyTag[];
  trashedCards: HoardlyCard[];
}) {
  const FREE_LIMIT = 500;
  const activeCards = allCards.filter((c) => !c.deletedAt);
  const usagePct = Math.min(100, Math.round((activeCards.length / FREE_LIMIT) * 100));

  // Failed cards
  const failedCards = activeCards.filter((c) => c.parseStatus === "failed");

  // Duplicate detection: same normalised URL
  const seen = new Map<string, HoardlyCard>();
  const duplicatePairs: Array<[HoardlyCard, HoardlyCard]> = [];
  for (const card of activeCards) {
    if (!card.url) continue;
    const key = card.url.toLowerCase().replace(/\/$/, "").replace(/^https?:\/\/www\./, "https://");
    if (seen.has(key)) {
      duplicatePairs.push([seen.get(key)!, card]);
    } else {
      seen.set(key, card);
    }
  }

  const severityColor: Record<string, string> = {
    low: "bg-muted text-muted-foreground",
    medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    high: "bg-destructive/10 text-destructive",
  };

  return (
    <div className="space-y-6">
      {/* 配额面板 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">库配额</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span>{activeCards.length} / {FREE_LIMIT} 张卡片</span>
            <span className="text-muted-foreground">{usagePct}% 已用</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-secondary">
            <div
              className={`h-full rounded-full transition-all ${usagePct > 80 ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${usagePct}%` }}
            />
          </div>
          <div className="grid grid-cols-3 gap-3 pt-1 text-center text-xs text-muted-foreground">
            <div><p className="text-lg font-semibold text-foreground">{activeCards.length}</p>活跃卡片</div>
            <div><p className="text-lg font-semibold text-foreground">{trashedCards.length}</p>回收站</div>
            <div><p className="text-lg font-semibold text-foreground">{failedCards.length}</p>解析失败</div>
          </div>
        </CardContent>
      </Card>

      {/* 解析失败卡片 */}
      {failedCards.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold">解析失败 ({failedCards.length})</h2>
          <div className="space-y-2">
            {failedCards.map((card) => (
              <Card key={card.id}>
                <CardContent className="flex flex-col gap-2 p-3 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{card.titleOriginal}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {card.parseFailReason ? PARSE_FAIL_LABELS[card.parseFailReason] : "未知原因"} ·{" "}
                      {card.url ? card.url.slice(0, 50) : "无 URL"}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => onRetryParse(card.id)}>
                    <Wrench className="size-3.5" />
                    重试
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* 重复卡片 */}
      {duplicatePairs.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold">疑似重复 ({duplicatePairs.length} 对)</h2>
          <div className="space-y-2">
            {duplicatePairs.map(([older, newer]) => (
              <Card key={`${older.id}-${newer.id}`}>
                <CardContent className="p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-md bg-secondary px-1.5 py-0.5">相同 URL</span>
                    <span className="truncate">{newer.url}</span>
                  </div>
                  <div className="flex flex-col gap-1.5 md:flex-row md:items-center">
                    <div className="min-w-0 flex-1 rounded-lg bg-muted px-2 py-1.5 text-xs">
                      <p className="font-medium">保留（较旧）：{older.titleOriginal}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 gap-1.5 text-destructive hover:text-destructive"
                      onClick={() => onMergeDuplicates(older.id, newer.id)}
                    >
                      删除较新副本
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* 维护事项 */}
      {issues.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold">待处理事项 ({issues.length})</h2>
          <div className="space-y-2">
            {issues.map((issue) => (
              <Card key={issue.id}>
                <CardContent className="flex flex-col gap-2 p-3 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{issue.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{issue.description}</p>
                  </div>
                  <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${severityColor[issue.severity] ?? severityColor.low}`}>
                    {issue.severity === "high" ? "紧急" : issue.severity === "medium" ? "一般" : "低优"}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => onDismissIssue(issue.id)}>
                    已处理
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* 标签池维护 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">标签池状态</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(() => {
            const POOL_TARGET = 1000;
            const poolSize = tags.length;
            const poolPct = Math.min(100, Math.round((poolSize / POOL_TARGET) * 100));
            const dimCounts = tags.reduce<Record<string, number>>((acc, t) => {
              const dim = t.dimension ?? "other";
              acc[dim] = (acc[dim] ?? 0) + 1;
              return acc;
            }, {});
            const zeroUsage = tags.filter((t) => t.usageCount === 0).length;
            const lastMaint = localStorage.getItem("hoardly_last_tag_pool_maint");
            return (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span>{poolSize} / {POOL_TARGET} 标签</span>
                  <span className="text-muted-foreground">{poolPct}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className={`h-full rounded-full transition-all ${poolPct > 80 ? "bg-green-500" : "bg-primary"}`}
                    style={{ width: `${poolPct}%` }}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2 pt-1 text-center text-xs text-muted-foreground">
                  <div><p className="text-base font-semibold text-foreground">{dimCounts["topic"] ?? 0}</p>topic</div>
                  <div><p className="text-base font-semibold text-foreground">{dimCounts["entity"] ?? 0}</p>entity</div>
                  <div><p className="text-base font-semibold text-foreground">{dimCounts["method"] ?? 0}</p>method</div>
                  <div><p className="text-base font-semibold text-foreground">{dimCounts["useCase"] ?? 0}</p>useCase</div>
                  <div><p className="text-base font-semibold text-foreground">{dimCounts["domain"] ?? 0}</p>domain</div>
                  <div><p className="text-base font-semibold text-foreground">{zeroUsage}</p>未使用</div>
                </div>
                <p className="text-xs text-muted-foreground">
                  上次维护：{lastMaint ? new Date(lastMaint).toLocaleDateString() : "从未"}
                  {" · "}AI 打标时自动扩充池子，定期维护合并低频标签
                </p>
              </>
            );
          })()}
        </CardContent>
      </Card>

      {/* 回收站操作 */}
      <Card>
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div>
            <p className="text-sm font-medium">清空回收站</p>
            <p className="text-xs text-muted-foreground">
              共 {trashedCards.length} 张已删卡片，清空后不可恢复。
            </p>
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={trashedCards.length === 0}
            onClick={onEmptyTrash}
          >
            全部清空
          </Button>
        </CardContent>
      </Card>

      {failedCards.length === 0 && duplicatePairs.length === 0 && issues.length === 0 && (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <CheckCircle2 className="mx-auto mb-3 size-10 text-green-500" />
          <h2 className="text-base font-semibold">库状态良好</h2>
          <p className="mt-2 text-sm text-muted-foreground">没有失效链接、重复卡或待处理问题。</p>
        </div>
      )}
    </div>
  );
}

function TrashView({
  cards,
  locale,
  onPermanentlyDelete,
  onRestore,
  tags,
}: {
  cards: HoardlyCard[];
  locale: HoardlyLocale;
  onPermanentlyDelete: (cardId: string) => void;
  onRestore: (cardId: string) => void;
  tags: HoardlyTag[];
}) {
  if (cards.length === 0) {
    return (
      <EmptyState
        title="回收站为空"
        description="删除的卡片会在这里保留 30 天，之后再接入自动清理。"
      />
    );
  }

  return (
    <div className="space-y-3">
      {cards.map((card) => (
        <Card key={card.id}>
          <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{localized(card.titleI18n, locale, card.titleOriginal)}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                删除于 {card.deletedAt ? new Date(card.deletedAt).toLocaleString() : "未知时间"} ·{" "}
                {card.tagIds
                  .map((tagId) => localized(findTag(tags, tagId)?.labels, locale))
                  .filter(Boolean)
                  .slice(0, 3)
                  .map((tag) => `#${tag}`)
                  .join(" ")}
              </p>
            </div>
            <Button variant="outline" onClick={() => onRestore(card.id)}>
              恢复
            </Button>
            <Button variant="destructive" onClick={() => onPermanentlyDelete(card.id)}>
              永久删除
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SettingsView({
  importFileInputRef,
  importStatus,
  locale,
  mcpEnabled,
  onImportChromeBookmarks,
  onImportFile,
  setLocale,
  setMcpEnabled,
}: {
  importFileInputRef: React.RefObject<HTMLInputElement | null>;
  importStatus: ImportStatus;
  locale: HoardlyLocale;
  mcpEnabled: boolean;
  onImportChromeBookmarks: () => void;
  onImportFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  setLocale: (locale: HoardlyLocale) => void;
  setMcpEnabled: (enabled: boolean) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SettingsCard icon={FileUp} title="收藏导入">
        <p className="text-sm text-muted-foreground">
          上传书签文件导入到 Hoardly。支持浏览器导出的 HTML 书签文件、CSV、JSON 或 Markdown 格式。
        </p>
        <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-xs font-medium text-amber-400">⚠️ 导入将完全覆盖当前收藏库中的所有卡片，此操作不可撤销。请在导入前确认备份。</p>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            className="gap-1.5"
            disabled={importStatus.state === "importing"}
            onClick={() => importFileInputRef.current?.click()}
          >
            {importStatus.state === "importing" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileUp className="size-4" />
            )}
            上传书签文件
          </Button>
          <input
            ref={importFileInputRef}
            type="file"
            accept=".html,.htm,.csv,.json,.md,.markdown"
            className="hidden"
            onChange={onImportFile}
          />
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={importStatus.state === "importing"}
            onClick={onImportChromeBookmarks}
          >
            <Archive className="size-4" />
            从 Chrome 导入
          </Button>
          <span className="rounded-md bg-secondary px-2 py-1 text-xs">
            {hasChromeExtensionRuntime() ? "扩展环境" : "H5 示例模式"}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          支持格式：HTML（浏览器导出）、CSV、JSON、Markdown
        </p>
        <p
          className={`mt-2 text-sm ${
            importStatus.state === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {importStatus.message}
        </p>
      </SettingsCard>
      <SettingsCard icon={Languages} title="语言">
        <FilterSelect
          label="界面语言"
          value={locale}
          options={[
            { label: "简体中文", value: "zh-CN" },
            { label: "English", value: "en" },
            { label: "日本語", value: "ja" },
            { label: "Español", value: "es" },
          ]}
          onChange={(value) => setLocale(value as HoardlyLocale)}
        />
        <p className="mt-3 text-sm text-muted-foreground">
          AI 标签与摘要会按当前语言展示，缺失时回退英文。
        </p>
      </SettingsCard>
      <SettingsCard icon={Sparkles} title="AI 模型">
        <p className="text-sm text-muted-foreground">
          平台默认 AI / BYOK / 测试连接将在接入后端后启用。当前先保留统一设置入口。
        </p>
      </SettingsCard>
      <SettingsCard icon={Cloud} title="存储偏好">
        <p className="text-sm text-muted-foreground">
          默认云端；视频、语音、大文件可按类型改为本地。在线视频仍作为链接卡片，不下载。
        </p>
      </SettingsCard>
      <SettingsCard icon={Upload} title="数据导出">
        <p className="text-sm text-muted-foreground">
          后续支持 JSON、CSV、Markdown 与 Skill 知识包导出。
        </p>
      </SettingsCard>
      <SettingsCard icon={Database} title="MCP Server（本地开发）">
        <p className="text-sm text-muted-foreground">
          开启后，每次保存卡片会同步到本地 MCP 端点，让 Claude、Cursor 等 AI 工具直接查询你的收藏库。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary"
              checked={mcpEnabled}
              onChange={(e) => {
                setMcpEnabled(e.target.checked);
                window.localStorage.setItem("hoardly:mcp-enabled", String(e.target.checked));
              }}
            />
            启用本地 MCP 同步
          </label>
          {mcpEnabled && (
            <code className="rounded-md bg-muted px-2 py-1 text-xs">
              http://localhost:5173/api/mcp
            </code>
          )}
        </div>
        {mcpEnabled && (
          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
            <p><span className="font-mono">GET /api/mcp/cards</span> — 列出所有卡片（分页）</p>
            <p><span className="font-mono">GET /api/mcp/cards/search?q=…</span> — 关键词搜索</p>
            <p><span className="font-mono">GET /api/mcp/cards/:id</span> — 获取单张卡片</p>
            <p><span className="font-mono">GET /api/mcp/status</span> — 当前状态与卡片总数</p>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function CardDrawer({
  card,
  locale,
  onAiRetag,
  onClose,
  onCreateTag,
  onPermanentlyDelete,
  onRetryParse,
  onSetProjectMembership,
  onSoftDelete,
  onToggleStar,
  onUpdateCard,
  projects,
  tags,
}: {
  card: HoardlyCard;
  locale: HoardlyLocale;
  onAiRetag?: (cardId: string) => void;
  onClose: () => void;
  onCreateTag?: (slug: string, displayName: string, cardId: string) => void;
  onPermanentlyDelete: (cardId: string) => void;
  onRetryParse: (cardId: string) => void;
  onSetProjectMembership: (cardId: string, projectId: string, selected: boolean) => void;
  onSoftDelete: (cardId: string) => void;
  onToggleStar: (cardId: string) => void;
  onUpdateCard: (cardId: string, patch: Partial<HoardlyCard>) => void;
  projects: HoardlyProject[];
  tags: HoardlyTag[];
}) {
  const [tagToAdd, setTagToAdd] = useState("");
  const [noteMode, setNoteMode] = useState<"edit" | "preview">("edit");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  const cardTags = card.tagIds
    .map((tagId) => findTag(tags, tagId))
    .filter((tag): tag is HoardlyTag => Boolean(tag));
  const cardProjects = card.projectIds
    .map((projectId) => projects.find((project) => project.id === projectId))
    .filter((project): project is HoardlyProject => Boolean(project));

  // Keyboard shortcuts: Esc → close, E → focus note (when not in an input)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "e" && !inInput && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setNoteMode("edit");
        noteRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Read-time estimate
  const estimatedReadMin = card.wordCount ? Math.max(1, Math.ceil(card.wordCount / 200)) : null;

  // Social platforms that can have thread snapshots
  const isSocialCard = ["reddit", "tweet", "threads", "facebook", "linkedin"].includes(card.type);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-background/60 backdrop-blur-sm">
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-background shadow-xl">

        {/* ── Header ── */}
        <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-5 py-4 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="mb-1.5 text-xs text-muted-foreground">
                <span
                  className="mr-1 inline-block size-2 rounded-full align-middle"
                  style={{ backgroundColor: getPlatformColor(card.type) }}
                />
                {cardTypeLabels[card.type]}
                {socialMetaLine(card) ? (
                  <>
                    {" · "}
                    <span style={{ color: getPlatformColor(card.type) }}>
                      {socialMetaLine(card)}
                    </span>
                  </>
                ) : (
                  <> · {card.sourcePlatform}</>
                )}
                {estimatedReadMin ? <> · 约 {estimatedReadMin} 分钟阅读</> : null}
              </p>
              <Input
                className="h-10 text-base font-semibold"
                aria-label="编辑标题"
                value={localized(card.titleI18n, locale, card.titleOriginal)}
                onChange={(event) =>
                  onUpdateCard(card.id, {
                    titleI18n: { ...card.titleI18n, [locale]: event.target.value },
                  })
                }
              />
            </div>
            <Button size="icon" variant="ghost" aria-label="关闭详情 (Esc)" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>

          {/* 快捷操作行 */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {card.url ? (
              <Button size="sm" className="gap-1.5 h-8" onClick={() => window.open(card.url, "_blank", "noopener,noreferrer")}>
                <Link2 className="size-3.5" />
                打开原文
              </Button>
            ) : null}
            <Button size="sm" variant={card.starred ? "secondary" : "outline"} className="gap-1.5 h-8" onClick={() => onToggleStar(card.id)}>
              <Star className={`size-3.5 ${card.starred ? "fill-current" : ""}`} />
              {card.starred ? "取消星标" : "星标"}
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5 h-8">
              <Bot className="size-3.5" />
              问这张卡
            </Button>
          </div>
        </div>

        <div className="space-y-0 divide-y divide-border">

          {/* ── 缩略图 ── */}
          <div className="relative overflow-hidden">
            {card.url ? (
              <SiteBookmarkThumbnail
                url={card.url}
                ogImageUrl={card.thumbnailUrl}
                variant="full"
              />
            ) : (
              <div
                className="flex aspect-video items-center justify-center"
                style={{ backgroundColor: `${getPlatformColor(card.type)}18` }}
              >
                <div className="flex flex-col items-center gap-2">
                  {React.createElement(iconForType(card.type), {
                    className: "size-14",
                    style: { color: getPlatformColor(card.type) },
                  })}
                  <span className="text-xs text-muted-foreground">暂无截图</span>
                </div>
              </div>
            )}
          </div>

          {/* ── 元数据 ── */}
          <div className="px-5 py-4">
            <dl className="space-y-1.5 text-xs">
              {card.url ? (
                <div className="flex items-start gap-2">
                  <dt className="w-14 shrink-0 text-muted-foreground">来源</dt>
                  <dd className="min-w-0">
                    <a
                      href={card.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="truncate text-primary underline-offset-2 hover:underline"
                    >
                      {card.url.length > 60 ? `${card.url.slice(0, 60)}…` : card.url}
                    </a>
                  </dd>
                </div>
              ) : null}
              {card.authorName || card.authorHandle ? (
                <div className="flex items-start gap-2">
                  <dt className="w-14 shrink-0 text-muted-foreground">作者</dt>
                  <dd>{card.authorHandle ?? card.authorName}</dd>
                </div>
              ) : null}
              {card.subreddit ? (
                <div className="flex items-start gap-2">
                  <dt className="w-14 shrink-0 text-muted-foreground">版块</dt>
                  <dd style={{ color: getPlatformColor(card.type) }}>{card.subreddit}</dd>
                </div>
              ) : null}
              <div className="flex items-start gap-2">
                <dt className="w-14 shrink-0 text-muted-foreground">采集</dt>
                <dd>{new Date(card.createdAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}</dd>
              </div>
              {card.wordCount ? (
                <div className="flex items-start gap-2">
                  <dt className="w-14 shrink-0 text-muted-foreground">字数</dt>
                  <dd>{card.wordCount.toLocaleString()} 字 · 约 {estimatedReadMin} 分钟</dd>
                </div>
              ) : null}
              <div className="flex items-start gap-2">
                <dt className="w-14 shrink-0 text-muted-foreground">状态</dt>
                <dd>
                  <StatusPill failReason={card.parseFailReason} status={card.parseStatus} storage={card.storageLocation} />
                </dd>
              </div>
            </dl>
          </div>

          {/* ── 解析失败提示 ── */}
          {card.parseStatus === "failed" ? (
            <div className="px-5 py-4">
              {card.parseFailReason ? (
                <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <span className="font-medium">{PARSE_FAIL_LABELS[card.parseFailReason]}：</span>
                  {PARSE_FAIL_HINTS[card.parseFailReason]}
                </p>
              ) : null}
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => onRetryParse(card.id)}>
                <Wrench className="size-3.5" />
                {card.parseFailReason === "login_wall" || card.parseFailReason === "private"
                  ? "重新尝试（截图兜底）"
                  : "重试解析"}
              </Button>
            </div>
          ) : null}

          {/* ── AI 摘要 ── */}
          <DrawerSection title="AI 摘要">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {localized(card.summary, locale)}
            </p>
          </DrawerSection>

          {/* ── 采集正文 ── */}
          {card.contentMarkdown ? (
            <DrawerSection title={`正文 · ${card.captureMode === "capture" ? "采集" : card.captureMode === "upload" ? "上传" : "收藏"}`}>
              <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed whitespace-pre-wrap">
                {card.contentMarkdown}
              </div>
            </DrawerSection>
          ) : null}

          {/* ── 附件 ── */}
          {card.attachments.length > 0 ? (
            <DrawerSection title={`附件 ${card.attachments.length}`}>
              <div className="grid grid-cols-2 gap-2">
                {card.attachments.map((att) => (
                  <div key={att.id} className="overflow-hidden rounded-lg border border-border">
                    {att.mediaType === "image" ? (
                      <img
                        alt={att.originalName}
                        src={att.url}
                        className="aspect-video w-full object-cover"
                        loading="lazy"
                      />
                    ) : att.mediaType === "video" ? (
                      <div className="flex aspect-video items-center justify-center bg-muted">
                        <Play className="size-8 text-muted-foreground" />
                      </div>
                    ) : (
                      <div className="flex aspect-video items-center justify-center bg-muted">
                        <FileText className="size-6 text-muted-foreground" />
                      </div>
                    )}
                    <div className="px-2 py-1.5">
                      <p className="truncate text-[11px] font-medium">{att.originalName}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {att.mimeType} · {(att.sizeBytes / 1024).toFixed(0)} KB
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </DrawerSection>
          ) : null}

          {/* ── Thread snapshot ── */}
          {isSocialCard ? (
            <DrawerSection title={card.threadSnapshot ? `线程 · ${card.threadSnapshot.totalPosts} 条` : "线程"}>
              {card.threadSnapshot ? (
                <div className="space-y-2">
                  {card.threadSnapshot.posts.map((post) => (
                    <div
                      key={post.id}
                      className="rounded-lg border border-border bg-card p-3 text-sm"
                      style={{ marginLeft: `${post.depth * 16}px` }}
                    >
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium" style={{ color: getPlatformColor(card.type) }}>
                          {post.authorHandle ?? post.author}
                        </span>
                        {post.upvotes !== undefined ? (
                          <span>▲ {post.upvotes}</span>
                        ) : null}
                      </div>
                      <p className="leading-relaxed">{post.text}</p>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    显示 {card.threadSnapshot.posts.length} / {card.threadSnapshot.totalPosts} 条 ·
                    采集于 {relativeTime(card.threadSnapshot.capturedAt)}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  本次采集未包含线程快照。在 Popup 中勾选"展开线程"可在下次采集时保存。
                </p>
              )}
            </DrawerSection>
          ) : null}

          {/* ── 标签（按维度分组） ── */}
          <DrawerSection title={`标签 ${cardTags.length}`} action={
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => onAiRetag?.(card.id)}
            >
              AI 重新打标
            </button>
          }>
            {(() => {
              const dimGroups = new Map<HoardlyTagDimension | "other", HoardlyTag[]>();
              for (const t of cardTags) {
                const dim = t.dimension ?? "other";
                if (!dimGroups.has(dim)) dimGroups.set(dim, []);
                dimGroups.get(dim)!.push(t);
              }
              const dimOrder: Array<HoardlyTagDimension | "other"> = ["topic", "entity", "method", "useCase", "domain", "other"];
              return dimOrder.filter((d) => dimGroups.has(d)).map((dim) => (
                <div key={dim} className="mb-3">
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {dim === "other" ? "其他" : TAG_DIMENSION_LABELS[dim]?.zh ?? dim}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {dimGroups.get(dim)!.map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title="点击移除标签"
                        onClick={() =>
                          onUpdateCard(card.id, { tagIds: card.tagIds.filter((tagId) => tagId !== tag.id) })
                        }
                      >
                        <TagPill origin={tag.origin}>#{localized(tag.labels, locale, tag.slug)} ×</TagPill>
                      </button>
                    ))}
                  </div>
                </div>
              ));
            })()}
            <div className="mt-3 flex gap-2">
              <FilterSelect
                label="添加已有标签"
                value={tagToAdd || "none"}
                options={[
                  { label: "选择标签", value: "none" },
                  ...tags
                    .filter((tag) => !card.tagIds.includes(tag.id))
                    .map((tag) => ({
                      label: `#${localized(tag.labels, locale, tag.slug)}${tag.dimension ? ` [${tag.dimension}]` : ""}`,
                      value: tag.id,
                    })),
                ]}
                onChange={(value) => {
                  if (value === "none") return;
                  onUpdateCard(card.id, { tagIds: Array.from(new Set([...card.tagIds, value])) });
                  setTagToAdd("");
                }}
              />
            </div>
            <form className="mt-2 flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).elements.namedItem("newTag") as HTMLInputElement;
              const raw = input.value.trim();
              if (!raw) return;
              const slug = raw.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9\u4e00-\u9fa5-]/g, "").slice(0, 60);
              if (!slug) return;
              const existing = tags.find((t) => t.slug === slug);
              if (existing) {
                onUpdateCard(card.id, { tagIds: Array.from(new Set([...card.tagIds, existing.id])) });
              } else {
                onCreateTag?.(slug, raw, card.id);
              }
              input.value = "";
            }}>
              <Input name="newTag" placeholder="输入新标签名…" className="h-8 text-xs" />
              <Button type="submit" size="sm" variant="outline" className="h-8 shrink-0 text-xs">创建</Button>
            </form>
          </DrawerSection>

          {/* ── 项目 ── */}
          <DrawerSection title="项目">
            <div className="space-y-2">
              {projects
                .filter((project) => project.status === "active")
                .map((project) => (
                  <label
                    key={project.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm cursor-pointer hover:bg-accent transition-colors"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: project.color }} />
                      <span className="truncate">{project.name}</span>
                    </span>
                    <input
                      checked={card.projectIds.includes(project.id)}
                      type="checkbox"
                      className="accent-primary"
                      onChange={(event) => onSetProjectMembership(card.id, project.id, event.target.checked)}
                    />
                  </label>
                ))}
              {cardProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground">未加入项目。</p>
              ) : null}
            </div>
          </DrawerSection>

          {/* ── 高亮 ── */}
          {card.highlights.length > 0 ? (
            <DrawerSection title={`高亮 ${card.highlights.length}`}>
              <div className="space-y-2">
                {card.highlights.map((highlight) => (
                  <div key={highlight.id} className="rounded-lg border-l-4 border-primary/50 bg-primary/5 p-3">
                    <p className="text-sm italic">&ldquo;{highlight.quoteText}&rdquo;</p>
                    {highlight.noteText ? (
                      <p className="mt-2 text-xs text-muted-foreground">— {highlight.noteText}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </DrawerSection>
          ) : null}

          {/* ── 笔记（编辑/预览切换）── */}
          <DrawerSection
            title="笔记"
            action={
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setNoteMode((m) => (m === "edit" ? "preview" : "edit"))}
              >
                {noteMode === "edit" ? "预览" : "编辑 (E)"}
              </button>
            }
          >
            {noteMode === "edit" ? (
              <Textarea
                ref={noteRef}
                aria-label="编辑笔记"
                placeholder="添加私人笔记（支持 Markdown）…"
                className="min-h-28 resize-y font-mono text-sm"
                value={card.noteMarkdown ?? ""}
                onChange={(event) => onUpdateCard(card.id, { noteMarkdown: event.target.value })}
              />
            ) : (
              <div className="min-h-16 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
                {card.noteMarkdown?.trim() ? (
                  <SimpleMarkdown text={card.noteMarkdown} />
                ) : (
                  <span className="text-muted-foreground">暂无笔记。</span>
                )}
              </div>
            )}
          </DrawerSection>

          {/* ── 删除区 ── */}
          <div className="px-5 py-4">
            {card.deletedAt ? (
              <Button variant="destructive" size="sm" onClick={() => onPermanentlyDelete(card.id)}>
                永久删除
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => onSoftDelete(card.id)}>
                <Trash2 className="size-3.5" />
                移入回收站
              </Button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function BatchActionsBar({
  activeProjects,
  batchProjectId,
  batchTagId,
  locale,
  onAddProject,
  onAddTag,
  onCancel,
  onDelete,
  onExportSkill,
  onRemoveProject,
  onRemoveTag,
  onSelectAllVisible,
  onSetBatchProjectId,
  onSetBatchTagId,
  onSetStarred,
  selectedCount,
  tags,
  visibleCount,
}: {
  activeProjects: HoardlyProject[];
  batchProjectId: string;
  batchTagId: string;
  locale: HoardlyLocale;
  onAddProject: () => void;
  onAddTag: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onExportSkill: () => void;
  onRemoveProject: () => void;
  onRemoveTag: () => void;
  onSelectAllVisible: () => void;
  onSetBatchProjectId: (projectId: string) => void;
  onSetBatchTagId: (tagId: string) => void;
  onSetStarred: (starred: boolean) => void;
  selectedCount: number;
  tags: HoardlyTag[];
  visibleCount: number;
}) {
  return (
    <div className="fixed inset-x-3 bottom-4 z-40 mx-auto max-w-6xl rounded-xl border border-border bg-card p-3 shadow-xl">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground">
            已选 {selectedCount} 张
          </span>
          {selectedCount < visibleCount ? (
            <Button size="sm" variant="ghost" onClick={onSelectAllVisible}>
              选中当前结果 {visibleCount} 张
            </Button>
          ) : null}
          <Button size="icon-sm" variant="ghost" aria-label="取消选择" onClick={onCancel}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect
            label="标签"
            value={batchTagId || "none"}
            options={[
              { label: "选择标签", value: "none" },
              ...tags.map((tag) => ({
                label: `#${localized(tag.labels, locale, tag.slug)}`,
                value: tag.id,
              })),
            ]}
            onChange={(value) => onSetBatchTagId(value === "none" ? "" : value)}
          />
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onAddTag}>
            <Tags className="size-4" />
            加标签
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemoveTag}>
            移除标签
          </Button>

          <Separator className="hidden h-7 w-px xl:block" />

          <FilterSelect
            label="项目"
            value={batchProjectId || "none"}
            options={[
              { label: "选择项目", value: "none" },
              ...activeProjects.map((project) => ({
                label: project.name,
                value: project.id,
              })),
            ]}
            onChange={(value) => onSetBatchProjectId(value === "none" ? "" : value)}
          />
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onAddProject}>
            <FolderKanban className="size-4" />
            加入项目
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemoveProject}>
            移出项目
          </Button>

          <Separator className="hidden h-7 w-px xl:block" />

          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onSetStarred(true)}>
            <Star className="size-4" />
            标星
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onSetStarred(false)}>
            取消星标
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onExportSkill}>
            <Upload className="size-4" />
            导出 Skill
          </Button>
          <Button size="sm" variant="destructive" className="gap-1.5" onClick={onDelete}>
            <Trash2 className="size-4" />
            删除
          </Button>
        </div>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value }: { icon: typeof Inbox; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="rounded-xl bg-secondary p-2">
          <Icon className="size-5" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-xl font-semibold">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function SettingsCard({
  children,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  icon: typeof Inbox;
  title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-5" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function EmptyState({
  actionLabel,
  description,
  onAction,
  title,
}: {
  actionLabel?: string;
  description: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-64 flex-col items-center justify-center p-8 text-center">
        <Database className="mb-3 size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>
        {actionLabel && onAction ? (
          <Button className="mt-4" onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FilterSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        className="bg-transparent text-sm outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DrawerSection({
  action,
  children,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="px-5 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {action ? <div>{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function SidebarLabel({ label }: { label: string }) {
  return <p className="px-3 text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</p>;
}

function TagPill({ children, origin, ...rest }: { children: React.ReactNode; origin: HoardlyTag["origin"] } & React.HTMLAttributes<HTMLSpanElement>) {
  const className =
    origin === "user"
      ? "border-border bg-background"
      : origin === "project"
        ? "border-primary/30 bg-primary/10"
        : origin === "system"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-transparent bg-secondary";
  return (
    <span className={`rounded-md border px-2 py-1 text-[11px] leading-none ${className}`} {...rest}>
      {children}
    </span>
  );
}

function StatusPill({
  failReason,
  status,
  storage,
}: {
  failReason?: HoardlyCard["parseFailReason"];
  status: HoardlyCard["parseStatus"];
  storage: HoardlyCard["storageLocation"];
}) {
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-1.5 py-1">
        <Loader2 className="size-3 animate-spin" />
        分析中
      </span>
    );
  }
  if (status === "failed") {
    const label = failReason ? PARSE_FAIL_LABELS[failReason] : "解析失败";
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-1 text-destructive"
        title={failReason ? PARSE_FAIL_HINTS[failReason] : "解析失败，请重试或手动补充内容。"}
      >
        <AlertTriangle className="size-3" />
        {label}
      </span>
    );
  }
  if (storage === "local") return <span className="rounded-md bg-secondary px-1.5 py-1">本地文件</span>;
  if (storage === "hybrid") return <span className="rounded-md bg-secondary px-1.5 py-1">混合</span>;
  return <span className="rounded-md bg-secondary px-1.5 py-1">云端</span>;
}

function sectionTitle(section: AppSection) {
  return navItems.find((item) => item.id === section)?.label ?? "Hoardly";
}

function localized(value: HoardlyTag["labels"] | undefined, locale: HoardlyLocale, fallback = "") {
  return value?.[locale] ?? value?.en ?? fallback;
}

function findTag(tags: HoardlyTag[], tagId: string) {
  return tags.find((tag) => tag.id === tagId);
}

function sortCards(cards: HoardlyCard[], sortMode: HoardlySortMode) {
  return [...cards].sort((a, b) => {
    if (sortMode === "recent") {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    }

    if (sortMode === "lastViewed") {
      // Cards never opened fall to the bottom; among opened, sort by most recent
      const aTime = a.lastOpenedAt ? new Date(a.lastOpenedAt).getTime() : 0;
      const bTime = b.lastOpenedAt ? new Date(b.lastOpenedAt).getTime() : 0;
      if (aTime === bTime) {
        // Tiebreak: more recently saved wins
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return bTime - aTime;
    }

    // "smart" — composite score
    const score = (card: HoardlyCard) => {
      const ageDays = (Date.now() - new Date(card.createdAt).getTime()) / (24 * 60 * 60 * 1000);
      const freshness = Math.max(0, 1 - ageDays / 7);
      const activeProjectBoost = card.projectIds.length > 0 ? 0.3 : 0;
      const openedBoost = card.lastOpenedAt ? 0.2 : 0;
      const starredBoost = card.starred ? 0.5 : 0;
      return freshness * 0.35 + activeProjectBoost + openedBoost + starredBoost * 0.15;
    };

    return score(b) - score(a);
  });
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(1, Math.round(diffMs / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/** Highlight query matches inside text with a <mark> element */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="rounded bg-primary/20 px-0.5 text-primary">{part}</mark>
    ) : (
      part
    ),
  );
}

/** Very minimal Markdown → JSX renderer: bold, italic, inline code, line breaks */
function SimpleMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        // heading
        if (/^#{1,3} /.test(line)) {
          const level = (line.match(/^(#+)/)![1] ?? "").length;
          const content = line.replace(/^#+\s+/, "");
          const cls = level === 1 ? "text-base font-bold" : level === 2 ? "text-sm font-semibold" : "text-sm font-medium";
          return <p key={i} className={cls}>{inlineFormat(content)}</p>;
        }
        // bullet
        if (/^[-*] /.test(line)) {
          return <p key={i} className="pl-3 before:content-['•'] before:mr-1.5 before:text-muted-foreground">{inlineFormat(line.slice(2))}</p>;
        }
        // empty line
        if (!line.trim()) return <br key={i} />;
        return <p key={i}>{inlineFormat(line)}</p>;
      })}
    </div>
  );
}

function inlineFormat(text: string): React.ReactNode {
  // Split by **bold**, *italic*, `code`
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (/^\*\*/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\*/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    if (/^`/.test(part)) return <code key={i} className="rounded bg-muted px-1 font-mono text-xs">{part.slice(1, -1)}</code>;
    return part;
  });
}

function readStoredSortMode(): HoardlySortMode {
  const stored = window.localStorage.getItem("hoardly:sort-mode");
  if (stored === "smart") return "smart";
  if (stored === "lastViewed") return "lastViewed";
  return "recent";
}

function summarizeTags(cards: HoardlyCard[], tags: HoardlyTag[], locale: HoardlyLocale) {
  const counts = new Map<string, number>();
  for (const card of cards) {
    for (const tagId of card.tagIds) {
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tagId, count]) => ({
      label: localized(findTag(tags, tagId)?.labels, locale, tagId),
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

function buildAiCitations(
  cards: HoardlyCard[],
  tags: HoardlyTag[],
  locale: HoardlyLocale,
  query: string,
): AiCitation[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return cards
    .map((card, index) => {
      const title = localized(card.titleI18n, locale, card.titleOriginal);
      const summary = localized(card.summary, locale);
      const tagLabels = card.tagIds
        .map((tagId) => localized(findTag(tags, tagId)?.labels, locale))
        .filter(Boolean);
      const fieldValues = [
        { label: "标题", value: title, weight: 5 },
        { label: "摘要", value: summary, weight: 3 },
        { label: "标签", value: tagLabels.join(" "), weight: 3 },
        { label: "平台", value: card.sourcePlatform, weight: 2 },
        { label: "URL", value: card.url ?? "", weight: 1 },
      ];

      const matchedFields = new Set<string>();
      let score = terms.length === 0 ? Math.max(1, 5 - index) : 0;

      for (const term of terms) {
        for (const field of fieldValues) {
          if (field.value.toLowerCase().includes(term)) {
            matchedFields.add(field.label);
            score += field.weight;
          }
        }
      }

      if (card.projectIds.length > 0) score += 1;
      if (card.starred) score += 1;

      return {
        card,
        matchedFields: matchedFields.size > 0 ? Array.from(matchedFields) : ["智能排序"],
        score,
        snippet: pickCitationSnippet(title, summary, card.url, terms),
      };
    })
    .filter((citation) => terms.length === 0 || citation.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.card.createdAt).getTime() - new Date(a.card.createdAt).getTime());
}

function pickCitationSnippet(title: string, summary: string, url: string | undefined, terms: string[]) {
  const candidates = [summary, title, url ?? ""].filter(Boolean);
  if (terms.length === 0) return candidates[0] ?? "该卡片可作为回答来源。";

  const matched = candidates.find((candidate) =>
    terms.some((term) => candidate.toLowerCase().includes(term)),
  );
  return matched || candidates[0] || "该卡片可作为回答来源。";
}

function iconForType(type: HoardlyCardType) {
  if (type === "youtube" || type === "bilibili" || type === "video" || type === "douyin" || type === "tiktok") {
    return Video;
  }
  if (type === "image" || type === "instagram" || type === "pinterest" || type === "xhs") return Image;
  if (type === "note") return FileText;
  if (type === "pdf" || type === "doc") return FileText;
  if (type === "reddit" || type === "tweet" || type === "threads" || type === "facebook" || type === "linkedin") {
    return Globe2;
  }
  return Link2;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HoardlyWebApp />
  </React.StrictMode>,
);
