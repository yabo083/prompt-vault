import type { AutoplayOptionsType } from "embla-carousel-autoplay";

export type CarouselPreferences = {
  autoplay: boolean;
  delayMs: number;
  pauseOnHover: boolean;
  loop: boolean;
};

export type LibraryPreferences = CarouselPreferences & {
  includeDraftAssets: boolean;
};

export type CarouselSlide = {
  id: string;
  note: string;
  previewUrl: string;
};

type CarouselSource = {
  title: string;
  representatives: Array<{ id: number; note: string; previewUrl: string; sha256: string }>;
  draftResults: Array<{ previewUrl: string; sha256: string }>;
};

const storageKey = "prompt-vault-library";

export const defaultCarouselPreferences: CarouselPreferences = {
  autoplay: true,
  delayMs: 2800,
  pauseOnHover: false,
  loop: true,
};

export const defaultLibraryPreferences: LibraryPreferences = {
  ...defaultCarouselPreferences,
  includeDraftAssets: true,
};

function finiteNumber(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

export function normalizeLibraryPreferences(value: unknown): LibraryPreferences {
  const candidate = value && typeof value === "object" ? value as Partial<LibraryPreferences> : {};
  return {
    ...normalizeCarouselPreferences(candidate),
    includeDraftAssets: typeof candidate.includeDraftAssets === "boolean" ? candidate.includeDraftAssets : defaultLibraryPreferences.includeDraftAssets,
  };
}

export function normalizeCarouselPreferences(value: unknown): CarouselPreferences {
  const candidate = value && typeof value === "object" ? value as Partial<CarouselPreferences> : {};
  return {
    autoplay: typeof candidate.autoplay === "boolean" ? candidate.autoplay : defaultCarouselPreferences.autoplay,
    delayMs: finiteNumber(candidate.delayMs, defaultCarouselPreferences.delayMs, 1000, 10_000),
    pauseOnHover: typeof candidate.pauseOnHover === "boolean" ? candidate.pauseOnHover : defaultCarouselPreferences.pauseOnHover,
    loop: typeof candidate.loop === "boolean" ? candidate.loop : defaultCarouselPreferences.loop,
  };
}

export function loadLibraryPreferences(): LibraryPreferences {
  try {
    return normalizeLibraryPreferences(JSON.parse(localStorage.getItem(storageKey) || "{}"));
  } catch {
    return defaultLibraryPreferences;
  }
}

export function saveLibraryPreferences(preferences: LibraryPreferences) {
  localStorage.setItem(storageKey, JSON.stringify(normalizeLibraryPreferences(preferences)));
}

export function carouselAutoplayOptions(preferences: CarouselPreferences): AutoplayOptionsType {
  return {
    active: preferences.autoplay,
    delay: preferences.delayMs,
    playOnInit: preferences.autoplay,
    stopOnFocusIn: false,
    stopOnInteraction: false,
    stopOnMouseEnter: preferences.pauseOnHover,
    stopOnLastSnap: !preferences.loop,
  };
}

export function usesCarousel(urls: string[]) {
  return urls.length > 1;
}

export function buildCarouselSlides(source: CarouselSource, includeDraftAssets: boolean): CarouselSlide[] {
  const representatives = source.representatives.map((revision) => ({
    id: `revision:${revision.id}`,
    note: revision.note,
    previewUrl: revision.previewUrl,
    assetKey: revision.sha256,
  }));
  const draftAssets = source.draftResults.map((asset, index) => ({
    id: `draft:${index}`,
    note: source.title,
    previewUrl: asset.previewUrl,
    assetKey: asset.sha256,
  }));
  const candidates = representatives.length
    ? includeDraftAssets ? [...representatives, ...draftAssets] : representatives
    : includeDraftAssets ? draftAssets : draftAssets.slice(0, 1);
  const seen = new Set<string>();
  return candidates.filter((slide) => {
    const key = slide.assetKey || slide.previewUrl;
    if (!slide.previewUrl || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ assetKey: _assetKey, ...slide }) => slide);
}
