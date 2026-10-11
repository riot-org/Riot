import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { useTimedFlag } from "../hooks/useTimedFlag";
import { type MessageKey, useT } from "../i18n";
import { type Theme, useTheme } from "../theme";
import { useEscLayer } from "./Modal";

/**
 * 把 ```mermaid 围栏画成图。
 *
 * 模型已经会写 mermaid，以前当代码块原样甩出来，看起来像「只会出字」。
 * 画失败（流式还没写完、语法坏了）就退回源码 —— 有字比空白好；
 * 但之前成功过的话保留上一张图，流式期间图/源码来回切会让对话流上下跳。
 *
 * mermaid 很大，动态加载，没图的对话不付这份体积。
 * `securityLevel: "strict"`：图里的 HTML / 点击事件一律不执行。
 *
 * 配色随界面主题走。SVG 是静态的，颜色在渲染时就写死在里面，切主题不会
 * 自己变 —— 所以主题进了渲染 effect 的依赖：切换后每张已经画出来的图按新
 * 配色重画一遍（旧图挂着直到新图落地，不闪源码）。
 */

type MermaidApi = {
  initialize: (c: Record<string, unknown>) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
};

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif";

/**
 * 配色从界面主题的 CSS token 现取，不另抄一份 —— 抄的那份迟早和主题对不上
 * （之前节点是带蓝调的 #1b1d22，界面是纯灰阶，放在一起就是两套东西）。
 * mermaid 读不了 CSS 变量，所以渲染前用 getComputedStyle 解析成色值再喂。
 * 主题切换时 data-theme 先挂上、再通知订阅者，到这里读到的已经是新主题。
 *
 * 层级跟着界面走：画布是 --bg-side（比对话区沉一档），节点是浮起来的卡片
 * —— 深色里浮起来是更亮（--bg-card），浅色里是纯白（--bg）。连线退到最弱
 * 一档，让卡片是视觉主体。卡片里第一行当标题（--text、粗），其余行当说明
 * （--text-dim、小）。判断 / 起止这类「形状有含义」的节点才用强调色，一张
 * 图里处处是蓝就没有重点了。备注用 warn 那组，和界面里的提示条同色系。
 */
type Palette = {
  canvas: string;
  node: string;
  nodeBorder: string;
  title: string;
  body: string;
  line: string;
  accent: string;
  accentBorder: string;
  accentText: string;
  labelBorder: string;
  cluster: string;
  clusterBorder: string;
  note: string;
  noteBorder: string;
  shadow: string;
};

/** 读不到 token 时（测试环境、样式还没加载）的兜底，值同 styles.css。 */
const FALLBACK: Record<Theme, Record<string, string>> = {
  dark: {
    "--bg": "#181818",
    "--bg-side": "#121212",
    "--bg-card": "#212121",
    "--border": "#303030",
    "--border-strong": "#3d3d3d",
    "--text": "#ececf1",
    "--text-dim": "#a2a2ad",
    "--text-faint": "#94949f",
    "--accent-dim": "#2a3d5c",
    "--accent-border": "#3d5f94",
    "--accent-soft": "#c8d8f0",
    "--warn-bg": "#2a2214",
    "--warn-border": "#4a3a20",
  },
  light: {
    "--bg": "#ffffff",
    "--bg-side": "#f6f6f6",
    "--bg-card": "#f4f4f4",
    "--border": "#e4e4e4",
    "--border-strong": "#d0d0d0",
    "--text": "#1a1a1a",
    "--text-dim": "#5f5f68",
    "--text-faint": "#6a6a74",
    "--accent-dim": "#dfe9f7",
    "--accent-border": "#9dbae4",
    "--accent-soft": "#274d8a",
    "--warn-bg": "#fcf4e2",
    "--warn-border": "#ead6a8",
  },
};

function token(theme: Theme, name: string): string {
  const v =
    typeof document === "undefined"
      ? ""
      : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || FALLBACK[theme][name] || "#808080";
}

/** 两个 #rrggbb 按比例混（t = b 的占比）。不是 hex 的原样返回 a。 */
function mix(a: string, b: string, t: number): string {
  const hex = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : null);
  const x = hex(a);
  const y = hex(b);
  if (x === null || y === null) return a;
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const ca = (x >> shift) & 255;
    const cb = (y >> shift) & 255;
    out |= Math.round(ca + (cb - ca) * t) << shift;
  }
  return `#${out.toString(16).padStart(6, "0")}`;
}

function palette(theme: Theme): Palette {
  const tk = (n: string) => token(theme, n);
  const canvas = tk("--bg-side");
  const dark = theme === "dark";
  return {
    canvas,
    node: dark ? tk("--bg-card") : tk("--bg"),
    nodeBorder: dark ? tk("--border-strong") : tk("--border"),
    title: tk("--text"),
    body: tk("--text-dim"),
    // 连线要看得见又不抢：faint 和画布各一半
    line: mix(tk("--text-faint"), canvas, dark ? 0.55 : 0.4),
    accent: tk("--accent-dim"),
    accentBorder: tk("--accent-border"),
    accentText: tk("--accent-soft"),
    labelBorder: tk("--border"),
    // 子图是画布上再沉 / 再浮半档的一块区域，不能和卡片撞色
    cluster: mix(canvas, tk("--text"), dark ? 0.025 : 0.03),
    clusterBorder: tk("--border-strong"),
    note: tk("--warn-bg"),
    noteBorder: tk("--warn-border"),
    shadow: dark ? "rgba(0,0,0,.45)" : "rgba(0,0,0,.06)",
  };
}

/**
 * 分类色：饼图、思维导图分支、git 分支、旅程图分段、XY 图的系列。
 *
 * 不能交给 base 主题推：它从 primaryColor 转色相生成整组，节点底现在是灰的，
 * 推出来十二个全是黑 / 灰，饼图分不出块、思维导图的分支一片黑。
 *
 * 取自 dataviz 默认分类盘（蓝、橙、青、黄、品红、绿、紫、红，顺序固定不
 * 轮换），两套是同一组色相按各自底色挑的明度档。已对 --bg-side 跑过校验：
 * 相邻色在色弱模拟下 ΔE ≥ 8.4、正常视觉 ≥ 19。浅色下中间几档对底色不到
 * 3:1，这些图都带文字标签 / 图例，不靠颜色单独认。
 */
const SERIES: Record<Theme, string[]> = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
};

/**
 * 流程图 / 时序图以外的图种。实心系列色只给「小面积 + 本来就是数据」的
 * 标记（饼块、git 提交点、柱子）；大块填充（思维导图节点、旅程分段、甘特
 * 条）用系列色往画布里调淡的「色调」，字照旧用正文色 —— 满屏实心色块配
 * 白字是之前思维导图刺眼的原因。
 */
function chartVariables(theme: Theme, p: Palette): Record<string, string> {
  const dark = theme === "dark";
  const series = SERIES[theme];
  const at = (i: number) => series[i % series.length] as string;
  // 色调：深色往画布压，浅色往白里冲
  const tint = (c: string) => (dark ? mix(c, p.canvas, 0.72) : mix(c, "#ffffff", 0.84));
  const v: Record<string, string> = {};
  for (let i = 0; i < 12; i++) {
    // 思维导图 / 时间线 / 看板的分支色
    v[`cScale${i}`] = tint(at(i));
    v[`cScaleLabel${i}`] = p.title;
    v[`cScalePeer${i}`] = at(i);
    v[`cScaleInv${i}`] = at(i);
    // 饼图
    v[`pie${i + 1}`] = at(i);
  }
  for (let i = 0; i < 8; i++) {
    v[`git${i}`] = at(i);
    v[`gitInv${i}`] = at(i);
    v[`gitBranchLabel${i}`] = "#ffffff";
    v[`fillType${i}`] = tint(at(i));
  }
  const blue = at(0);
  const red = at(7);
  return {
    ...v,
    // 饼图：块之间留一道画布色的缝，标题 / 图例走正文色
    pieStrokeColor: p.canvas,
    pieStrokeWidth: "2px",
    pieOuterStrokeColor: p.canvas,
    pieOuterStrokeWidth: "0px",
    pieOpacity: "1",
    pieTitleTextColor: p.title,
    pieTitleTextSize: "14px",
    pieSectionTextColor: "#ffffff",
    pieSectionTextSize: "12px",
    pieLegendTextColor: p.body,
    pieLegendTextSize: "12px",
    // git
    commitLabelColor: p.body,
    commitLabelBackground: p.canvas,
    commitLabelFontSize: "11px",
    tagLabelColor: p.title,
    tagLabelBackground: p.node,
    tagLabelBorder: p.nodeBorder,
    // ER：表头是卡片，属性行隔行微差
    attributeBackgroundColorOdd: p.node,
    attributeBackgroundColorEven: mix(p.node, p.title, dark ? 0.035 : 0.025),
    rowOdd: p.node,
    rowEven: mix(p.node, p.title, dark ? 0.035 : 0.025),
    // 甘特：普通任务是蓝色调，进行中实一点，完成的退成中性，关键路径红
    sectionBkgColor: mix(p.canvas, p.title, 0.03),
    altSectionBkgColor: p.canvas,
    sectionBkgColor2: mix(p.canvas, p.title, 0.03),
    taskBkgColor: tint(blue),
    taskBorderColor: blue,
    taskTextColor: p.title,
    taskTextLightColor: p.title,
    taskTextDarkColor: p.title,
    taskTextOutsideColor: p.body,
    taskTextClickableColor: p.accentText,
    activeTaskBkgColor: dark ? mix(blue, p.canvas, 0.45) : mix(blue, "#ffffff", 0.6),
    activeTaskBorderColor: blue,
    doneTaskBkgColor: p.node,
    doneTaskBorderColor: p.nodeBorder,
    critBkgColor: tint(red),
    critBorderColor: red,
    gridColor: p.labelBorder,
    todayLineColor: red,
    excludeBkgColor: mix(p.canvas, p.title, 0.05),
    // 四象限：四块只差一点明度，点用强调蓝
    quadrant1Fill: mix(p.canvas, blue, dark ? 0.1 : 0.08),
    quadrant2Fill: mix(p.canvas, blue, dark ? 0.16 : 0.13),
    quadrant3Fill: mix(p.canvas, p.title, 0.02),
    quadrant4Fill: mix(p.canvas, blue, dark ? 0.06 : 0.05),
    quadrant1TextFill: p.body,
    quadrant2TextFill: p.body,
    quadrant3TextFill: p.body,
    quadrant4TextFill: p.body,
    quadrantPointFill: blue,
    quadrantPointTextFill: p.title,
    quadrantXAxisTextFill: p.body,
    quadrantYAxisTextFill: p.body,
    quadrantTitleFill: p.title,
    quadrantInternalBorderStrokeFill: p.labelBorder,
    quadrantExternalBorderStrokeFill: p.nodeBorder,
    // 类图 / 状态图里的标签底
    labelBackground: p.canvas,
    stateLabelColor: p.title,
    altBackground: p.cluster,
    compositeBackground: p.cluster,
    compositeTitleBackground: p.node,
    innerEndBackground: p.title,
    specialStateColor: p.title,
  };
}

/**
 * 思维导图按分支（section-N）着色：节点底是 cScale 的淡色调，这里补上同色
 * 的实色描边和连线，分支才认得出来；连线也收细，默认按深度从 17px 往下
 * 递减，粗得像树干。
 */
function sectionCSS(theme: Theme): string {
  const series = SERIES[theme];
  // mermaid 里 section-N 用的是 cScale(N+1)（cScale0 留给根节点 section--1），
  // 这里同样错一位，描边才和底色同色系。cScale 12 档按 8 色循环，和
  // chartVariables 的 at() 对齐。
  const rules = Array.from({ length: 12 }, (_, i) => series[(i + 1) % series.length]).map(
    (c, i) => `
      .section-${i} rect, .section-${i} path, .section-${i} circle, .section-${i} polygon { stroke: ${c} !important; stroke-width: 1px !important; }
      .section-edge-${i} { stroke: ${c} !important; opacity: .7; }`,
  );
  return `${rules.join("")}
      .mindmap-edges path { stroke-width: 2px !important; }
      .mindmap-edges .edge-depth-0, .mindmap-edges .edge-depth-1 { stroke-width: 3px !important; }`;
}

function themeConfig(theme: Theme): Record<string, unknown> {
  const p = palette(theme);
  return {
    theme: "base",
    themeVariables: {
      darkMode: theme === "dark",
      background: p.canvas,
      fontFamily: FONT_FAMILY,
      fontSize: "13px",
      primaryColor: p.node,
      primaryBorderColor: p.nodeBorder,
      primaryTextColor: p.title,
      secondaryColor: p.canvas,
      tertiaryColor: p.cluster,
      lineColor: p.line,
      textColor: p.title,
      mainBkg: p.node,
      nodeBorder: p.nodeBorder,
      nodeTextColor: p.title,
      clusterBkg: p.cluster,
      clusterBorder: p.clusterBorder,
      titleColor: p.body,
      edgeLabelBackground: p.canvas,
      actorBkg: p.node,
      actorBorder: p.nodeBorder,
      actorTextColor: p.title,
      actorLineColor: p.line,
      signalColor: p.body,
      signalTextColor: p.title,
      labelBoxBkgColor: p.node,
      labelBoxBorderColor: p.nodeBorder,
      noteBkgColor: p.note,
      noteBorderColor: p.noteBorder,
      noteTextColor: p.title,
      activationBkgColor: p.accent,
      activationBorderColor: p.accentBorder,
      sequenceNumberColor: p.canvas,
      ...chartVariables(theme, p),
      xyChart: {
        backgroundColor: "transparent",
        titleColor: p.title,
        xAxisLabelColor: p.body,
        xAxisTitleColor: p.body,
        xAxisTickColor: p.labelBorder,
        xAxisLineColor: p.labelBorder,
        yAxisLabelColor: p.body,
        yAxisTitleColor: p.body,
        yAxisTickColor: p.labelBorder,
        yAxisLineColor: p.labelBorder,
        plotColorPalette: SERIES[theme].join(", "),
      },
    },
    flowchart: {
      curve: "basis",
      padding: 16,
      nodeSpacing: 28,
      rankSpacing: 34,
      diagramPadding: 12,
      // 不自动折行（和 Claude 的渲染一致）：只在模型写的 <br/> 处换行，长行
      // 把节点撑宽。自动折行要 mermaid 量出来的断行位置和实际排版一模一样，
      // 字体 / 字号 / 行高差一点就多折一行、最后一行被框裁掉。图太宽会按列宽
      // 缩小，点开全屏看原大小。
      wrappingWidth: 2000,
      htmlLabels: true,
    },
    sequence: {
      actorMargin: 48,
      boxMargin: 8,
      noteMargin: 10,
      messageMargin: 36,
      mirrorActors: false,
      actorFontSize: 13,
      messageFontSize: 13,
      noteFontSize: 12,
    },
    // 主题变量管不到的细节。mermaid 把 themeCSS 排在它自己的样式前面，同
    // 优先级会被盖，所以要 !important。量节点尺寸时这段样式已经在 svg 里，
    // 标题行加粗变宽也会算进框里。
    //
    // 标签里的 <p> 还会吃到对话区的 .md p（上下 margin + 1.7 行高），而
    // mermaid 量尺寸时不在 .md 里 —— 不钉死的话量出来的框比实际文字矮，
    // 最后一两行被裁掉。
    //
    // 末尾的 .link：桑基图的流带默认 multiply 混合，叠在深色画布上直接黑没了。
    // （说明写在这里而不是 CSS 注释里：模板字符串里的中文会被 lint 当成写死的界面文案。）
    themeCSS: `
      p { margin: 0 !important; }
      .node rect, .node .label-container { rx: 10px; ry: 10px; }
      .node rect, .node polygon, .node circle, .node ellipse, .node path {
        stroke-width: 1px !important;
        filter: drop-shadow(0 1px 3px ${p.shadow});
      }
      .nodeLabel, .nodeLabel p { line-height: 1.6 !important; color: ${p.body} !important; font-size: 12.5px; }
      .nodeLabel p::first-line { color: ${p.title}; font-weight: 600; font-size: 13.5px; }
      .node polygon, .node circle, .node ellipse { fill: ${p.accent} !important; stroke: ${p.accentBorder} !important; }
      .node:has(polygon) .nodeLabel p, .node:has(circle) .nodeLabel p { color: ${p.accentText} !important; }
      .cluster rect { rx: 12px; ry: 12px; stroke-dasharray: 4 4; stroke-width: 1px !important; }
      .cluster-label .nodeLabel, .cluster-label p { color: ${p.body} !important; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; }
      .flowchart-link, .edgePath .path { stroke-width: 1.25px !important; }
      .marker, marker path { fill: ${p.line} !important; stroke: ${p.line} !important; }
      .edgeLabel p, .edgeLabel span { font-size: 11.5px; color: ${p.body} !important; background-color: ${p.canvas} !important; }
      .edgeLabel p { padding: 1px 7px; border: 1px solid ${p.labelBorder}; border-radius: 999px; }
      .edgeLabel rect, .labelBkg { fill: transparent !important; background-color: transparent !important; }
      rect.actor { rx: 10px; ry: 10px; }
      .note { rx: 6px; ry: 6px; }
      .link { mix-blend-mode: normal !important; }
      .link path { stroke-opacity: ${theme === "dark" ? 0.32 : 0.4} !important; }
      ${sectionCSS(theme)}
    `,
  };
}

let loaded: Promise<MermaidApi> | null = null;
/** 上次 `initialize` 用的主题。切主题后第一张要画的图负责重新 initialize。 */
let configured: Theme | null = null;
let seq = 0;

function load(): Promise<MermaidApi> {
  loaded ??= import("mermaid").then((m) => m.default as MermaidApi);
  return loaded;
}

/**
 * 让 mermaid 的全局配置对上要画的主题。`initialize` 是整体替换，所以每次都
 * 给全套（安全等级也在里面），而不是只补主题那几项。
 */
function configure(api: MermaidApi, theme: Theme) {
  if (configured === theme) return;
  configured = theme;
  api.initialize({ startOnLoad: false, securityLevel: "strict", ...themeConfig(theme) });
}

/** 读屏和放大按钮要报图的名字。从源码首个关键词猜，猜不出统一叫流程图。 */
const KIND_LABELS: [RegExp, MessageKey][] = [
  [/^(graph|flowchart)\b/, "transcript.mermaid.flowchart"],
  [/^sequenceDiagram/, "transcript.mermaid.sequence"],
  [/^classDiagram/, "transcript.mermaid.class"],
  [/^stateDiagram/, "transcript.mermaid.state"],
  [/^erDiagram/, "transcript.mermaid.er"],
  [/^gantt/, "transcript.mermaid.gantt"],
  [/^pie\b/, "transcript.mermaid.pie"],
];

function kindOf(src: string): MessageKey {
  const head = src.trimStart();
  for (const [re, key] of KIND_LABELS) {
    if (re.test(head)) return key;
  }
  return "transcript.mermaid.flowchart";
}

export function MermaidBlock({ source }: { source: string }) {
  const { t } = useT();
  const theme = useTheme();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // 首个渲染结果落地前既不显示源码也不显示空白 —— mermaid 库首次加载
  // 要一两秒，这期间闪现源码再切成图，对话流会跳一下。
  const [settled, setSettled] = useState(false);
  const [copied, flashCopied] = useTimedFlag<"idle" | "ok" | "fail">("idle", 1500);
  const [viewer, setViewer] = useState(false);

  useEffect(() => {
    const src = source.trim();
    if (!src) {
      setSvg(null);
      setFailed(false);
      return;
    }
    let alive = true;
    // 流式时每个 token 都重跑。短延迟等一小截写完再画，别每个字符都渲染。
    // 切主题也走这条路：整屏的图一起排队，180ms 后各画各的。
    const timer = window.setTimeout(() => {
      const id = `mmd-${uid}-${++seq}`;
      void load()
        .then((api) => {
          configure(api, theme);
          return api.render(id, src);
        })
        .then((out) => {
          if (!alive) return;
          setSvg(out.svg);
          setFailed(false);
          setSettled(true);
        })
        .catch(() => {
          // 只标失败、不清 svg —— 之前成功过就继续挂着上一张图
          if (!alive) return;
          setFailed(true);
          setSettled(true);
        });
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [source, uid, theme]);

  const label = t(kindOf(source));

  const copySrc = () => {
    navigator.clipboard.writeText(source).then(
      () => flashCopied("ok"),
      () => flashCopied("fail"),
    );
  };

  if (svg) {
    return (
      <div className="md-mermaid-wrap">
        {/* 图被压在对话列宽里，大图的节点文字缩成蚂蚁 —— 点开全屏看 */}
        <button
          type="button"
          className="md-mermaid-zoom"
          onClick={() => setViewer(true)}
          aria-label={t("transcript.image.zoomNamed", { name: label })}
        >
          <div
            className="md-mermaid"
            role="img"
            aria-label={label}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </button>
        {/* 渲染成图之后源码就没处看了，hover 给条复制的路 */}
        <button type="button" className="md-mermaid-copy" onClick={copySrc}>
          {copied === "ok"
            ? t("common.copied")
            : copied === "fail"
              ? t("transcript.md.copyFailed")
              : t("transcript.mermaid.copySource")}
        </button>
        {viewer ? (
          <MermaidViewer svg={svg} label={label} onClose={() => setViewer(false)} />
        ) : null}
      </div>
    );
  }

  if (!settled && source.trim()) {
    return (
      <div className="md-mermaid-loading" role="status">
        {t("transcript.mermaid.rendering")}
      </div>
    );
  }

  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">mermaid</span>
        {/* 退回源码时得说一声"这本来是张图"，不然像模型就只写了段代码 */}
        {failed ? <span className="codeblock-fail">{t("transcript.mermaid.failed")}</span> : null}
      </div>
      <pre>
        <code>{source}</code>
      </pre>
    </div>
  );
}

/**
 * 全屏图查看器。portal 到 body —— 卡片在带 overflow 的滚动容器里，
 * fixed 遮罩留在原地会被裁掉。遮罩样式复用 ShotViewer 的 .shot-viewer。
 */
function MermaidViewer({
  svg,
  label,
  onClose,
}: {
  svg: string;
  label: string;
  onClose: () => void;
}) {
  const { t } = useT();
  // Esc 走公共栈 —— 查看器开在权限卡之上时，Esc 只关查看器
  useEscLayer(onClose);

  return createPortal(
    <div
      className="shot-viewer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        className="shot-viewer-close"
        onClick={onClose}
        type="button"
        aria-label={t("common.close")}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path
            d="M2 2l8 8M10 2L2 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <div
        className="mermaid-viewer-body"
        role="img"
        aria-label={t("transcript.image.zoomed", { name: label })}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>,
    document.body,
  );
}
