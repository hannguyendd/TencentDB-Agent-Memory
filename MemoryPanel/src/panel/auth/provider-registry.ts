import type { AuthProvider, HeaderInjectedProvider, ProviderKind, RedirectOAuth2Provider } from './types.js';

export class AuthProviderRegistry {
  private readonly providers = new Map<string, AuthProvider>();

  register(provider: AuthProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`duplicate auth provider: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): AuthProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): AuthProvider[] {
    return [...this.providers.values()];
  }

  /**
   * Filter providers by capability kind.
   *
   * Used by the ingress middleware (`header-injected` kinds are matched by header name) and the callback route
   * (`redirect-oauth2` kinds locate the provider via state).
   */
  listByKind(kind: 'header-injected'): HeaderInjectedProvider[];
  listByKind(kind: 'redirect-oauth2'): RedirectOAuth2Provider[];
  listByKind(kind: ProviderKind): AuthProvider[] {
    return this.list().filter((p) => p.kind === kind);
  }
}

