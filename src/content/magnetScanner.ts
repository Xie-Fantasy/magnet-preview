import { normalizeMagnet, type NormalizedMagnet } from '../domain/magnet';

export type MagnetOccurrenceSource = 'href' | 'text';

export interface MagnetOccurrence {
  magnet: NormalizedMagnet;
  source: MagnetOccurrenceSource;
  elementTagName: string;
  textOffset?: number;
}

export interface ScannedMagnet {
  magnet: NormalizedMagnet;
  occurrences: MagnetOccurrence[];
}

export interface ScanResult {
  occurrences: MagnetOccurrence[];
  magnets: ScannedMagnet[];
  truncated: boolean;
  truncationReason?: 'occurrence_limit' | 'text_node_limit';
}

const magnetPattern = /magnet:\?[^\s<>"']{1,8192}/gi;
const ignoredTextParents = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'TEMPLATE',
]);
export const scannerLimits = { maxOccurrences: 1_000, maxTextNodes: 10_000 };

function findMagnets(value: string): Array<{ raw: string; offset: number }> {
  const matches: Array<{ raw: string; offset: number }> = [];
  magnetPattern.lastIndex = 0;
  for (const match of value.matchAll(magnetPattern)) {
    const raw = match[0].replace(/[),.;!?]+$/, '');
    if (raw) matches.push({ raw, offset: match.index ?? 0 });
  }
  return matches;
}

function addOccurrence(
  occurrences: MagnetOccurrence[],
  raw: string,
  source: MagnetOccurrenceSource,
  element: Element,
  textOffset?: number,
  onOccurrence?: (occurrence: MagnetOccurrence, node: Node) => void,
  node: Node = element,
): void {
  if (occurrences.length >= scannerLimits.maxOccurrences) return;
  const magnet = normalizeMagnet(raw);
  if (!magnet) return;
  const occurrence: MagnetOccurrence = {
    magnet,
    source,
    elementTagName: element.tagName,
    ...(textOffset === undefined ? {} : { textOffset }),
  };
  occurrences.push(occurrence);
  onOccurrence?.(occurrence, node);
}

export function scanMagnets(
  document: Document,
  onOccurrence?: (occurrence: MagnetOccurrence, node: Node) => void,
): ScanResult {
  const occurrences: MagnetOccurrence[] = [];
  let truncationReason: ScanResult['truncationReason'];
  for (const element of document.querySelectorAll<HTMLElement>('[href]')) {
    if (occurrences.length >= scannerLimits.maxOccurrences) {
      truncationReason = 'occurrence_limit';
      break;
    }
    const href = element.getAttribute('href');
    if (!href) continue;
    for (const match of findMagnets(href))
      addOccurrence(
        occurrences,
        match.raw,
        'href',
        element,
        undefined,
        onOccurrence,
      );
  }

  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  let node: Text | null;
  let textNodes = 0;
  while ((node = walker.nextNode() as Text | null)) {
    if (occurrences.length >= scannerLimits.maxOccurrences) {
      truncationReason = 'occurrence_limit';
      break;
    }
    if (textNodes++ >= scannerLimits.maxTextNodes) {
      truncationReason = 'text_node_limit';
      break;
    }
    const parent = node.parentElement;
    if (!parent || ignoredTextParents.has(parent.tagName)) continue;
    for (const match of findMagnets(node.data)) {
      addOccurrence(
        occurrences,
        match.raw,
        'text',
        parent,
        match.offset,
        onOccurrence,
        node,
      );
    }
  }

  const byInfoHash = new Map<string, ScannedMagnet>();
  for (const occurrence of occurrences) {
    const existing = byInfoHash.get(occurrence.magnet.infoHash);
    if (existing) existing.occurrences.push(occurrence);
    else
      byInfoHash.set(occurrence.magnet.infoHash, {
        magnet: occurrence.magnet,
        occurrences: [occurrence],
      });
  }
  return {
    occurrences,
    magnets: [...byInfoHash.values()],
    truncated: truncationReason !== undefined,
    ...(truncationReason ? { truncationReason } : {}),
  };
}
