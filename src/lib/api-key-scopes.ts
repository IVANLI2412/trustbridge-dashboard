export const API_KEY_SCOPE_VALUES = ["export:read", "cron:trigger"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPE_VALUES)[number];

export const API_KEY_SCOPE_DEFINITIONS: Record<
    ApiKeyScope,
    { bit: number; mask: number; description: string }
> = {
    "export:read": {
        bit: 0,
        mask: 1 << 0,
        description: "Read contributor export endpoints; does not allow writes.",
    },
    "cron:trigger": {
        bit: 1,
        mask: 1 << 1,
        description:
            "Trigger scheduled cron export/digest runs; does not grant maintainer session rights.",
    },
};

export const API_KEY_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPE_VALUES];

export const API_KEY_ALL_SCOPES_MASK = Object.values(
    API_KEY_SCOPE_DEFINITIONS
).reduce((mask, definition) => mask | definition.mask, 0);

/**
 * Least-privilege matrix for export/CSV/JSON routes.
 *
 * Export endpoints must require an explicit scope per verb. Read-only keys
 * (`export:read`) may only perform `GET`; any mutating verb (restore, ban,
 * delete, etc.) requires `cron:trigger` and is never implied by `export:read`.
 * Unknown routes/verbs grant nothing so new endpoints fail closed.
 */
export type ApiKeyHttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export const EXPORT_ROUTE_SCOPE_MATRIX: Record<
    string,
    Partial<Record<ApiKeyHttpVerb, ApiKeyScope>>
> = {
    "/api/contributors/export": {
        GET: "export:read",
    },
    "/api/contributors/export/restore": {
        POST: "cron:trigger",
    },
    "/api/contributors/export/ban": {
        POST: "cron:trigger",
        DELETE: "cron:trigger",
    },
};

/**
 * Resolve the scope required for a route+verb pair. Returns `null` when the
 * pair is not explicitly granted, so callers must deny by default.
 */
export function requiredScopeForExportRoute(
    route: string,
    verb: string
): ApiKeyScope | null {
    const normalizedVerb = verb.toUpperCase() as ApiKeyHttpVerb;
    const routeScopes = EXPORT_ROUTE_SCOPE_MATRIX[route];
    if (!routeScopes) return null;
    return routeScopes[normalizedVerb] ?? null;
}

/**
 * Authorize an export route+verb against a key's scopes. Fails closed: an
 * unknown route/verb or a key lacking the explicit scope is denied.
 */
export function canAccessExportRoute(
    scopes: readonly string[],
    route: string,
    verb: string
): boolean {
    const required = requiredScopeForExportRoute(route, verb);
    if (!required) return false;
    return hasApiKeyScope(scopes, required);
}

/** Convert named scopes to their canonical bitmask; unknown names grant nothing. */
export function apiKeyScopesToBitmask(scopes: readonly string[]): number {
    return scopes.reduce((mask, scope) => {
        if (scope === "*") return API_KEY_ALL_SCOPES_MASK;
        const definition = API_KEY_SCOPE_DEFINITIONS[scope as ApiKeyScope];
        return definition ? mask | definition.mask : mask;
    }, 0);
}

export function hasApiKeyScope(
    scopes: readonly string[],
    required: ApiKeyScope
): boolean {
    return (
        (apiKeyScopesToBitmask(scopes) & API_KEY_SCOPE_DEFINITIONS[required].mask) !==
        0
    );
}