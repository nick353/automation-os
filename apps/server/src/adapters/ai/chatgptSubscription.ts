export type ChatGptSubscriptionAdapter = {
  adapter: "chatgpt_subscription";
  primary: true;
  route: "manual_or_app_assisted";
  constraints: string[];
};

export function chatGptSubscriptionAdapter(): ChatGptSubscriptionAdapter {
  return {
    adapter: "chatgpt_subscription",
    primary: true,
    route: "manual_or_app_assisted",
    constraints: [
      "Treat subscription-backed ChatGPT as an operator lane, not an API-key dependency.",
      "Persist task plan, approvals, and proof receipts locally so the worker can resume.",
      "Keep server/worker protocol separate for future VPS server migration."
    ]
  };
}
