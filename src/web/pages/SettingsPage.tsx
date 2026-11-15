import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ConnectedApp, Settings } from "../../shared/schemas";
import { api } from "../api/client";
import { actions, queryClient, useLastImport, useSettingsValue, useTags } from "../api/queries";
import { Icon } from "../components/Icons";
import { Dialog } from "../components/Overlay";
import { toast, toastError } from "../components/Toasts";
import { Workspace } from "../components/Workspace";
import { browserTimeZone, formatDateTime } from "../lib/dates";
import { defaultPasskeyName, passkeyErrorMessage, registerPasskey, type ApiTokenInfo, type AuthPasskey } from "../lib/passkeys";

const DUE_SOON: Array<[number, string]> = [
  [0, "Today"],
  [86400, "24 hours"],
  [172800, "2 days"],
  [259200, "3 days"],
  [345600, "4 days"],
  [432000, "5 days"],
  [518400, "6 days"],
  [604800, "1 week"],
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Card({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4" aria-labelledby={`pb-${title}`}>
      <h2 id={`pb-${title}`} className="text-base font-semibold">
        {title}
      </h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid items-center gap-1 sm:grid-cols-[200px_1fr]">
      <span className="text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}

function GeneralSettings() {
  const settings = useSettingsValue();
  const { data: tags = [] } = useTags();
  const zones = useMemo(() => {
    const list = Intl.supportedValuesOf("timeZone");
    return list.includes(settings.timeZone) ? list : [settings.timeZone, ...list];
  }, [settings.timeZone]);
  const save = (patch: Partial<Settings>) => void actions.patchSettings(patch);
  const [confirm, setConfirm] = useState(false);

  return (
    <Card title="General">
      <Row label="Theme">
        <div className="pb-seg" role="group" aria-label="Theme">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={settings.theme === t} onClick={() => save({ theme: t })}>
              <span className="inline-flex items-center gap-1.5">
                <Icon name={t === "system" ? "inspector" : t === "light" ? "sun" : "moon"} size={15} />
                {t[0]?.toUpperCase()}
                {t.slice(1)}
              </span>
            </button>
          ))}
        </div>
      </Row>
      <Row label="Time zone">
        <div className="flex flex-col gap-1">
          <select className="pb-input" aria-label="Time zone" value={settings.timeZone} onChange={(e) => save({ timeZone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          {settings.timeZone !== browserTimeZone() && (
            <button type="button" className="self-start text-sm text-accent" onClick={() => save({ timeZone: browserTimeZone() })}>
              Use this device’s time zone ({browserTimeZone()})
            </button>
          )}
        </div>
      </Row>
      <Row label="Date format">
        <select className="pb-input" aria-label="Date format" value={settings.dateFormat} onChange={(e) => save({ dateFormat: e.target.value as Settings["dateFormat"] })}>
          {(["MM/dd/yyyy", "dd/MM/yyyy", "yyyy/MM/dd", "yyyy-MM-dd"] as const).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Start of week">
        <select className="pb-input" aria-label="Start of week" value={settings.firstWeekday} onChange={(e) => save({ firstWeekday: Number(e.target.value) })}>
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i + 1}>
              {d}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Time format">
        <div className="pb-seg" role="group" aria-label="Time format">
          <button type="button" aria-pressed={!settings.use24HourTime} onClick={() => save({ use24HourTime: false })}>
            12-hour
          </button>
          <button type="button" aria-pressed={settings.use24HourTime} onClick={() => save({ use24HourTime: true })}>
            24-hour
          </button>
        </div>
      </Row>
      <Row label="Default defer time">
        <input type="time" className="pb-input w-auto" aria-label="Default defer time" value={settings.defaultDeferTime} onChange={(e) => e.target.value && save({ defaultDeferTime: e.target.value })} />
      </Row>
      <Row label="Default due time">
        <input type="time" className="pb-input w-auto" aria-label="Default due time" value={settings.defaultDueTime} onChange={(e) => e.target.value && save({ defaultDueTime: e.target.value })} />
      </Row>
      <Row label="Default planned time">
        <input type="time" className="pb-input w-auto" aria-label="Default planned time" value={settings.defaultPlannedTime} onChange={(e) => e.target.value && save({ defaultPlannedTime: e.target.value })} />
      </Row>
      <Row label="Due soon">
        <select className="pb-input" aria-label="Due soon" value={settings.dueSoonSeconds} onChange={(e) => save({ dueSoonSeconds: Number(e.target.value) })}>
          {DUE_SOON.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Forecast tag">
        <select className="pb-input" aria-label="Forecast tag" value={settings.forecastTagId ?? ""} onChange={(e) => save({ forecastTagId: e.target.value || null })}>
          <option value="">None</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Row>
      <button type="button" className="pb-btn self-start" onClick={() => setConfirm(true)}>
        Restore Defaults
      </button>
      {confirm && (
        <Dialog
          title="Restore default settings?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <button type="button" className="pb-btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-primary"
                onClick={() => {
                  setConfirm(false);
                  void actions.resetSettings();
                }}
              >
                Restore
              </button>
            </>
          }
        >
          <p className="p-4 text-sm">Date format, week start, time format, default times, due soon, theme and forecast tag return to their defaults. The time zone is kept.</p>
        </Dialog>
      )}
    </Card>
  );
}

function Passkeys() {
  const settings = useSettingsValue();
  const { data: passkeys = [] } = useQuery({
    queryKey: ["auth", "passkeys"],
    queryFn: async () => (await api.get<{ items: AuthPasskey[] }>("/auth/passkeys")).items,
  });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(defaultPasskeyName);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmLast, setConfirmLast] = useState<AuthPasskey | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["auth", "passkeys"] });

  async function add() {
    setAdding(true);
    try {
      await registerPasskey(name.trim() || defaultPasskeyName());
      toast("Passkey added");
      void refresh();
    } catch (e) {
      toastError(new Error(passkeyErrorMessage(e)));
    } finally {
      setAdding(false);
    }
  }

  async function remove(p: AuthPasskey) {
    try {
      await api.del(`/auth/passkeys/${encodeURIComponent(p.id)}`);
      toast("Passkey deleted");
    } catch (e) {
      toastError(e);
    }
    void refresh();
  }

  return (
    <Card title="Passkeys" description="Passkeys used to sign in to prana-bindu.">
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line" aria-label="Passkeys">
        {passkeys.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 p-3" data-testid="passkey">
            <Icon name="key" size={18} className="text-muted" />
            <div className="min-w-0 flex-1">
              {renaming === p.id ? (
                <input
                  className="pb-input"
                  aria-label="Passkey name"
                  defaultValue={p.name}
                  autoFocus
                  onBlur={async (e) => {
                    setRenaming(null);
                    const value = e.target.value.trim();
                    if (value && value !== p.name) {
                      try {
                        await api.patch(`/auth/passkeys/${encodeURIComponent(p.id)}`, { name: value });
                      } catch (err) {
                        toastError(err);
                      }
                      void refresh();
                    }
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <p className="truncate font-medium">{p.name}</p>
              )}
              <p className="text-xs text-muted">
                Created {formatDateTime(p.createdAt, settings)} · {p.lastUsedAt ? `last used ${formatDateTime(p.lastUsedAt, settings)}` : "never used"}
              </p>
            </div>
            <button type="button" className="pb-icon-btn" aria-label={`Rename ${p.name}`} onClick={() => setRenaming(p.id)}>
              <Icon name="edit" size={16} />
            </button>
            <button
              type="button"
              className="pb-icon-btn hover:text-danger"
              aria-label={`Delete ${p.name}`}
              onClick={() => (passkeys.length === 1 ? setConfirmLast(p) : void remove(p))}
            >
              <Icon name="trash" size={16} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input className="pb-input max-w-xs" aria-label="New passkey name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="pb-btn" onClick={() => void add()} disabled={adding}>
          <Icon name="plus" size={16} /> {adding ? "Waiting for passkey…" : "Add passkey"}
        </button>
      </div>
      {confirmLast && (
        <Dialog
          title="Delete your last passkey?"
          onClose={() => setConfirmLast(null)}
          footer={
            <>
              <button type="button" className="pb-btn" onClick={() => setConfirmLast(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="pb-btn bg-danger text-white"
                onClick={() => {
                  const p = confirmLast;
                  setConfirmLast(null);
                  void remove(p);
                }}
              >
                Delete passkey
              </button>
            </>
          }
        >
          <p className="p-4 text-sm">
            After deleting “{confirmLast.name}” no passkey can sign in. You will need a new enrollment link from the CLI (
            <code className="rounded bg-surface-2 px-1">prana-bindu passkey enroll</code>) to sign in again.
          </p>
        </Dialog>
      )}
    </Card>
  );
}

function ApiTokens() {
  const settings = useSettingsValue();
  const { data: tokens = [] } = useQuery({
    queryKey: ["auth", "tokens"],
    queryFn: async () => (await api.get<{ items: ApiTokenInfo[] }>("/auth/tokens")).items,
  });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ token: ApiTokenInfo; plaintext: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["auth", "tokens"] });

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const result = await api.post<{ token: ApiTokenInfo; plaintext: string }>("/auth/tokens", { name: name.trim() });
      setCreated(result);
      setName("");
      void refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function revoke(t: ApiTokenInfo) {
    try {
      await api.del(`/auth/tokens/${encodeURIComponent(t.id)}`);
      toast("Token revoked");
    } catch (e) {
      toastError(e);
    }
    void refresh();
  }

  return (
    <Card title="API tokens" description="Bearer tokens for the REST API and the MCP server, for clients that cannot sign in with OAuth.">
      {tokens.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line" aria-label="API tokens">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-2 p-3" data-testid="api-token">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.name}</p>
                <p className="text-xs text-muted">
                  <code>{t.prefix}…</code> · created {formatDateTime(t.createdAt, settings)} · {t.lastUsedAt ? `last used ${formatDateTime(t.lastUsedAt, settings)}` : "never used"}
                </p>
              </div>
              <button type="button" className="pb-btn pb-btn-danger text-sm md:min-h-[36px]" onClick={() => void revoke(t)} aria-label={`Revoke ${t.name}`}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No tokens.</p>
      )}
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input className="pb-input max-w-xs" aria-label="Token name" placeholder="Token name, e.g. Claude Desktop" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="pb-btn" disabled={!name.trim()}>
          <Icon name="plus" size={16} /> Create token
        </button>
      </form>
      {created && (
        <Dialog title="Token created" onClose={() => setCreated(null)} footer={<button type="button" className="pb-btn pb-btn-primary" onClick={() => setCreated(null)}>Done</button>}>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm">Copy this token now. It will not be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg bg-surface-2 p-3 text-sm" data-testid="token-plaintext">
                {created.plaintext}
              </code>
              <button
                type="button"
                className="pb-btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created.plaintext);
                    toast("Copied");
                  } catch {
                    toast("Copy failed — select the token and copy it manually", { kind: "error" });
                  }
                }}
              >
                <Icon name="copy" size={16} /> Copy
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function ConnectedApps() {
  const settings = useSettingsValue();
  const { data: apps = [], isPending } = useQuery({
    queryKey: ["auth", "oauth", "grants"],
    queryFn: async () => (await api.get<{ items: ConnectedApp[] }>("/auth/oauth/grants")).items,
  });

  async function disconnect(app: ConnectedApp) {
    try {
      await api.del(`/auth/oauth/grants/${encodeURIComponent(app.id)}`);
      toast(`Disconnected ${app.clientName}`);
    } catch (e) {
      toastError(e);
    }
    void queryClient.invalidateQueries({ queryKey: ["auth", "oauth", "grants"] });
  }

  return (
    <Card title="Connected apps" description="Apps you approved to use the MCP server by signing in with OAuth. Disconnecting one revokes its access immediately.">
      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : apps.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-xl border border-line" aria-label="Connected apps">
          {apps.map((app) => (
            <li key={app.id} className="flex items-center gap-2 p-3" data-testid="connected-app">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{app.clientName}</p>
                <p className="text-xs text-muted">
                  connected {formatDateTime(app.createdAt, settings)} · {app.lastUsedAt ? `last used ${formatDateTime(app.lastUsedAt, settings)}` : "never used"}
                </p>
              </div>
              <button type="button" className="pb-btn pb-btn-danger text-sm md:min-h-[36px]" onClick={() => void disconnect(app)} aria-label={`Disconnect ${app.clientName}`}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          No apps connected. Add <code className="rounded bg-surface-2 px-1">{window.location.origin}/mcp</code> as a connector in Claude or another MCP client to connect one.
        </p>
      )}
    </Card>
  );
}

function ImportPanel() {
  const settings = useSettingsValue();
  const { data: run, isPending } = useLastImport();
  return (
    <Card title="Import" description="Imports replace all data and run from the CLI or the API (prana-bindu import <path|url>).">
      {isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !run ? (
        <p className="text-sm text-muted">No import has been run.</p>
      ) : (
        <div className="flex flex-col gap-2 text-sm" data-testid="import-run">
          <p>
            <span className="text-muted">Last import:</span> {formatDateTime(run.importedAt, settings)}
          </p>
          <p className="break-all">
            <span className="text-muted">Source:</span> {run.source}
          </p>
          {run.appVersion && (
            <p>
              <span className="text-muted">OmniFocus version:</span> {run.appVersion}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {Object.entries(run.counts).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2 rounded-md bg-surface-2 px-2 py-1">
                <dt className="text-muted">{k}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {run.warnings.length > 0 && (
            <details>
              <summary className="cursor-pointer text-warn">{run.warnings.length} warnings</summary>
              <ul className="pb-scroll mt-1 max-h-48 list-disc pl-5 text-xs text-muted">
                {run.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

export function SettingsPage() {
  return (
    <Workspace title="Settings" icon="gear" inspector={false} canCleanUp={false} canCreate={false} canReorder={false}>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-24">
        <GeneralSettings />
        <Passkeys />
        <ApiTokens />
        <ConnectedApps />
        <ImportPanel />
      </div>
    </Workspace>
  );
}
