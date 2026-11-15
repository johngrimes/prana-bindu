// Renders a widget tree built by the mock Scriptable runtime as HTML, approximating WidgetKit's stack layout with
// flexbox: horizontal stacks centre their content vertically, vertical stacks align it to the leading edge, flexible
// spacers grow, and stacks containing one grow along that axis (several such siblings share the space equally).
import { ListWidget, WidgetImage, WidgetSpacer, WidgetStack, WidgetText, type Color, type Image, type Node } from "./scriptable.js";

export type Mode = "light" | "dark";

/** Widget sizes on a 6.1" iPhone (points). */
export const WIDGET_SIZES = { medium: { width: 338, height: 158 }, large: { width: 338, height: 354 } } as const;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function css(c: Color | undefined, mode: Mode): string | undefined {
  if (!c) return undefined;
  const { hex, alpha } = c.in(mode);
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

type Axis = "horizontal" | "vertical";

function grows(node: Node, axis: Axis): boolean {
  if (!(node instanceof WidgetStack)) return false;
  if ((axis === "horizontal" ? node.size.width : node.size.height) > 0) return false;
  return node.children.some((c) => (c instanceof WidgetSpacer ? node.layout === axis && c.length === null : grows(c, axis)));
}

function symbolSvg(name: string, size: number, color: string): string {
  const r = size / 2 - 1.5;
  const c = size / 2;
  const ring = (extra: string) => `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="1.6" ${extra}/>`;
  const body =
    name === "circle.dashed"
      ? ring(`stroke-dasharray="${(Math.PI * r) / 6} ${(Math.PI * r) / 12}"`)
      : name === "circle.dotted"
        ? ring(`stroke-linecap="round" stroke-dasharray="0 ${(Math.PI * r) / 6}"`)
        : name === "plus"
          ? `<path d="M${c} 1V${size - 1}M1 ${c}H${size - 1}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`
          : `<rect width="${size}" height="${size}" fill="none" stroke="${color}"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
}

function drawnSvg(image: Image, mode: Mode, style = ""): string {
  const { width, height } = image.size;
  const shapes = image.ops
    .map((op) => `<polygon points="${op.points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="${css(op.color, mode)}"/>`)
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="${style}">${shapes}</svg>`;
}

function render(node: Node, parentAxis: Axis, mode: Mode): string {
  const self: string[] = [];
  if (grows(node, parentAxis)) self.push("flex: 1 1 0");
  if (grows(node, parentAxis === "horizontal" ? "vertical" : "horizontal")) self.push("align-self: stretch");

  if (node instanceof WidgetSpacer) {
    return `<div style="${node.length === null ? "flex: 1 1 0" : `flex: 0 0 ${node.length}px`}"></div>`;
  }
  if (node instanceof WidgetText) {
    const f = node.font;
    const family = f?.rounded ? "'SF Pro Rounded', ui-rounded, system-ui" : "-apple-system, 'SF Pro Text', system-ui";
    const weight = { regular: 400, medium: 500, semibold: 600, bold: 700 }[f?.weight ?? "regular"];
    const style = [
      `font: ${weight} ${f?.size ?? 17}px/1.2 ${family}`,
      `color: ${css(node.textColor, mode) ?? (mode === "dark" ? "#fff" : "#000")}`,
      "min-width: 0",
      node.lineLimit === 1 ? "white-space: nowrap; overflow: hidden; text-overflow: ellipsis" : "",
      // Text that may scale down keeps its width here; siblings truncate instead (an approximation).
      node.minimumScaleFactor < 1 ? "flex-shrink: 0" : "",
    ];
    return `<span style="${style.join("; ")}">${esc(node.text)}</span>`;
  }
  if (node instanceof WidgetImage) {
    const size = node.imageSize?.width ?? node.image.size.width;
    const color = css(node.tintColor, mode) ?? "currentColor";
    if (node.image.symbol) return `<span style="display: flex; flex: none">${symbolSvg(node.image.symbol, size, color)}</span>`;
    return drawnSvg(node.image, mode, `width: ${size}px; height: ${size}px`);
  }
  if (node instanceof WidgetStack) {
    const align = node.layout === "vertical" ? "flex-start" : { top: "flex-start", center: "center", bottom: "flex-end" }[node.align];
    const style = [
      ...self,
      "display: flex",
      "position: relative",
      "flex-shrink: 1",
      // Only stacks that grow may be squeezed below their content's width.
      grows(node, "horizontal") ? "min-width: 0" : "",
      `flex-direction: ${node.layout === "horizontal" ? "row" : "column"}`,
      `align-items: ${align}`,
      `gap: ${node.spacing}px`,
      node.padding ? `padding: ${node.padding[0]}px ${node.padding[3]}px ${node.padding[2]}px ${node.padding[1]}px` : "",
      node.size.width ? `width: ${node.size.width}px; flex: none` : "",
      node.size.height ? `height: ${node.size.height}px` : "",
      node.backgroundColor ? `background: ${css(node.backgroundColor, mode)}` : "",
      node.cornerRadius ? `border-radius: ${node.cornerRadius}px` : "",
      node.borderWidth ? `box-shadow: inset 0 0 0 ${node.borderWidth}px ${css(node.borderColor, mode)}` : "",
    ];
    const bg = node.backgroundImage ? drawnSvg(node.backgroundImage, mode, "position: absolute; inset: 0; width: 100%; height: 100%") : "";
    const children = node.children.map((c) => render(c, node.layout, mode)).join("");
    return `<div style="${style.filter(Boolean).join("; ")}">${bg}${children}</div>`;
  }
  throw new Error(`Unknown node ${node.type}`);
}

/** A complete HTML page showing the widget at its home-screen size. */
export function renderHtml(widget: ListWidget, family: keyof typeof WIDGET_SIZES, mode: Mode): string {
  const { width, height } = WIDGET_SIZES[family];
  const [t, l, b, r] = widget.padding ?? [16, 16, 16, 16];
  const children = widget.children.map((c) => render(c, "vertical", mode)).join("");
  const page = mode === "dark" ? "#4a4038" : "#c9c2bb";
  return `<!doctype html><meta charset="utf-8"><body style="margin: 0; padding: 24px; background: ${page}; display: inline-block">
<div id="widget" style="box-sizing: border-box; width: ${width}px; height: ${height}px; padding: ${t}px ${r}px ${b}px ${l}px;
  border-radius: 22px; overflow: hidden; background: ${css(widget.backgroundColor, mode)}; display: flex; flex-direction: column;
  justify-content: center; align-items: flex-start">${children}</div></body>`;
}
