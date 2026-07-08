export type StoredSecretSummary = {
  id?: string;
  kind?: string;
  label: string;
  maskedValue?: string;
  updatedAt?: string;
};

export function isSecretStorageOnlyMessage(value: string, storedSecrets: StoredSecretSummary[]): boolean;
export function resolveCreateMessageCommand(value: string, storedSecrets: StoredSecretSummary[], commandTitle: string): string;
