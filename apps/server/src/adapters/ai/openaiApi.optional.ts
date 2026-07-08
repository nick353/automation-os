export type OpenAiApiOptionalAdapter = {
  adapter: "openai_api_optional";
  primary: false;
  docsOnly: true;
  notes: string[];
};

export function openAiApiOptionalAdapter(): OpenAiApiOptionalAdapter {
  return {
    adapter: "openai_api_optional",
    primary: false,
    docsOnly: true,
    notes: [
      "Optional adapter for future hosted workers or batch research.",
      "MVP must not require OPENAI_API_KEY to install, test, import, or run demos.",
      "Any use must be explicit per worker config."
    ]
  };
}
