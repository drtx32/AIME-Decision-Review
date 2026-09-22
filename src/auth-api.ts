/**
 * Frontend API adapter for auth + admin user management + settings.
 *
 * All requests use credentials so the HttpOnly session cookie flows
 * naturally through the browser. Errors carry the parsed JSON body when
 * available so callers can distinguish invalid_credentials from
 * account_disabled, etc.
 */

const apiBase =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";

export type Role = "admin" | "user";

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  enabled: boolean;
  createdAt: string;
}

export interface AuthResponse {
  user: PublicUser;
  mustChangePassword: boolean;
}

export interface AdminCreateResponse {
  user: PublicUser;
  temporaryPassword: string;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  body?: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
    if (body && typeof body === "object" && "error" in body) {
      this.code = String((body as { error: unknown }).error);
    }
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  allowStatuses: number[] = [200, 201]
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok && !allowStatuses.includes(res.status)) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}

export const auth = {
  async me(): Promise<AuthResponse | null> {
    try {
      return await request<AuthResponse>("/auth/me");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
  async login(username: string, password: string): Promise<AuthResponse> {
    return await request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },
  async logout(): Promise<void> {
    await request<{ ok: boolean }>("/auth/logout", { method: "POST" });
  },
  async changePassword(currentPassword: string, newPassword: string): Promise<AuthResponse> {
    return await request<AuthResponse>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  },
};

export const adminUsers = {
  async list(): Promise<{ users: PublicUser[] }> {
    return await request<{ users: PublicUser[] }>("/admin/users");
  },
  async create(username: string): Promise<AdminCreateResponse> {
    return await request<AdminCreateResponse>("/admin/users", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
  },
  async resetPassword(userId: string): Promise<AdminCreateResponse> {
    return await request<AdminCreateResponse>(
      `/admin/users/${encodeURIComponent(userId)}/reset-password`,
      { method: "POST" }
    );
  },
  async disable(userId: string): Promise<{ user: PublicUser }> {
    return await request<{ user: PublicUser }>(
      `/admin/users/${encodeURIComponent(userId)}/disable`,
      { method: "POST" }
    );
  },
  async enable(userId: string): Promise<{ user: PublicUser }> {
    return await request<{ user: PublicUser }>(
      `/admin/users/${encodeURIComponent(userId)}/enable`,
      { method: "POST" }
    );
  },
};

export interface QuotaSnapshot {
  userId: string;
  usageDate: string;
  used: number;
  remaining: number;
  quota: number;
  disabled: boolean;
}

export interface ModelProviderInfo {
  id: string;
  modelName: string;
  configured: boolean;
  baseHost: string | null;
}

export interface AggregateUserUsage {
  userId: string;
  username: string;
  role: "admin" | "user";
  usedToday: number;
  quota: number;
}

export interface ModelSettings {
  provider: ModelProviderInfo;
  quota: { configured: number; source: string; note: string };
  usage: { self: QuotaSnapshot; aggregate: AggregateUserUsage[] };
}

export const settings = {
  async quota(): Promise<{ quota: QuotaSnapshot }> {
    return await request<{ quota: QuotaSnapshot }>("/settings/quota");
  },
  async model(): Promise<ModelSettings> {
    return await request<ModelSettings>("/settings/model");
  },
};