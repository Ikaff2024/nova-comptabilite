// Session : jeton JWT émis par l'API, stocké en localStorage.

const TOKEN_KEY = 'nova.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// Guide d'accueil : n'apparaît qu'une fois (rejouable via le bouton d'aide).
const WELCOME_KEY = 'nova.welcomed';
export function isWelcomed(): boolean { return localStorage.getItem(WELCOME_KEY) === '1'; }
export function setWelcomed(): void { localStorage.setItem(WELCOME_KEY, '1'); }
