export function isSecretStorageOnlyMessage(value, storedSecrets) {
  if (!storedSecrets.length) return false;
  let remaining = value;
  for (const secret of storedSecrets) {
    remaining = remaining
      .split(`[保存済み: ${secret.label}]`).join("")
      .split(secret.label).join("")
      .split(secret.label.replace(" APIキー", "")).join("");
  }
  remaining = remaining
    .split("[保存済み: APIキー]").join("")
    .replace(/[A-Za-z]+ APIキー|APIキー|apiキー|キー|トークン|token|secret|access_token/gi, "")
    .replace(/今後|次回|前回|今回|保存|使える|使う|使い|使って|これ|この|よう|して|ください|お願いします|ます|です|できました/g, "")
    .replace(/[はがをにのでと、。,.!！?？:：=「」『』()（）\s]/g, "");
  return remaining.length === 0;
}

export function resolveCreateMessageCommand(value, storedSecrets, commandTitle) {
  return isSecretStorageOnlyMessage(value, storedSecrets) ? "" : commandTitle;
}
