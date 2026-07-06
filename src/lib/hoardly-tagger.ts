import type {
  HoardlyCard,
  HoardlyTag,
  HoardlyTagDimension,
  TagGenerationResult,
} from "../types/hoardly";
import {
  TAG_BLACKLIST_PROMPT_SECTION,
  findExistingTagBySlug,
  isTagTooGeneric,
  sanitizeSlug,
} from "./hoardly-tag-blacklist";

const ALL_DIMENSIONS: HoardlyTagDimension[] = ["topic", "entity", "method", "useCase", "domain"];

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildSystemPrompt(existingTags: HoardlyTag[]): string {
  const tagLibraryLines = existingTags
    .slice(0, 1000)
    .map((t) => `  ${t.slug}`)
    .join("\n");

  return `你是 Hoardly 的精准标签引擎。你必须为用户收藏的每一条内容生成恰好 20 个高区分度标签。

## 硬性要求
- 总共必须恰好 20 个标签，分布在 5 个维度中
- 每个标签必须能把这条内容从 1000 张卡片中区分出来
- 如果一个标签在任何网页上都适用，它就是垃圾标签——绝对不要生成
- 标签 slug 必须是英文小写 slug 风格（如 react-server-components），不能是中文
- 优先复用"已有标签库"中的标签（slug 完全一致即复用），标签池有上千个标签可供选择

## 5 个维度（每个维度恰好 4 个标签，共 20 个）

### topic (核心主题, 恰好 4 个)
这篇内容具体在讲什么技术概念或具体话题。越细越好。
好: hybrid-search, react-server-components, prompt-engineering, kv-cache-eviction
坏: 技术, AI, 编程, development

### entity (命名实体, 恰好 4 个)
提到的关键工具、产品、框架、人物、组织、项目名。如果不足 4 个显式提及，扩展到上下文相关的实体。
好: Supabase, pgvector, Andrej-Karpathy, OpenAI
坏: 公司, 工具, 框架, database

### method (方法/技术手段, 恰好 4 个)
讨论了什么方法论、算法、架构模式或实现技术。
好: RAG-pipeline, vector-indexing, few-shot-prompting, HNSW-index
坏: 方法, 实现, 算法, approach

### useCase (用途场景, 恰好 4 个)
用户将来会在什么场景下回来找这个内容。想象搜索意图。
好: architecture-reference, code-snippet, benchmark-data, api-documentation
坏: 参考, 学习, 有用, reading

### domain (所属领域, 恰好 4 个)
属于什么垂直专业领域和子领域。
好: NLP, frontend-engineering, distributed-systems, information-retrieval
坏: 技术, IT, 互联网, software

${TAG_BLACKLIST_PROMPT_SECTION}

## 用户已有标签库（优先复用，共 ${existingTags.length} 个）
${tagLibraryLines || "(空)"}

## 输出格式
必须只输出一个 JSON 对象，不要加任何解释、markdown 或代码块标记。
每个维度恰好 4 个 slug，共 20 个。
{
  "topic": ["slug1", "slug2", "slug3", "slug4"],
  "entity": ["slug1", "slug2", "slug3", "slug4"],
  "method": ["slug1", "slug2", "slug3", "slug4"],
  "useCase": ["slug1", "slug2", "slug3", "slug4"],
  "domain": ["slug1", "slug2", "slug3", "slug4"],
  "newLabels": {
    "slug-not-in-library": { "en": "English Label", "zh-CN": "中文标签" }
  }
}

newLabels 只包含标签库中不存在的新 slug。已有的不需要重复。`;
}

function buildUserPrompt(input: TaggerInput): string {
  const parts: string[] = [];
  parts.push(`标题: ${input.title}`);
  if (input.url) parts.push(`URL: ${input.url}`);
  if (input.platform) parts.push(`平台: ${input.platform}`);
  if (input.authorHandle) parts.push(`作者: ${input.authorHandle}`);
  if (input.subreddit) parts.push(`子版块: ${input.subreddit}`);
  if (input.summary) parts.push(`摘要: ${input.summary}`);
  if (input.bodyText) parts.push(`正文片段:\n${input.bodyText.slice(0, 6000)}`);
  return parts.join("\n");
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaggerInput = {
  title: string;
  url?: string;
  platform?: string;
  authorHandle?: string;
  subreddit?: string;
  summary?: string;
  bodyText?: string;
};

export type TaggerResult = {
  newTags: HoardlyTag[];
  tagIds: string[];
};

// ─── LLM call ────────────────────────────────────────────────────────────────

const GROQ_API_KEY = "gsk_placeholder";

function getGroqApiKey(): string | null {
  if (typeof window !== "undefined") {
    return window.localStorage.getItem("hoardly:groq-api-key") || null;
  }
  return null;
}

async function callLlm(
  systemPrompt: string,
  userPrompt: string,
): Promise<TagGenerationResult | null> {
  const apiKey = getGroqApiKey();
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as TagGenerationResult;

    if (!parsed.topic || !Array.isArray(parsed.topic)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Post-processing ─────────────────────────────────────────────────────────

function processLlmResult(
  result: TagGenerationResult,
  existingTags: HoardlyTag[],
  allCards: HoardlyCard[],
): TaggerResult {
  const tagIds: string[] = [];
  const newTags: HoardlyTag[] = [];
  const seenSlugs = new Set<string>();

  for (const dim of ALL_DIMENSIONS) {
    const slugs = result[dim];
    if (!Array.isArray(slugs)) continue;

    for (const rawSlug of slugs) {
      const slug = sanitizeSlug(String(rawSlug));
      if (!slug || seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);

      if (isTagTooGeneric(slug, allCards, existingTags)) continue;

      const existing = findExistingTagBySlug(slug, existingTags);
      if (existing) {
        if (!existing.dimension && dim) {
          existing.dimension = dim;
        }
        tagIds.push(existing.id);
      } else {
        const labels = result.newLabels?.[slug];
        const newTag: HoardlyTag = {
          id: `tag-${slug}`,
          slug,
          labels: {
            en: labels?.en ?? slug.replace(/-/g, " "),
            "zh-CN": labels?.["zh-CN"] ?? slug.replace(/-/g, " "),
          },
          origin: "ai",
          dimension: dim,
          usageCount: 0,
        };
        newTags.push(newTag);
        tagIds.push(newTag.id);
      }
    }
  }

  return { newTags, tagIds };
}

// ─── Content-aware tag extraction ────────────────────────────────────────────

const SITE_NAME_SUFFIXES = [
  "powered by discuz!", "powered by", "官方网站", "官网", "首页",
  "home", "blog", "博客", "论坛", "社区", "网站",
];

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "and", "or", "but", "if", "then", "else", "when", "at", "from", "by",
  "on", "off", "for", "in", "out", "over", "to", "into", "with", "of",
  "this", "that", "these", "those", "it", "its", "my", "your", "our",
  "his", "her", "their", "not", "no", "nor", "so", "too", "very",
  "just", "about", "up", "down", "here", "there", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such",
  "than", "also", "how", "what", "which", "who", "whom", "why", "where",
  "new", "get", "use", "see", "try", "let", "set", "run", "way",
  "best", "top", "like", "make", "take", "come", "give", "look",
  "find", "know", "want", "tell", "work", "call", "keep", "help",
  "start", "show", "hear", "play", "move", "live", "believe",
  "bring", "happen", "write", "provide", "sit", "stand", "lose",
  "pay", "meet", "include", "continue", "learn", "change", "lead",
  "understand", "watch", "follow", "stop", "create", "speak", "read",
  "allow", "add", "spend", "grow", "open", "walk", "win", "offer",
  "think", "decide", "compare", "track", "swipe", "daily", "picks",
  "confidence", "using", "used", "based", "built", "made",
  "com", "org", "net", "www", "http", "https", "html", "php", "asp",
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都",
  "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你",
  "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它",
  "们", "吗", "吧", "呢", "啊", "哦", "嗯", "呀", "啦",
  "目前", "可以", "如何", "什么", "这个", "那个", "一些", "已经",
  "因为", "所以", "但是", "而且", "或者", "如果", "虽然", "不过",
  "其实", "应该", "已经", "可能", "需要", "通过", "进行", "使用",
  "关于", "以及", "其他", "之后", "之前", "还是", "比较", "非常",
  "为了", "只是", "就是", "然后", "现在", "最新", "分享",
]);

/**
 * Split title into content segments, removing site name and boilerplate.
 * "数字移民-尼日利亚开通/转区YouTube会员教程 - 兔哥博客" →
 *   ["数字移民", "尼日利亚开通", "转区YouTube会员教程"]
 */
function extractTitleSegments(title: string): string[] {
  const mainParts = title.split(/\s*[|\-–—·]\s*/);

  // The last segment is often the site name — remove it if title has 2+ parts
  if (mainParts.length >= 2) {
    const last = mainParts[mainParts.length - 1].toLowerCase();
    const isSiteName = SITE_NAME_SUFFIXES.some((s) => last.includes(s))
      || /^[a-z0-9]+\.(com|org|net|io|co|dev)$/i.test(last.trim())
      || last.length <= 6;
    if (isSiteName) mainParts.pop();
  }

  const segments: string[] = [];
  for (const part of mainParts) {
    const subs = part.split(/[/／,，、:：]+/).map((s) => s.trim()).filter(Boolean);
    segments.push(...subs);
  }
  return segments.filter((s) => s.length >= 2);
}

/**
 * Extract keyword phrases from Chinese + English mixed text.
 * Uses boundary detection: CJK runs, capitalized English words/phrases, quoted terms.
 */
function extractKeyPhrases(text: string): string[] {
  if (!text) return [];
  const phrases: string[] = [];

  // Extract CJK word groups (2-8 chars)
  const cjkRuns = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,8}/g);
  if (cjkRuns) phrases.push(...cjkRuns);

  // Extract English words (3+ chars, not stopwords)
  const engWords = text.match(/[a-zA-Z]{3,}/g);
  if (engWords) {
    for (const w of engWords) {
      if (!STOPWORDS.has(w.toLowerCase()) && w.length >= 3) phrases.push(w);
    }
  }

  // Extract multi-word English phrases (Title Case sequences)
  const engPhrases = text.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g);
  if (engPhrases) phrases.push(...engPhrases);

  // Extract uppercase abbreviations (API, DeFi, CEX, etc.)
  const abbrevs = text.match(/\b[A-Z][A-Za-z]*[A-Z]+[a-z]*\b/g);
  if (abbrevs) phrases.push(...abbrevs.filter((t) => t.length >= 2 && t.length <= 10));

  // Extract quoted/bracketed terms
  const quoted = text.match(/[「」【】《》""'']+([^「」【】《》""'']+)[「」【】《》""'']+/g);
  if (quoted) phrases.push(...quoted.map((q) => q.replace(/[「」【】《》""'']/g, "").trim()));

  return phrases.filter((p) => p.length >= 2 && p.length <= 30);
}

/**
 * From a description, extract the most descriptive noun phrases.
 */
function extractDescriptionTags(desc: string): string[] {
  if (!desc) return [];
  const phrases: string[] = [];

  // Split on sentence boundaries
  const sentences = desc.split(/[。！？.!?\n]+/).filter(Boolean);
  for (const sentence of sentences.slice(0, 3)) {
    phrases.push(...extractKeyPhrases(sentence));
  }

  return phrases;
}

function slugifyTag(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u4e00-\u9fff\u3400-\u4dbf-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isValidTag(label: string): boolean {
  if (label.length < 2 || label.length > 30) return false;
  if (STOPWORDS.has(label.toLowerCase())) return false;
  if (/^\d+$/.test(label)) return false;
  if (/^[a-z]{1,3}$/i.test(label)) return false;
  return true;
}

export function generateLocalTags(
  input: TaggerInput,
  existingTags: HoardlyTag[],
): TaggerResult {
  const tagLabels: string[] = [];
  const seen = new Set<string>();

  const addTag = (label: string) => {
    const clean = label.trim();
    if (!isValidTag(clean)) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tagLabels.push(clean);
  };

  // 1. Extract from title (most important source)
  if (input.title) {
    const segments = extractTitleSegments(input.title);
    for (const seg of segments) {
      // Add the whole segment as a tag if it's short enough
      if (seg.length >= 2 && seg.length <= 20) addTag(seg);
      // Also extract sub-phrases
      for (const phrase of extractKeyPhrases(seg)) {
        addTag(phrase);
      }
    }
  }

  // 2. Extract from description/summary
  if (input.summary) {
    const descTags = extractDescriptionTags(input.summary);
    for (const tag of descTags) {
      addTag(tag);
    }
  }
  if (input.bodyText) {
    const bodyTags = extractDescriptionTags(input.bodyText.slice(0, 500));
    for (const tag of bodyTags) {
      addTag(tag);
    }
  }

  // 3. Platform-specific domain tag (only for well-known sites)
  if (input.url) {
    try {
      const host = new URL(input.url).hostname.replace(/^www\./, "").toLowerCase();
      const KNOWN_PLATFORMS: Record<string, string> = {
        "github.com": "GitHub", "youtube.com": "YouTube", "youtu.be": "YouTube",
        "twitter.com": "Twitter", "x.com": "X/Twitter", "reddit.com": "Reddit",
        "instagram.com": "Instagram", "facebook.com": "Facebook",
        "linkedin.com": "LinkedIn", "medium.com": "Medium",
        "zhihu.com": "知乎", "bilibili.com": "B站",
        "xiaohongshu.com": "小红书", "juejin.cn": "掘金",
        "mp.weixin.qq.com": "微信公众号", "douyin.com": "抖音",
        "pinterest.com": "Pinterest", "figma.com": "Figma",
        "notion.so": "Notion", "substack.com": "Substack",
        "producthunt.com": "Product Hunt", "dribbble.com": "Dribbble",
        "stackoverflow.com": "Stack Overflow",
        "arxiv.org": "arXiv", "huggingface.co": "Hugging Face",
      };
      for (const [domain, label] of Object.entries(KNOWN_PLATFORMS)) {
        if (host.includes(domain)) { addTag(label); break; }
      }
    } catch { /* ignore */ }
  }

  // 4. Author/subreddit if available
  if (input.authorHandle) addTag(input.authorHandle.replace(/^@/, ""));
  if (input.subreddit) addTag(input.subreddit);

  // Convert to tag objects
  const tagIds: string[] = [];
  const newTags: HoardlyTag[] = [];

  for (const label of tagLabels.slice(0, 20)) {
    const slug = slugifyTag(label);
    if (!slug) continue;

    const existing = existingTags.find((t) =>
      t.slug === slug || t.labels?.["zh-CN"] === label || t.labels?.en === label,
    );

    if (existing) {
      if (!tagIds.includes(existing.id)) tagIds.push(existing.id);
    } else {
      const id = `tag-${slug}`;
      if (tagIds.includes(id)) continue;
      newTags.push({
        id,
        slug,
        labels: { en: label, "zh-CN": label },
        origin: "ai" as const,
        dimension: "topic" as const,
        usageCount: 0,
      });
      tagIds.push(id);
    }
  }

  return { newTags, tagIds };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate tags for a piece of content using the multi-dimension LLM tagger.
 * Falls back to URL-based heuristics if no API key is configured or LLM fails.
 */
export async function generateTags(
  input: TaggerInput,
  existingTags: HoardlyTag[],
  allCards: HoardlyCard[],
): Promise<TaggerResult> {
  const systemPrompt = buildSystemPrompt(existingTags);
  const userPrompt = buildUserPrompt(input);

  const result = await callLlm(systemPrompt, userPrompt);
  if (result) {
    const processed = processLlmResult(result, existingTags, allCards);
    if (processed.tagIds.length >= 15) return processed;
  }

  // Fallback
  return generateLocalTags(input, existingTags);
}

/**
 * Build TaggerInput from a HoardlyCard (for re-tagging existing cards).
 */
export function cardToTaggerInput(card: HoardlyCard): TaggerInput {
  return {
    title: card.titleOriginal,
    url: card.url,
    platform: card.sourcePlatform,
    authorHandle: card.authorHandle,
    subreddit: card.subreddit,
    summary: card.summary.en ?? card.summary["zh-CN"],
    bodyText: card.noteMarkdown,
  };
}

// ─── Tag Pool Maintenance ────────────────────────────────────────────────────

export type TagPoolMaintenanceResult = {
  added: string[];
  merged: Array<{ from: string; into: string }>;
  removed: string[];
  poolSize: number;
};

const TAG_POOL_MAINTENANCE_PROMPT = `你是 Hoardly 的标签池维护引擎。用户的收藏库目前有一批卡片和标签。
你的任务是分析整体收藏趋势，优化标签池，目标池大小为 500-1000 个标签。

## 输入
你会收到：
1. 当前标签池的所有 slug（含使用次数）
2. 最近收藏卡片的标题和 URL 样本

## 你需要做三件事

### 1. 建议新增标签（suggest_add）
分析收藏趋势，发现标签池中缺少但卡片内容频繁涉及的主题、实体、方法。
每个新标签需要给出 slug + en + zh-CN label。

### 2. 建议合并标签（suggest_merge）
找出语义重复或高度相似的标签对，建议合并（保留更好的那个）。

### 3. 建议移除标签（suggest_remove）
使用次数为 0 且不太可能被未来内容使用的标签，建议移除。

## 输出格式（JSON）
{
  "add": [{ "slug": "...", "en": "...", "zh": "...", "dimension": "topic|entity|method|useCase|domain" }],
  "merge": [{ "from": "slug-to-remove", "into": "slug-to-keep" }],
  "remove": ["slug1", "slug2"]
}`;

/**
 * Run periodic tag pool maintenance.
 * Analyzes the library's collection trends and suggests pool updates.
 */
export async function maintainTagPool(
  existingTags: HoardlyTag[],
  allCards: HoardlyCard[],
): Promise<TagPoolMaintenanceResult> {
  const activeCards = allCards.filter((c) => !c.deletedAt);
  const tagUsage = new Map<string, number>();
  for (const card of activeCards) {
    for (const tagId of card.tagIds) {
      tagUsage.set(tagId, (tagUsage.get(tagId) ?? 0) + 1);
    }
  }

  const poolLines = existingTags
    .map((t) => `${t.slug} (${tagUsage.get(t.id) ?? 0} cards)`)
    .join("\n");

  const recentSample = activeCards
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map((c) => `- ${c.titleOriginal}${c.url ? ` (${c.url})` : ""}`)
    .join("\n");

  try {
    const response = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: TAG_POOL_MAINTENANCE_PROMPT },
          { role: "user", content: `## 当前标签池（${existingTags.length} 个）\n${poolLines}\n\n## 最近收藏样本\n${recentSample}` },
        ],
        temperature: 0.2,
        max_tokens: 3000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) return { added: [], merged: [], removed: [], poolSize: existingTags.length };

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return { added: [], merged: [], removed: [], poolSize: existingTags.length };

    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned) as {
      add?: Array<{ slug: string; en: string; zh: string; dimension?: string }>;
      merge?: Array<{ from: string; into: string }>;
      remove?: string[];
    };

    return {
      added: (parsed.add ?? []).map((a) => a.slug),
      merged: parsed.merge ?? [],
      removed: parsed.remove ?? [],
      poolSize: existingTags.length + (parsed.add?.length ?? 0) - (parsed.remove?.length ?? 0),
    };
  } catch {
    return { added: [], merged: [], removed: [], poolSize: existingTags.length };
  }
}

/**
 * Apply tag pool maintenance results to the library.
 */
export function applyTagPoolMaintenance(
  tags: HoardlyTag[],
  cards: HoardlyCard[],
  result: { add?: Array<{ slug: string; en: string; zh: string; dimension?: string }>; merge?: Array<{ from: string; into: string }>; remove?: string[] },
): { tags: HoardlyTag[]; cards: HoardlyCard[] } {
  let updatedTags = [...tags];
  let updatedCards = [...cards];

  // Add new tags
  for (const item of result.add ?? []) {
    const slug = sanitizeSlug(item.slug);
    if (!slug || updatedTags.some((t) => t.slug === slug)) continue;
    updatedTags.push({
      id: `tag-${slug}`,
      slug,
      labels: { en: item.en, "zh-CN": item.zh },
      origin: "ai",
      dimension: (item.dimension as HoardlyTagDimension) ?? undefined,
      usageCount: 0,
    });
  }

  // Merge tags
  for (const { from, into } of result.merge ?? []) {
    const fromTag = updatedTags.find((t) => t.slug === from);
    const intoTag = updatedTags.find((t) => t.slug === into);
    if (!fromTag || !intoTag) continue;
    updatedCards = updatedCards.map((card) => {
      if (!card.tagIds.includes(fromTag.id)) return card;
      const newIds = card.tagIds.filter((id) => id !== fromTag.id);
      if (!newIds.includes(intoTag.id)) newIds.push(intoTag.id);
      return { ...card, tagIds: newIds };
    });
    updatedTags = updatedTags.filter((t) => t.id !== fromTag.id);
  }

  // Remove unused tags
  for (const slug of result.remove ?? []) {
    const tag = updatedTags.find((t) => t.slug === slug);
    if (!tag) continue;
    const isUsed = updatedCards.some((c) => c.tagIds.includes(tag.id));
    if (!isUsed) {
      updatedTags = updatedTags.filter((t) => t.id !== tag.id);
    }
  }

  return { tags: updatedTags, cards: updatedCards };
}
