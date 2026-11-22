export async function readSession(): Promise<{ url: string; token: string } | undefined> { return undefined; }
export async function saveSession(_session: { url: string; token: string }): Promise<void> {}
export async function clearSession(): Promise<void> {}
