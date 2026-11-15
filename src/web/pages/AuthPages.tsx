import { useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { OAuthAuthorizationRequestInfo } from "../../shared/schemas";
import { ApiError, api } from "../api/client";
import { Icon, Logo } from "../components/Icons";
import { defaultPasskeyName, passkeyErrorMessage, registerPasskey, signInWithPasskey } from "../lib/passkeys";
import { queryClient } from "../api/queries";

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-bg px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={56} />
          <p className="text-sm font-semibold tracking-wide text-muted">prana-bindu</p>
          <h1 className="text-2xl font-semibold break-words">{title}</h1>
          <p className="text-sm text-muted">{subtitle}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5 shadow-sm">{children}</div>
      </div>
    </main>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = browserSupportsWebAuthn();
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      queryClient.clear();
      navigate(from === "/login" ? "/" : from, { replace: true });
    } catch (e) {
      setError(passkeyErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="Use the passkey saved on this device.">
      {!supported && <p className="mb-4 text-sm text-danger">This browser does not support passkeys.</p>}
      <button type="button" className="pb-btn pb-btn-primary w-full min-h-[48px] text-base" onClick={signIn} disabled={busy || !supported}>
        <Icon name="key" />
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </button>
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}
      <p className="mt-5 text-xs leading-relaxed text-muted">
        No passkey yet? Run <code className="rounded bg-surface-2 px-1">prana-bindu passkey enroll</code> on the server and open the link it prints.
      </p>
    </AuthCard>
  );
}

export function EnrollPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const token = location.hash.replace(/^#/, "");
  const [name, setName] = useState(defaultPasskeyName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enroll(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(name.trim() || defaultPasskeyName(), token);
      queryClient.clear();
      navigate("/", { replace: true });
    } catch (err) {
      setError(passkeyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthCard title="Enrollment link required" subtitle="This page needs the link printed by the CLI.">
        <p className="text-sm text-muted">
          Run <code className="rounded bg-surface-2 px-1">prana-bindu passkey enroll</code> and open the printed URL within 15 minutes.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Create a passkey" subtitle="Register this device to sign in to prana-bindu.">
      <form onSubmit={enroll} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="pb-label">Passkey name</span>
          <input className="pb-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        </label>
        <button type="submit" className="pb-btn pb-btn-primary min-h-[48px] text-base" disabled={busy}>
          <Icon name="key" />
          {busy ? "Waiting for passkey…" : "Create passkey"}
        </button>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </AuthCard>
  );
}

const REQUEST_GONE = "This request has expired or was already used. Return to the app and connect again.";

/**
 * OAuth consent (`/authorize?request=<id>`), where `/oauth/authorize` sends the browser when an MCP client such as
 * Claude asks for access. Signed-out visitors sign in first and come back here. Either decision returns the browser
 * to the app.
 */
export function AuthorizePage() {
  const [params] = useSearchParams();
  const id = params.get("request") ?? "";
  const [deciding, setDeciding] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useQuery({
    queryKey: ["oauth-request", id],
    queryFn: () => api.get<OAuthAuthorizationRequestInfo>(`/auth/oauth/requests/${encodeURIComponent(id)}`),
    enabled: id !== "",
    retry: false,
    staleTime: Infinity,
  });
  const gone = id === "" || (request.error instanceof ApiError && request.error.status === 404);

  async function decide(decision: "approve" | "deny") {
    setDeciding(decision);
    setError(null);
    try {
      const { redirectTo } = await api.post<{ redirectTo: string }>(`/auth/oauth/requests/${encodeURIComponent(id)}/${decision}`);
      // Buttons stay disabled while the browser leaves.
      window.location.assign(redirectTo);
    } catch (e) {
      setDeciding(null);
      setError(e instanceof ApiError && e.status === 404 ? REQUEST_GONE : e instanceof Error ? e.message : String(e));
    }
  }

  if (gone) {
    return (
      <AuthCard title="Request expired" subtitle="This connection request can no longer be used.">
        <p role="alert" className="text-sm text-muted">
          {REQUEST_GONE}
        </p>
      </AuthCard>
    );
  }
  if (request.isError) {
    return (
      <AuthCard title="Something went wrong" subtitle="The connection request could not be loaded.">
        <p role="alert" className="mb-4 text-sm text-danger">
          {request.error.message}
        </p>
        <button type="button" className="pb-btn w-full min-h-[48px]" onClick={() => void request.refetch()}>
          Try again
        </button>
      </AuthCard>
    );
  }
  if (!request.data) {
    return (
      <AuthCard title="Connect an app" subtitle="Loading the request…">
        <p className="text-sm text-muted" aria-busy="true">
          Loading…
        </p>
      </AuthCard>
    );
  }

  const { clientName, redirectHost } = request.data;
  return (
    <AuthCard title={`Allow ${clientName} to access prana-bindu?`} subtitle={`After you decide, you return to ${redirectHost}.`}>
      <div className="flex flex-col gap-3 text-sm">
        <p>
          If you allow it, <strong className="break-words">{clientName}</strong> can use the MCP server to read, create, change and delete all
          your tasks, projects, folders, tags, perspectives and attachments.
        </p>
        <p className="text-xs leading-relaxed text-muted">
          The app chose this name itself. Only allow apps you trust. You can disconnect it at any time in Settings.
        </p>
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div className="mt-1 flex flex-col-reverse gap-2 sm:flex-row">
          <button type="button" className="pb-btn min-h-[48px] flex-1" onClick={() => void decide("deny")} disabled={deciding !== null}>
            <Icon name="close" />
            {deciding === "deny" ? "Returning…" : "Deny"}
          </button>
          <button type="button" className="pb-btn pb-btn-primary min-h-[48px] flex-1" onClick={() => void decide("approve")} disabled={deciding !== null}>
            <Icon name="check" />
            {deciding === "approve" ? "Connecting…" : "Allow"}
          </button>
        </div>
      </div>
    </AuthCard>
  );
}
