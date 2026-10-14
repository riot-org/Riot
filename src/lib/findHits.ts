import type { Item } from "../hooks/useSession";

/**
 * 查找时哪些懒加载的助手消息要先解析成真身：原文含这个词，或去掉
 * markdown 记号之后含（`foo **bar**` 渲染出来是 "foo bar"，原文里搜不到）。
 * 宁可多认一行 —— 多解析一条只是多花一点，漏认的话那条要等滚进视野
 * 才换真身，命中在那一刻失效、靠 MutationObserver 重扫补回来。
 */
export function findHits(items: Item[], query: string): Set<string> {
  const hits = new Set<string>();
  const needle = query.toLowerCase();
  if (!needle) return hits;
  for (const it of items) {
    if (it.kind !== "assistant") continue;
    const raw = it.text.toLowerCase();
    if (raw.includes(needle) || stripMarkdown(raw).includes(needle)) hits.add(it.id);
  }
  return hits;
}

/** 粗略去掉行内 markdown 记号：强调、代码、链接语法、标题 / 引用 / 表格符号。 */
export function stripMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>|\\]/g, "")
    .replace(/\s+/g, " ");
}


/**
 * 断开"连续文本"的元素：命中不能跨过它们。行内元素（strong、code、a、
 * span…）不在内 —— `**加粗**、` 渲染成 `<strong>加粗</strong>、`，跨
 * 两个文本节点，用户搜 "加粗、" 理应能找到。
 */
const BLOCK_SEL =
  "p,li,td,th,h1,h2,h3,h4,h5,h6,pre,blockquote,dt,dd,div,section,article,button,summary,tr,table";

/**
 * 在 `root` 里找出 `query` 的所有出现（不分大小写），返回可以跨文本
 * 节点的 Range。同一个块里的相邻文本节点拼起来再找；块和块之间插一个
 * 换行当隔断，所以不会拼出跨段落的假命中（查找框是单行的，搜不出换行）。
 */
export function findTextRanges(root: Node, query: string): Range[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  const doc = root.ownerDocument ?? (root as Document);
  const nodes: Text[] = [];
  /** 每个文本节点在拼接串里的起点。 */
  const starts: number[] = [];
  let hay = "";
  let lastBlock: Element | null | undefined;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n as Text;
    const block = text.parentElement?.closest(BLOCK_SEL) ?? null;
    if (lastBlock !== undefined && block !== lastBlock) hay += "\n";
    lastBlock = block;
    nodes.push(text);
    starts.push(hay.length);
    hay += text.data.toLowerCase();
  }
  /** 拼接串里的下标 → (文本节点, 节点内偏移)。`end` 时落在前一个节点的尾巴上。 */
  const locate = (pos: number, end: boolean): [Text, number] | null => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const s = starts[mid]!;
      if (s < pos || (!end && s === pos)) lo = mid;
      else hi = mid - 1;
    }
    const node = nodes[lo];
    return node ? [node, Math.min(pos - starts[lo]!, node.data.length)] : null;
  };
  const ranges: Range[] = [];
  let at = hay.indexOf(needle);
  while (at !== -1) {
    const a = locate(at, false);
    const b = locate(at + needle.length, true);
    if (a && b) {
      const r = doc.createRange();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
      ranges.push(r);
    }
    at = hay.indexOf(needle, at + needle.length);
  }
  return ranges;
}
