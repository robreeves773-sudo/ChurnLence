import * as SecureStore from 'expo-secure-store';

// The Anthropic API key is stored ONLY here, in the Android Keystore-backed
// secure store. It is never written to SQLite, logs, or exports, and is only
// ever sent to api.anthropic.com.

const API_KEY = 'anthropic_api_key';

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(API_KEY);
}

export async function setApiKey(key: string): Promise<void> {
  await SecureStore.setItemAsync(API_KEY, key.trim(), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
  });
}

export async function deleteApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(API_KEY);
}

export async function hasApiKey(): Promise<boolean> {
  const key = await getApiKey();
  return !!key && key.length > 0;
}

// Basic shape check for an Anthropic key (sk-ant-...). Not a guarantee of
// validity — just catches obvious paste mistakes before we store it.
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(key.trim());
}

// Show only the last 4 characters in the UI.
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return '••••';
  return `sk-ant-…${trimmed.slice(-4)}`;
}
