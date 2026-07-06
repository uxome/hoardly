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

const LOCALE_NAMES: Record<string, string> = {
  "en": "English", "zh-CN": "简体中文", "zh-TW": "繁體中文",
  "ja": "日本語", "es": "Español", "fr": "Français",
  "de": "Deutsch", "ko": "한국어", "pt": "Português", "ar": "العربية",
};

function buildSystemPrompt(existingTags: HoardlyTag[], locale: string): string {
  const tagLibraryLines = existingTags
    .slice(0, 1000)
    .map((t) => `  ${t.slug}`)
    .join("\n");

  const langName = LOCALE_NAMES[locale] || locale;
  const isZh = locale.startsWith("zh");
  const isEn = locale === "en";

  return `You are Hoardly's precision tag engine. Generate exactly 20 high-specificity tags for each piece of content.

## Critical language rule
- The user's display language is: **${langName}** (${locale})
- ALL tag display labels (in newLabels) MUST be in **${langName}**
- Exception: proper nouns (product names, company names, person names, place names) keep their original form (e.g. "YouTube", "Supabase", "OpenAI", "React")
- ${isZh ? 'For Chinese: labels like "混合搜索", "向量索引", "前端工程" — NOT English words like "hybrid search"' : ''}
- ${isEn ? 'For English: labels like "hybrid search", "vector indexing" — NOT Chinese characters' : ''}
- slug remains English lowercase (e.g. "hybrid-search"), but the DISPLAY label in newLabels must be in ${langName}

## Hard requirements
- Exactly 20 tags across 5 dimensions
- Each tag must distinguish this content from 1000 other cards
- If a tag applies to any webpage, it's garbage — never generate it
- slug must be English lowercase slug-style (e.g. react-server-components)
- Prioritize reusing tags from the existing tag library (exact slug match)

## 5 dimensions (exactly 4 tags each, 20 total)

### topic (4 tags) — What specific concepts/topics does this content discuss?
### entity (4 tags) — Key tools, products, frameworks, people, organizations mentioned
### method (4 tags) — What methodologies, algorithms, patterns, or techniques are discussed?
### useCase (4 tags) — In what scenarios would a user search for this content?
### domain (4 tags) — What vertical/professional fields does this belong to?

${TAG_BLACKLIST_PROMPT_SECTION}

## Existing tag library (reuse when possible, ${existingTags.length} tags)
${tagLibraryLines || "(empty)"}

## Output format
Output ONLY a JSON object. No explanation, no markdown, no code fences.
{
  "topic": ["slug1", "slug2", "slug3", "slug4"],
  "entity": ["slug1", "slug2", "slug3", "slug4"],
  "method": ["slug1", "slug2", "slug3", "slug4"],
  "useCase": ["slug1", "slug2", "slug3", "slug4"],
  "domain": ["slug1", "slug2", "slug3", "slug4"],
  "newLabels": {
    "slug-not-in-library": { "en": "English Label", "${locale}": "${langName} label" }
  }
}

newLabels: only for slugs NOT in the library. Each entry MUST have "en" + "${locale}" keys. The "${locale}" value MUST be in ${langName}.`;
}

function buildUserPrompt(input: TaggerInput): string {
  const parts: string[] = [];
  if (input.title) parts.push(`标题: ${input.title}`);
  if (input.url) parts.push(`URL: ${input.url}`);
  if (input.platform) parts.push(`平台: ${input.platform}`);
  if (input.authorHandle) parts.push(`作者: ${input.authorHandle}`);
  if (input.subreddit) parts.push(`子版块: ${input.subreddit}`);
  if (input.summary) parts.push(`摘要: ${input.summary}`);
  if (input.bodyText) parts.push(`正文片段:\n${input.bodyText.slice(0, 6000)}`);
  if (parts.length === 0 || (parts.length === 1 && input.url)) {
    parts.push("请根据 URL 域名和路径推断网站内容方向，生成最可能相关的标签。");
  }
  console.log("[Hoardly Tagger] User prompt:", parts.join("\n").slice(0, 300));
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

    if (!response.ok) {
      console.warn(`[Hoardly Tagger] Groq API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) {
      console.warn("[Hoardly Tagger] Groq returned empty content");
      return null;
    }

    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    console.log("[Hoardly Tagger] LLM raw response:", cleaned.slice(0, 500));
    const parsed = JSON.parse(cleaned) as TagGenerationResult;

    if (!parsed.topic || !Array.isArray(parsed.topic)) {
      console.warn("[Hoardly Tagger] LLM response missing 'topic' array");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("[Hoardly Tagger] callLlm failed:", err);
    return null;
  }
}

// ─── Post-processing ─────────────────────────────────────────────────────────

function processLlmResult(
  result: TagGenerationResult,
  existingTags: HoardlyTag[],
  allCards: HoardlyCard[],
  locale = "zh-CN",
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
        const localeLabel = labels?.[locale as keyof typeof labels] as string | undefined;
        const enLabel = labels?.en ?? slug.replace(/-/g, " ");
        const newTag: HoardlyTag = {
          id: `tag-${slug}`,
          slug,
          labels: {
            en: enLabel,
            [locale]: localeLabel || enLabel,
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
  locale = "zh-CN",
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
      t.slug === slug || t.labels?.[locale] === label || t.labels?.en === label,
    );

    if (existing) {
      if (!tagIds.includes(existing.id)) tagIds.push(existing.id);
    } else {
      const id = `tag-${slug}`;
      if (tagIds.includes(id)) continue;
      newTags.push({
        id,
        slug,
        labels: { en: label, [locale]: label },
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
  locale = "zh-CN",
): Promise<TaggerResult> {
  const systemPrompt = buildSystemPrompt(existingTags, locale);
  const userPrompt = buildUserPrompt(input);

  const result = await callLlm(systemPrompt, userPrompt);
  if (result) {
    const processed = processLlmResult(result, existingTags, allCards, locale);
    if (processed.tagIds.length >= 5) {
      console.log(`[Hoardly Tagger] LLM produced ${processed.tagIds.length} tags`);
      if (processed.tagIds.length < 15) {
        const local = generateLocalTags(input, existingTags, locale);
        const mergedIds = [...processed.tagIds];
        const mergedNewTags = [...processed.newTags];
        for (const lt of local.newTags) {
          if (!mergedNewTags.some((t) => t.id === lt.id)) mergedNewTags.push(lt);
        }
        for (const id of local.tagIds) {
          if (!mergedIds.includes(id)) mergedIds.push(id);
        }
        return { newTags: mergedNewTags, tagIds: mergedIds.slice(0, 20) };
      }
      return processed;
    }
    console.warn(`[Hoardly Tagger] LLM only produced ${processed.tagIds.length} tags, falling back`);
  } else {
    console.warn("[Hoardly Tagger] LLM returned null, falling back to local heuristics");
  }

  return generateLocalTags(input, existingTags, locale);
}

/**
 * Build TaggerInput from a HoardlyCard (for re-tagging existing cards).
 */
const PLACEHOLDER_PATTERNS = [
  /pending parser/i,
  /ai tagging/i,
  /ai summary will be generated/i,
  /ai 摘要/i,
  /等待解析/i,
  /后续接入/i,
  /^\d{13,}$/,
];

function isPlaceholderText(text: string | undefined): boolean {
  if (!text) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(text));
}

export function cardToTaggerInput(card: HoardlyCard): TaggerInput {
  const rawTitle = card.titleOriginal;
  const rawSummary = card.summary.en ?? card.summary["zh-CN"];

  return {
    title: isPlaceholderText(rawTitle) ? "" : rawTitle,
    url: card.url,
    platform: card.sourcePlatform,
    authorHandle: card.authorHandle,
    subreddit: card.subreddit,
    summary: isPlaceholderText(rawSummary) ? "" : rawSummary,
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
