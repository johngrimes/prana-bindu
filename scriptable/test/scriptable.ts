// A stand-in for the parts of the Scriptable (https://docs.scriptable.app) API that the widget uses, so the script can
// run in Node: tests drive it end to end and inspect the widget tree it builds, and preview.ts renders that tree.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export const SCRIPT_PATH = fileURLToPath(new URL("../prana-bindu-forecast.js", import.meta.url));

export type Family = "small" | "medium" | "large" | "extraLarge" | "accessoryRectangular";

export class Color {
  constructor(
    readonly hex: string,
    readonly alpha = 1,
    readonly dark?: Color,
  ) {}
  static dynamic(light: Color, dark: Color): Color {
    return new Color(light.hex, light.alpha, dark);
  }
  /** The colour shown in the given appearance. */
  in(mode: "light" | "dark"): { hex: string; alpha: number } {
    const c = mode === "dark" && this.dark ? this.dark : this;
    return { hex: c.hex.toUpperCase(), alpha: c.alpha };
  }
}

export class Font {
  constructor(
    readonly size: number,
    readonly weight: string,
    readonly rounded = false,
  ) {}
  static systemFont(n: number) { return new Font(n, "regular"); }
  static mediumSystemFont(n: number) { return new Font(n, "medium"); }
  static semiboldSystemFont(n: number) { return new Font(n, "semibold"); }
  static boldSystemFont(n: number) { return new Font(n, "bold"); }
  static mediumRoundedSystemFont(n: number) { return new Font(n, "medium", true); }
  static semiboldRoundedSystemFont(n: number) { return new Font(n, "semibold", true); }
}

export class Size {
  constructor(readonly width: number, readonly height: number) {}
}
export class Point {
  constructor(readonly x: number, readonly y: number) {}
}
export class Rect {
  constructor(readonly x: number, readonly y: number, readonly width: number, readonly height: number) {}
}

export class Path {
  readonly points: Point[] = [];
  move(p: Point) { this.points.length = 0; this.points.push(p); }
  addLine(p: Point) { this.points.push(p); }
  closeSubpath() {}
}

/** An image: either drawn with DrawContext (recorded operations) or an SF Symbol. */
export class Image {
  constructor(
    readonly size: Size,
    readonly ops: DrawOp[] = [],
    readonly symbol?: string,
  ) {}
}
export type DrawOp = { kind: "fillPath"; points: Point[]; color: Color };

export class DrawContext {
  size = new Size(0, 0);
  opaque = true;
  respectScreenScale = false;
  private fill = new Color("#000000");
  private path: Path | null = null;
  private ops: DrawOp[] = [];
  setFillColor(c: Color) { this.fill = c; }
  addPath(p: Path) { this.path = p; }
  fillPath() {
    if (this.path) this.ops.push({ kind: "fillPath", points: [...this.path.points], color: this.fill });
  }
  getImage() { return new Image(this.size, [...this.ops]); }
}

export class SFSymbol {
  private constructor(readonly name: string) {}
  static named(name: string) { return new SFSymbol(name); }
  get image() { return new Image(new Size(20, 20), [], this.name); }
}

export interface Node {
  type: "widget" | "stack" | "text" | "image" | "spacer";
}

abstract class Container implements Node {
  abstract type: "widget" | "stack";
  children: Node[] = [];
  backgroundColor?: Color;
  url?: string;
  spacing = 0;
  padding?: [number, number, number, number];
  setPadding(top: number, leading: number, bottom: number, trailing: number) {
    this.padding = [top, leading, bottom, trailing];
  }
  addStack() { return this.add(new WidgetStack()); }
  addText(text: string) { return this.add(new WidgetText(text)); }
  addImage(image: Image) { return this.add(new WidgetImage(image)); }
  addSpacer(length?: number) { return this.add(new WidgetSpacer(length ?? null)); }
  private add<T extends Node>(n: T): T {
    this.children.push(n);
    return n;
  }
}

export class ListWidget extends Container {
  type = "widget" as const;
  refreshAfterDate?: Date;
  presented: "small" | "medium" | "large" | null = null;
  async presentSmall() { this.presented = "small"; }
  async presentMedium() { this.presented = "medium"; }
  async presentLarge() { this.presented = "large"; }
}

export class WidgetStack extends Container {
  type = "stack" as const;
  layout: "horizontal" | "vertical" = "horizontal";
  align: "top" | "center" | "bottom" = "center";
  size = new Size(0, 0);
  cornerRadius = 0;
  borderWidth = 0;
  borderColor?: Color;
  backgroundImage?: Image;
  layoutHorizontally() { this.layout = "horizontal"; }
  layoutVertically() { this.layout = "vertical"; }
  topAlignContent() { this.align = "top"; }
  centerAlignContent() { this.align = "center"; }
  bottomAlignContent() { this.align = "bottom"; }
}

export class WidgetText implements Node {
  type = "text" as const;
  textColor?: Color;
  font?: Font;
  lineLimit = 0;
  minimumScaleFactor = 1;
  url?: string;
  constructor(public text: string) {}
}

export class WidgetImage implements Node {
  type = "image" as const;
  imageSize?: Size;
  tintColor?: Color;
  url?: string;
  constructor(public image: Image) {}
}

export class WidgetSpacer implements Node {
  type = "spacer" as const;
  constructor(public length: number | null) {}
}

/** What the fake network returns: a status and body, or an Error to simulate a connection failure. */
export type FetchResult = { status: number; body: string } | Error;
export type Fetch = (url: string, headers: Record<string, string>) => Promise<FetchResult>;

/** Answers an alert: the index of the chosen action (-1 = cancel) and, optionally, the text field values to enter. */
export type AlertAnswer = { action: number; fields?: string[] };
export interface ShownAlert {
  title: string;
  message: string;
  actions: string[];
  fields: { placeholder: string; text: string; secure: boolean }[];
}

export interface RunOptions {
  /** Widget size when running in a widget; omit to run in the Scriptable app. */
  family?: Family;
  fetch: Fetch;
  keychain?: Map<string, string>;
  files?: Map<string, string>;
  /** Called for each alert in order; required when running in the app. */
  answer?: (alert: ShownAlert) => AlertAnswer;
  /** Device clock for the script (defaults to the real clock). */
  now?: Date;
  /** SF Symbols this iOS version lacks: SFSymbol.named returns null for them, as on a real device. */
  missingSymbols?: string[];
}

export interface RunResult {
  /** The widget handed to Script.setWidget, or the one presented as a preview in the app. */
  widget: ListWidget | null;
  /** Every widget built, in order (the app can preview several). */
  widgets: ListWidget[];
  alerts: ShownAlert[];
  requests: { url: string; headers: Record<string, string> }[];
  keychain: Map<string, string>;
  files: Map<string, string>;
  completed: boolean;
}

export const RUN_SCRIPT_URL = "scriptable:///run/prana-bindu-forecast";
const DOCUMENTS = "/scriptable/documents";

export async function runScript(opts: RunOptions): Promise<RunResult> {
  const keychain = opts.keychain ?? new Map<string, string>();
  const files = opts.files ?? new Map<string, string>();
  const alerts: ShownAlert[] = [];
  const requests: RunResult["requests"] = [];
  const widgets: ListWidget[] = [];
  let setWidget: ListWidget | null = null;
  let completed = false;

  class TrackedListWidget extends ListWidget {
    constructor() {
      super();
      widgets.push(this);
    }
  }

  class Request {
    headers: Record<string, string> = {};
    method = "GET";
    timeoutInterval = 60;
    response: { statusCode: number } | null = null;
    constructor(readonly url: string) {}
    async loadString(): Promise<string> {
      requests.push({ url: this.url, headers: { ...this.headers } });
      const r = await opts.fetch(this.url, this.headers);
      if (r instanceof Error) throw r;
      this.response = { statusCode: r.status };
      return r.body;
    }
  }

  class Alert {
    title = "";
    message = "";
    private actions: string[] = [];
    private cancel = false;
    private fields: ShownAlert["fields"] = [];
    private values: string[] = [];
    addAction(t: string) { this.actions.push(t); }
    addDestructiveAction(t: string) { this.actions.push(t); }
    addCancelAction(t: string) { this.cancel = true; void t; }
    addTextField(placeholder = "", text = "") { this.fields.push({ placeholder, text, secure: false }); }
    addSecureTextField(placeholder = "", text = "") { this.fields.push({ placeholder, text, secure: true }); }
    textFieldValue(i: number) { return this.values[i] ?? this.fields[i]?.text ?? ""; }
    async presentAlert() { return this.present(); }
    async presentSheet() { return this.present(); }
    private present(): number {
      const shown: ShownAlert = { title: this.title, message: this.message, actions: [...this.actions], fields: this.fields.map((f) => ({ ...f })) };
      alerts.push(shown);
      if (!opts.answer) throw new Error(`Unexpected alert: ${this.title}`);
      const a = opts.answer(shown);
      if (a.action === -1 && !this.cancel) throw new Error(`Alert "${this.title}" has no cancel action`);
      if (a.action >= this.actions.length) throw new Error(`Alert "${this.title}" has no action ${a.action}`);
      this.values = a.fields ?? [];
      return a.action;
    }
  }

  const fm = {
    documentsDirectory: () => DOCUMENTS,
    joinPath: (a: string, b: string) => `${a}/${b}`,
    fileExists: (p: string) => files.has(p),
    readString: (p: string) => files.get(p) ?? null,
    writeString: (p: string, s: string) => void files.set(p, s),
    remove: (p: string) => void files.delete(p),
  };

  const RealDate = Date;
  const fixed = opts.now?.getTime();
  const FakeDate =
    fixed === undefined
      ? Date
      : (new Proxy(RealDate, {
          construct: (target, args: unknown[]) => (args.length ? new target(...(args as [string])) : new target(fixed)),
          get: (target, prop, recv) => (prop === "now" ? () => fixed : Reflect.get(target, prop, recv)),
        }) as DateConstructor);

  const context = vm.createContext({
    console,
    Intl,
    JSON,
    Math,
    Promise,
    Error,
    Date: FakeDate,
    Color,
    Font,
    Size,
    Point,
    Rect,
    Path,
    DrawContext,
    SFSymbol: { named: (name: string) => (opts.missingSymbols?.includes(name) ? null : SFSymbol.named(name)) },
    ListWidget: TrackedListWidget,
    Request,
    Alert,
    Keychain: {
      contains: (k: string) => keychain.has(k),
      get: (k: string) => {
        const v = keychain.get(k);
        if (v === undefined) throw new Error(`No keychain item ${k}`);
        return v;
      },
      set: (k: string, v: string) => void keychain.set(k, v),
      remove: (k: string) => void keychain.delete(k),
    },
    FileManager: { local: () => fm, iCloud: () => fm },
    config: {
      runsInApp: opts.family === undefined,
      runsInWidget: opts.family !== undefined,
      widgetFamily: opts.family ?? null,
    },
    args: { widgetParameter: null },
    Script: {
      name: () => "prana-bindu-forecast",
      setWidget: (w: ListWidget) => void (setWidget = w),
      complete: () => void (completed = true),
    },
    URLScheme: { forRunningScript: () => RUN_SCRIPT_URL },
  });

  // Scriptable runs a script as the body of an async function, so top-level await works.
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const run = new vm.Script(`(async () => {\n${source}\n})()`, { filename: SCRIPT_PATH, lineOffset: -1 });
  await (run.runInContext(context) as Promise<void>);

  const presented = widgets.findLast((w) => w.presented !== null) ?? null;
  return { widget: setWidget ?? presented, widgets, alerts, requests, keychain, files, completed };
}

// --- Tree queries for tests ---------------------------------------------------------------------------------------

export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  if (node instanceof Container) for (const c of node.children) walk(c, visit);
}

export function texts(node: Node): WidgetText[] {
  const out: WidgetText[] = [];
  walk(node, (n) => n instanceof WidgetText && out.push(n));
  return out;
}

export function textContent(node: Node): string[] {
  return texts(node).map((t) => t.text);
}

/** Stacks whose tap target is `url`. */
export function stacksWithUrl(node: Node, url: string): WidgetStack[] {
  const out: WidgetStack[] = [];
  walk(node, (n) => n instanceof WidgetStack && n.url === url && out.push(n));
  return out;
}

export function images(node: Node): WidgetImage[] {
  const out: WidgetImage[] = [];
  walk(node, (n) => n instanceof WidgetImage && out.push(n));
  return out;
}
