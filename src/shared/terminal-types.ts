export type TerminalEvent =
  | {
      type: "data";
      data: string;
    }
  | {
      type: "clear";
    };
