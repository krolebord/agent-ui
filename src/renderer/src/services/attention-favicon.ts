const FAVICON_SIZE = 64;
const FAVICON_BACKGROUND = "#18181b";
const FAVICON_BORDER = "#f57c21";
const FAVICON_TEXT = "#ffffff";

interface FaviconLinkSnapshot {
  link: HTMLLinkElement;
  href: string | null;
  type: string | null;
  sizes: string | null;
}

interface FaviconState {
  links: FaviconLinkSnapshot[];
  generatedLink: HTMLLinkElement | null;
}

const faviconStates = new WeakMap<Document, FaviconState>();

export function formatAttentionFaviconCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export function createAttentionFaviconDataUrl(
  count: number,
  documentRef: Document = document,
): string | null {
  if (count <= 0) {
    return null;
  }

  const canvas = documentRef.createElement("canvas");
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.beginPath();
  context.roundRect(4, 4, 56, 56, 11);
  context.fillStyle = FAVICON_BACKGROUND;
  context.fill();
  context.lineWidth = 4;
  context.strokeStyle = FAVICON_BORDER;
  context.stroke();

  const label = formatAttentionFaviconCount(count);
  const fontSize = label.length === 1 ? 38 : label.length === 2 ? 32 : 24;
  context.fillStyle = FAVICON_TEXT;
  context.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, FAVICON_SIZE / 2, FAVICON_SIZE / 2 + 1);

  return canvas.toDataURL("image/png");
}

function setAttributeOrRemove(
  element: HTMLLinkElement,
  name: "href" | "sizes" | "type",
  value: string | null,
) {
  if (value === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}

function getOrCreateFaviconState(documentRef: Document): FaviconState {
  const existing = faviconStates.get(documentRef);
  if (existing) {
    return existing;
  }

  const faviconLinks = Array.from(
    documentRef.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
  );
  let generatedLink: HTMLLinkElement | null = null;

  if (faviconLinks.length === 0) {
    generatedLink = documentRef.createElement("link");
    generatedLink.rel = "icon";
    documentRef.head.appendChild(generatedLink);
    faviconLinks.push(generatedLink);
  }

  const state = {
    links: faviconLinks.map((link) => ({
      link,
      href: link.getAttribute("href"),
      type: link.getAttribute("type"),
      sizes: link.getAttribute("sizes"),
    })),
    generatedLink,
  };
  faviconStates.set(documentRef, state);
  return state;
}

export function updateAttentionFavicon(
  count: number,
  documentRef: Document = document,
): void {
  if (count <= 0) {
    restoreAttentionFavicon(documentRef);
    return;
  }

  const dataUrl = createAttentionFaviconDataUrl(count, documentRef);
  if (!dataUrl) {
    return;
  }

  const state = getOrCreateFaviconState(documentRef);
  for (const { link } of state.links) {
    link.setAttribute("href", dataUrl);
    link.setAttribute("type", "image/png");
    link.setAttribute("sizes", `${FAVICON_SIZE}x${FAVICON_SIZE}`);
  }
}

export function restoreAttentionFavicon(
  documentRef: Document = document,
): void {
  const state = faviconStates.get(documentRef);
  if (!state) {
    return;
  }

  for (const { link, href, type, sizes } of state.links) {
    if (link === state.generatedLink) {
      link.remove();
      continue;
    }
    setAttributeOrRemove(link, "href", href);
    setAttributeOrRemove(link, "type", type);
    setAttributeOrRemove(link, "sizes", sizes);
  }

  faviconStates.delete(documentRef);
}
