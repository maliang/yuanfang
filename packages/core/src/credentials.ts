import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type CredentialMap = Record<string, Credential>;

async function readCredentialFile(file: string): Promise<CredentialMap> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as CredentialMap;
  } catch {
    return {};
  }
}

async function writeCredentialFile(file: string, credentials: CredentialMap): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * A CredentialStore that reads Pi's existing `~/.pi/agent/auth.json` and persists any
 * refresh/login into Yuanfang's own auth file. This lets Yuanfang reuse the provider the
 * user already signed into Pi without ever mutating Pi's credentials.
 */
export class LayeredFileCredentialStore implements CredentialStore {
  readonly #ownFile: string;
  readonly #fallbackFile: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ownFile: string, fallbackFile: string) {
    this.#ownFile = ownFile;
    this.#fallbackFile = fallbackFile;
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    const own = await readCredentialFile(this.#ownFile);
    if (own[providerId] !== undefined) return own[providerId];
    const fallback = await readCredentialFile(this.#fallbackFile);
    return fallback[providerId];
  }

  async origin(providerId: string): Promise<"yuanfang" | "pi" | "none"> {
    const own = await readCredentialFile(this.#ownFile);
    if (own[providerId] !== undefined) return "yuanfang";
    const fallback = await readCredentialFile(this.#fallbackFile);
    return fallback[providerId] === undefined ? "none" : "pi";
  }

  async importPiCredentials(): Promise<number> {
    const own = await readCredentialFile(this.#ownFile);
    const fallback = await readCredentialFile(this.#fallbackFile);
    let imported = 0;
    for (const [providerId, credential] of Object.entries(fallback)) {
      if (own[providerId] !== undefined) continue;
      own[providerId] = credential;
      imported += 1;
    }
    if (imported > 0) await writeCredentialFile(this.#ownFile, own);
    return imported;
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const merged = { ...(await readCredentialFile(this.#fallbackFile)), ...(await readCredentialFile(this.#ownFile)) };
    return Object.entries(merged).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const run = async (): Promise<Credential | undefined> => {
      const own = await readCredentialFile(this.#ownFile);
      const fallback = await readCredentialFile(this.#fallbackFile);
      const current = own[providerId] ?? fallback[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      own[providerId] = next;
      await writeCredentialFile(this.#ownFile, own);
      return next;
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    const run = async (): Promise<void> => {
      const own = await readCredentialFile(this.#ownFile);
      if (own[providerId] !== undefined) {
        delete own[providerId];
        await writeCredentialFile(this.#ownFile, own);
      }
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
