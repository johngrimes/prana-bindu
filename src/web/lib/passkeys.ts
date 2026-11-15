import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { api } from "../api/client";

export interface AuthPasskey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string | null;
  backedUp: boolean;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Usernameless passkey sign-in (discoverable credential). */
export async function signInWithPasskey(): Promise<void> {
  const optionsJSON = await api.post<PublicKeyCredentialRequestOptionsJSON>("/auth/login/options", {}, { allowUnauthorized: true });
  const response = await startAuthentication({ optionsJSON });
  await api.post("/auth/login/verify", response, { allowUnauthorized: true });
}

/** Registers a new passkey, either with an enrollment token (signed out) or for the signed-in user. */
export async function registerPasskey(name: string, token?: string): Promise<AuthPasskey> {
  const optionsJSON = await api.post<PublicKeyCredentialCreationOptionsJSON>(
    "/auth/enroll/options",
    token ? { token } : {},
    { allowUnauthorized: !!token },
  );
  const response = await startRegistration({ optionsJSON });
  return api.post<AuthPasskey>("/auth/enroll/verify", { token, name, response }, { allowUnauthorized: !!token });
}

/** Human-readable message for WebAuthn ceremony failures. */
export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof WebAuthnError) {
    if (error.code === "ERROR_CEREMONY_ABORTED") return "The passkey request was cancelled.";
    return error.message;
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") return "The passkey request was cancelled or timed out.";
  return error instanceof Error ? error.message : String(error);
}

export function defaultPasskeyName(): string {
  const ua = navigator.userAgent;
  const platform = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${platform}`;
}
