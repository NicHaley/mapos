import { search } from "./search";

export const tavilyAdapter = {
  id: "tavily" as const,
  webSearch: { search }
};
