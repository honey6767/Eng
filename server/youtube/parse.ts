/** ISO 8601 기간(PT12M35S, P1DT2H 등) → 초. 라이브 예정(P0D) 등 0이면 null */
export function parseIsoDuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return null;
  const [, w, d, h, min, s] = m;
  const total =
    Number(w ?? 0) * 604800 + Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.round(Number(s ?? 0));
  return total > 0 ? total : null;
}

type Thumbs = Record<string, { url?: string } | undefined> | undefined;
export function pickThumbnail(thumbs: Thumbs): string | null {
  if (!thumbs) return null;
  for (const k of ['high', 'medium', 'standard', 'maxres', 'default']) {
    const url = thumbs[k]?.url;
    if (url) return url;
  }
  return null;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : null;
}

export interface RssFeed {
  title: string;
  author: string | null;
  entries: { videoId: string; title: string; published: string | null; thumbnailUrl: string | null; author: string | null }[];
}

/** YouTube 재생목록 RSS 피드(공식, 키 불필요) 파싱 — 최근 15개 항목만 제공됨 */
export function parsePlaylistRss(xml: string): RssFeed {
  const head = xml.split('<entry')[0];
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1];
    const thumb = e.match(/<media:thumbnail[^>]*url="([^"]+)"/);
    return {
      videoId: tag(e, 'yt:videoId') ?? '',
      title: tag(e, 'title') ?? '',
      published: tag(e, 'published'),
      thumbnailUrl: thumb ? decodeXml(thumb[1]) : null,
      author: tag(tag(e, 'author') ?? '', 'name') ?? tag(e, 'name'),
    };
  });
  return {
    title: tag(head, 'title') ?? '',
    author: tag(head, 'name'),
    entries: entries.filter((e) => e.videoId),
  };
}
