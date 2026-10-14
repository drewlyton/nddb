/** A single entry in the action log. */
export type PutAction = {
  readonly type: "put";
  readonly id: string;
  readonly value: Record<string, unknown>;
};

export type PatchAction = {
  readonly type: "patch";
  readonly id: string;
  readonly patch: Record<string, unknown>;
};

export type Action = PutAction | PatchAction;
